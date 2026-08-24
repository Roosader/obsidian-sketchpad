import type { Point } from '../utilities/types';

interface Sample {
	x: number;
	y: number;
	time: number;
}

const MAX_SAMPLES = 6;
const PREDICTION_STEPS = 3;

export interface PredictionConfig {
	predictionMs: number;
	minVelocity: number; // (px/ms) below this value, prediction is suppressed.
}

// Minimum confidence for straight-line strokes
const CONFIDENCE_FLOOR_STRAIGHT = 0.15;
// Minimum confidence floor at sharp corners (cornerDamp ≈ 0).
const CONFIDENCE_FLOOR_CORNER = 0.02;

// Instant-stop detection
const STOP_SPEED_RATIO = 0.25;
const STOP_CAP_MULTIPLIER = 1.5;

// Direction consistency.
// Turns smaller than this are considered normal pen curvature.
const TURN_START = 0.08;

// Turns larger than this are increasingly treated as corners.
const TURN_FULL = 1.05;

// Sharp-corner prediction floor.
const CORNER_DAMP_FLOOR = 0.08;

// Deceleration prediction floor.
const DECEL_DAMP_FLOOR = 0.20;

// How strongly negative acceleration along the travel direction reduces
// prediction.
const DECEL_K = 3.0;

// Speed stability sensitivity.
const SPEED_STABILITY_K = 1.25;

// Curvature suppression at low confidence.
const MIN_CURVE_CONFIDENCE = 0.15;

// Maximum useful angular velocity in radians/ms.
// This prevents noisy samples from producing absurd spiraling predictions.
const MAX_TURN_RATE = 0.03;

// Maximum curvature angle allowed over the complete prediction window.
const MAX_TOTAL_TURN = Math.PI * 0.45;

// Perpendicular displacement (px) for jitter suppresion
const NOISE_FLOOR_PX = 2.0;
// Width of the soft gate between fully suppressed and fully allowed.
const NOISE_GATE_WIDTH_PX = 1.0;

// Speed-dependent curvature suppression
const SPEED_CURVATURE_K = 0.3;

// Hard cap on the lateral (perpendicular-to-velocity) offset per predicted point
const MAX_HOOK_PX = 3;
export class PointerPredictor {
	private readonly samples: Sample[] = [];

	private lastPressure: number | undefined;

	private config: PredictionConfig;

	private estimatedIntervalMs = 16;

	constructor(config?: PredictionConfig) {
		this.config = { predictionMs: 25, minVelocity: 0.5, ...config };
	}

	setConfig(config: PredictionConfig): void {
		this.config = { ...this.config, ...config };
	}

	addSample(point: Point, time: number): void {
		if (this.samples.length > 0) {
			const previous = this.samples[this.samples.length - 1]!;
			const interval = time - previous.time;
			if (interval > 0 && interval < 200) {
				this.estimatedIntervalMs = this.estimatedIntervalMs * 0.7 + interval * 0.3;
			}
		}

		this.samples.push({ x: point.x, y: point.y, time });

		if (this.samples.length > MAX_SAMPLES) {
			this.samples.shift();
		}

		this.lastPressure = point.pressure;
	}

	predict(): Point[] {
		if (this.samples.length < 2) {
			return [];
		}

		const newest = this.samples[this.samples.length - 1]!;

		// ESTIMATE VELOCITY
		// Newer samples are exponentially more important than older samples
		const decay = Math.max(8, this.estimatedIntervalMs * 0.5);

		let sumW = 0;
		let sumWT = 0;
		let sumWT2 = 0;
		let sumWX = 0;
		let sumWTX = 0;
		let sumWY = 0;
		let sumWTY = 0;

		for (let i = 0; i < this.samples.length; i++) {
			const sample = this.samples[i]!;
			const age = newest.time - sample.time;
			const weight = Math.exp(-age / decay);
			// t = 0 at newest sample. Older samples have negative t.
			const t = sample.time - newest.time;

			sumW += weight;
			sumWT += weight * t;
			sumWT2 += weight * t * t;
			sumWX += weight * sample.x;
			sumWTX += weight * t * sample.x;
			sumWY += weight * sample.y;
			sumWTY += weight * t * sample.y;
		}

		const determinant = sumW * sumWT2 - sumWT * sumWT;

		if (Math.abs(determinant) < 1e-9) {
			return [];
		}

		const vx = (sumW * sumWTX - sumWT * sumWX) / determinant;
		const vy = (sumW * sumWTY - sumWT * sumWY) / determinant;

		const speed = Math.hypot(vx, vy);

		if (speed < this.config.minVelocity) {
			return [];
		}

		// ANALYZE RECENT MOTION
		const directionInfo = this.computeDirectionInfo();
		const speedInfo = this.computeSpeedInfo();

		// DECELERATION DAMPING
		const decelDamp = this.computeDecelerationDamp(speedInfo.accelerationAlongDirection, speed);

		// CONFIDENCE
		const confidence = this.clamp01(
				(CONFIDENCE_FLOOR_STRAIGHT + (CONFIDENCE_FLOOR_CORNER - CONFIDENCE_FLOOR_STRAIGHT) * (1 - directionInfo.cornerDamp)) +
				directionInfo.consistency * 0.30 +
				directionInfo.cornerDamp * 0.25 +
				speedInfo.stability * 0.15 +
				decelDamp * 0.15
			);

		// SPEED DAMPING NEAR STOP
		const speedRamp = this.clamp01(
			(speed - this.config.minVelocity) / (this.config.minVelocity * 2)
		);
		const dampedSpeed = speed * speedRamp;

		// PREDICTION DISTANCE
		const unclampedDistance = dampedSpeed * this.config.predictionMs;

		const absoluteMaxDistance = Math.min(2.4 * this.config.predictionMs, 120);

		let predictionDistance = Math.min(unclampedDistance, absoluteMaxDistance) * confidence;

		if (predictionDistance < 0.01) {
			return [];
		}

		// Instant-stop cap
		if (this.samples.length >= 2) {
			const last = this.samples[this.samples.length - 1]!;
			const prev = this.samples[this.samples.length - 2]!;
			const dt = last.time - prev.time;
			if (dt > 0) {
				const lastDx = last.x - prev.x;
				const lastDy = last.y - prev.y;
				const lastDisplacement = Math.hypot(lastDx, lastDy);
				const lastSpeed = lastDisplacement / dt;
				const speedRatio = speed > 1e-6 ? lastSpeed / speed : 1;
				if (speedRatio < STOP_SPEED_RATIO) {
					const stopCap = Math.max(1, lastDisplacement * STOP_CAP_MULTIPLIER);
					predictionDistance = Math.min(predictionDistance, stopCap);
				}
			}
		}


		// CURVATURE
		let turnRate = Math.max(-MAX_TURN_RATE, Math.min(MAX_TURN_RATE, directionInfo.turnRate));

		// Curvature is suppressed when confidence is low
		const curveScale = this.clamp01(
			(confidence - MIN_CURVE_CONFIDENCE) / (1 - MIN_CURVE_CONFIDENCE)
		);
		turnRate *= curveScale;

		// Speed damp: reduce turnRate proportionally to speed so fast strokes
		// stay straight while slow strokes retain their curvature
		turnRate /= 1 + SPEED_CURVATURE_K * speed;

		// GENERATE PREDICTION POINTS
		const baseAngle = Math.atan2(vy, vx);

		const points: Point[] = [];

		for (let i = 1; i <= PREDICTION_STEPS; i++) {
			const fraction = i / PREDICTION_STEPS;

			// Ease-out: high confidence = longer tail; low confidence = retract.
			const easePower = this.lerp(4.0, 1.7, confidence);
			const easedFraction = 1 - Math.pow(1 - fraction, easePower);
			const allowedDistance = predictionDistance * easedFraction;

			// Rotate direction over the prediction horizon. The angle grows
			// quadratically so the tail starts aligned with the velocity and
			// curvature concentrates toward the tip — preventing hooks at the
			// base of the tail from any residual turnRate.
			let angleOffset = Math.max(-MAX_TOTAL_TURN, Math.min(MAX_TOTAL_TURN, turnRate * this.config.predictionMs * fraction * fraction));

			// Hook cap: limit the lateral offset per predicted point to
			// MAX_HOOK_PX. This is a hard geometric guarantee — regardless of
			// how large the turnRate is (jitter, real curve, or anything else),
			// the tail can never curve more than MAX_HOOK_PX pixels sideways.
			// Adapts to allowedDistance: at short distances more curvature is
			// allowed; at long distances the cap is tighter.
			if (allowedDistance > 1e-6) {
				const maxAngleForHook = Math.asin(Math.min(1, MAX_HOOK_PX / allowedDistance));
				angleOffset = Math.max(-maxAngleForHook, Math.min(maxAngleForHook, angleOffset));
			}
			const angle = baseAngle + angleOffset;
			let dx = Math.cos(angle) * allowedDistance;
			let dy = Math.sin(angle) * allowedDistance;

			// Hard final clamp: guarantees no curvature can extend the
			// predicted point farther than intended.
			const actualDistance = Math.hypot(dx, dy);
			if (actualDistance > allowedDistance && actualDistance > 1e-6) {
				const scale = allowedDistance / actualDistance;
				dx *= scale;
				dy *= scale;
			}
			points.push({ x: newest.x + dx, y: newest.y + dy, pressure: this.lastPressure });
		}
		return points;
	}

	/**
	 * Analyze recent direction changes.
	 *
	 * Returns:
	 *
	 * consistency:
	 *   1 = very straight
	 *   0 = severe direction changes
	 *
	 * cornerDamp:
	 *   specifically responds to the most recent turn
	 *
	 * turnRate:
	 *   signed angular velocity in radians/ms
	 *
	 */
	private computeDirectionInfo(): {
		consistency: number;
		cornerDamp: number;
		turnRate: number;
	} {
		const n = this.samples.length;

		if (n < 3) {
			return {
				consistency: 1,
				cornerDamp: 1,
				turnRate: 0,
			};
		}

		interface Segment {
			x: number;
			y: number;
			length: number;
			time: number;
		}

		const segments: Segment[] = [];

		for (let i = 1; i < n; i++) {
			const a = this.samples[i - 1]!;
			const b = this.samples[i]!;

			const dx = b.x - a.x;
			const dy = b.y - a.y;

			const length = Math.hypot(dx, dy);

			const dt = b.time - a.time;

			if (length > 1e-6 && dt > 0) {
				segments.push({
					x: dx / length,
					y: dy / length,
					length,
					time: dt,
				});
			}
		}

		if (segments.length < 2) {
			return {
				consistency: 1,
				cornerDamp: 1,
				turnRate: 0,
			};
		}

		let weightedConsistency = 0;
		let totalWeight = 0;

		let weightedTurnRate = 0;
		let totalTurnWeight = 0;

		let lastTurn = 0;

		for (let i = 1; i < segments.length; i++) {
			const previous = segments[i - 1]!;

			const current = segments[i]!;

			const rawDot = this.clamp(
					previous.x * current.x +
					previous.y * current.y,
					-1,
					1
				);

			const cross = previous.x * current.y - previous.y * current.x;

			const turn = Math.atan2(cross, rawDot);

			const absTurn = Math.abs(turn);

			// Convert turn angle into consistency
			// Small turns remain near 1
			const turnConsistency = Math.cos(Math.min(Math.PI, absTurn) * 0.5);

			// Newer direction changes matter more
			const weight = i;

			weightedConsistency += turnConsistency * weight;
			totalWeight += weight;

			const dt = Math.max(1, (previous.time + current.time) * 0.5);
			// Noise gate: suppress jitter-induced turns
			const avgLength = (previous.length + current.length) * 0.5;
			const perpDisplacement = avgLength * Math.sin(absTurn);
			const noiseDamp = this.clamp01((perpDisplacement - NOISE_FLOOR_PX) / NOISE_GATE_WIDTH_PX);
			const localTurnRate = (turn / dt) * noiseDamp;

			weightedTurnRate += localTurnRate * weight;

			totalTurnWeight += weight;

			if (i === segments.length - 1) {
				lastTurn = absTurn;
			}
		}

		const consistency = totalWeight > 0 ? weightedConsistency / totalWeight : 1;

		const turnRate = totalTurnWeight > 0 ? weightedTurnRate / totalTurnWeight : 0;

		// Corner damping using the newest turn 
		let cornerDamp = 1;

		if (lastTurn > TURN_START) {
			const normalizedTurn = this.clamp01((lastTurn - TURN_START) / (TURN_FULL - TURN_START));
			cornerDamp = 1 - normalizedTurn * (1 - CORNER_DAMP_FLOOR);
		}

		return {
			consistency,
			cornerDamp,
			turnRate,
		};
	}
	// Analyze recent segment speeds and estimate acceleration along the direction of travel
	private computeSpeedInfo(): {
		stability: number;
		accelerationAlongDirection: number;
	} {
		const n = this.samples.length;

		if (n < 3) {
			return {
				stability: 1,
				accelerationAlongDirection: 0,
			};
		}

		const speeds: Array<{ speed: number; time: number; }> = [];

		for (let i = 1; i < n; i++) {
			const a = this.samples[i - 1]!;
			const b = this.samples[i]!;

			const dt = b.time - a.time;
			if (dt <= 0) { continue; }

			const dx = b.x - a.x;
			const dy = b.y - a.y;

			const speed = Math.hypot(dx, dy) / dt;
			speeds.push({ speed, time: dt });
		}

		if (speeds.length < 2) {
			return {
				stability: 1,
				accelerationAlongDirection: 0,
			};
		}

		let mean = 0;
		for (const entry of speeds) {
			mean += entry.speed;
		}
		mean /= speeds.length;

		let variance = 0;

		for (const entry of speeds) {
			const delta = entry.speed - mean;
			variance += delta * delta;
		}

		variance /= speeds.length;

		const standardDeviation = Math.sqrt(variance);

		const coefficientOfVariation = mean > 1e-6 ? standardDeviation / mean : 0;

		const stability = 1 / (1 + SPEED_STABILITY_K * coefficientOfVariation);

		//Estimate acceleration from the first and last speed.

		const first = speeds[0]!;
		const last = speeds[speeds.length - 1]!;
		let totalDt = 0;
		for (const entry of speeds) {
			totalDt += entry.time;
		}
		const acceleration = totalDt > 0 ? (last.speed - first.speed) / totalDt : 0;

		return { stability, accelerationAlongDirection: acceleration };
	}

	// Convert negative acceleration into prediction damping.
	private computeDecelerationDamp(
		acceleration: number,
		speed: number
	): number {
		if (acceleration >= 0 || speed <= 1e-6) {
			return 1;
		}

		const normalizedDeceleration = this.clamp01((-acceleration * DECEL_K) / speed);
		return 1 - normalizedDeceleration * (1 - DECEL_DAMP_FLOOR);
	}

	// Return the most recent real sample
	lastSample(): Point | undefined {
		if (this.samples.length === 0) {
			return undefined;
		}

		const sample = this.samples[this.samples.length - 1]!;

		return {
			x: sample.x,
			y: sample.y,
			pressure: this.lastPressure,
		};
	}

	reset(): void {
		this.samples.length = 0;
		this.lastPressure = undefined;
		this.estimatedIntervalMs = 16;
	}

	private clamp01(value: number): number {
		return this.clamp(value, 0, 1);
	}

	private clamp(value: number, min: number, max: number): number {
		return value < min ? min : value > max ? max : value;
	}

	// linear interpolation
	private lerp(a: number, b: number, t: number): number {
		return a + (b - a) * t;
	}
}