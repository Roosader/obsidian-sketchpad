import type { Point } from '../utilities/types';

interface Sample {
	x: number;
	y: number;
	time: number;
}

const MAX_SAMPLES = 6;
const PREDICTION_STEPS = 3; // how many intermediate points to generate

export interface PredictionConfig {
	/** Lookahead window in milliseconds (5–50). */
	predictionMs: number;
	/** Minimum velocity in px/ms below which prediction is suppressed. */
	minVelocity: number;
}

// --- Confidence-factor tuning constants ( Balanced preset ) ---------------
// These shape how aggressively prediction is reduced on different motion
// patterns. All factors combine into a single confidence ∈ [0,1] that scales
// the prediction distance and sharpens the ease-out. Kept internal (no UI)
// so the predictor stays self-tuning.

// straightness: 1 / (1 + k * linearResidual). Larger k → curves damp harder.
const STRAIGHTNESS_K = 0.04;

// speedStability: 1 / (1 + k * coefficientOfVariation(speeds)).
const SPEED_STABILITY_K = 1.5;

// decelDamp: when the pen decelerates, prediction shrinks proportionally.
// factor = clamp(1 + k * accelAlongDir / speed, 0, 1); negative when slowing.
const DECEL_K = 3.0;

// cornerDamp: if the most recent turn exceeds this (radians), prediction is
// sharply reduced so the tail doesn't shoot out of a corner in the old
// direction. ~1.05 rad ≈ 60°.
const CORNER_TURN_THRESHOLD = 1.05;

// How far corner damp reduces confidence (0.15 = drop to ~15%).
const CORNER_DAMP_FLOOR = 0.15;

// quadratic/linear blend band: below BLEND_LOW the tail follows the quadratic
// (curve) extrapolation; above BLEND_HIGH it follows the linear (tangent)
// extrapolation. In between the two blend smoothly.
const BLEND_LOW = 0.35;
const BLEND_HIGH = 0.75;

// adaptive ease-out: easeSharpness = lerp(EASE_GENTLE, EASE_STEEP, 1 - conf).
// Higher sharpness pulls the tail back sooner (less overshoot).
const EASE_GENTLE = 2.0; // high confidence: matches the original ease-out
const EASE_STEEP = 4.5; // low confidence: tail retracts quickly

/**
 * Velocity-based pointer predictor that extrapolates a short tail of future
 * positions ahead of the most recent real sample. Raw pointer updates feed
 * samples; when prediction is enabled, predict() returns 2-3 extrapolated
 * points that the engine renders as a preview tail (rolled back before the
 * next real sample arrives).
 *
 * Algorithm: weighted-least-squares linear fit over a small rolling buffer
 * with exponential decay weights, so the predictor responds quickly to
 * direction changes. A parallel quadratic fit captures acceleration/curvature.
 * Geometry-derived confidence factors (straightness, direction consistency,
 * speed stability, deceleration, sharp-corner detection) scale the prediction
 * distance and adapt the ease-out so the tail extends confidently on clean
 * straight strokes but retracts on curves, corners, and deceleration —
 * preventing overshoots without a separate setting. Prediction is clamped to
 * a configurable lookahead window.
 */
export class PointerPredictor {
	private readonly samples: Sample[] = [];
	private lastPressure: number | undefined;
	private config: PredictionConfig;
	// rolling estimate of the inter-sample interval, used to scale the weight
	// decay so the fit behaves consistently regardless of sampling rate:
	// - pointerrawupdate (e.g. 4ms): short decay → fine smoothing window
	// - pointermove fallback (60Hz, 16.7ms): short decay drops stale samples
	//   fast enough that stationary samples (from before the pen started
	//   moving) don't anchor the velocity estimate near zero
	private estimatedIntervalMs = 16;

	constructor(config?: PredictionConfig) {
		this.config = { predictionMs: 25, minVelocity: 0.5, ...config };
	}

	/** Replace the live config without resetting the sample buffer. */
	setConfig(config: PredictionConfig): void {
		this.config = { ...this.config, ...config };
	}

	/** Feed one real pointer sample (document-space position + timestamp). */
	addSample(point: Point, time: number): void {
		// update the rolling estimate of the inter-sample interval so the
		// weight decay can be scaled to the actual sampling rate
		if (this.samples.length > 0) {
			const prev = this.samples[this.samples.length - 1]!;
			const interval = time - prev.time;
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

	/** Return 0-3 predicted points extending beyond the last real sample. */
	predict(): Point[] {
		if (this.samples.length < 2) {
			return [];
		}

		// Weighted least-squares linear fit on x(t) and y(t) independently,
		// plus the higher-order sums needed for a parallel quadratic fit.
		// Weights decay exponentially: newer samples have much higher weight.
		// The decay constant scales with the observed sample interval so the
		// fit behaves consistently on both input paths:
		//   - pointerrawupdate (~4ms): decay ≈ 8ms → several samples within
		//     one half-life, smooth fit
		//   - pointermove fallback (~16.7ms at 60Hz): decay ≈ 8ms → only the
		//     most recent 1-2 samples carry weight, so stationary samples
		//     from before the pen started moving drop out after one frame
		//     instead of anchoring the velocity estimate near zero.
		const decay = Math.max(8, this.estimatedIntervalMs * 0.5);
		const newest = this.samples[this.samples.length - 1]!;
		let sumW = 0;
		let sumWT = 0;
		let sumWT2 = 0;
		// sums for the quadratic fit x(t) = x0 + vx*t + 0.5*ax*t^2
		let sumWT3 = 0;
		let sumWT4 = 0;
		let sumWX = 0;
		let sumWTX = 0;
		let sumWT2X = 0;
		let sumWY = 0;
		let sumWTY = 0;
		let sumWT2Y = 0;

		for (let i = 0; i < this.samples.length; i++) {
			const s = this.samples[i]!;
			const age = newest.time - s.time;
			const w = Math.exp(-age / decay);
			const t = s.time - newest.time; // negative for older samples
			const t2 = t * t;

			sumW += w;
			sumWT += w * t;
			sumWT2 += w * t2;
			sumWT3 += w * t2 * t;
			sumWT4 += w * t2 * t2;
			sumWX += w * s.x;
			sumWTX += w * t * s.x;
			sumWT2X += w * t2 * s.x;
			sumWY += w * s.y;
			sumWTY += w * t * s.y;
			sumWT2Y += w * t2 * s.y;
		}

		// Solve for vx, vy in: x(t) = x0 + vx*t  (t=0 at newest sample)
		const det = sumW * sumWT2 - sumWT * sumWT;
		if (Math.abs(det) < 1e-9) {
			return [];
		}

		const vx = (sumW * sumWTX - sumWT * sumWX) / det;
		const vy = (sumW * sumWTY - sumWT * sumWY) / det;

		const speed = Math.sqrt(vx * vx + vy * vy);
		if (speed < this.config.minVelocity) {
			return [];
		}

		// --- confidence factors ------------------------------------------------
		// Each factor ∈ [0,1]; their product scales the prediction distance and
		// sharpens the ease-out. Straight clean strokes stay near 1; curves,
		// corners, jittery speed, and deceleration pull it down.
		const straightness = this.computeStraightness(vx, vy, sumW, sumWT, sumWT2, sumWX, sumWTX, sumWY, sumWTY, det);
		const { directionConsistency, cornerDamp } = this.computeDirectionConsistency();
		const speedStability = this.computeSpeedStability();
		const { ax, ay, decelDamp } = this.computeAcceleration(
			sumW, sumWT, sumWT2, sumWT3, sumWT4,
			sumWX, sumWTX, sumWT2X, sumWY, sumWTY, sumWT2Y,
			vx, vy, speed,
		);

		const confidence = this.clamp01(straightness * directionConsistency * speedStability * decelDamp * cornerDamp);

		// Damping: reduce prediction as speed decreases toward MIN_VELOCITY
		const dampFactor = Math.min(1, (speed - this.config.minVelocity) / (this.config.minVelocity * 3));
		const clampedSpeed = speed * dampFactor;

		// Clamp prediction distance: at most predictionMs of travel, and never
		// more than a per-call limit that scales with predictionMs so the
		// "Prediction distance" setting has headroom at higher values
		// (2.4 px/ms ≈ a fast flick; 2.4 * predictionMs caps the overshoot).
		const maxDistancePx = Math.min(2.4 * this.config.predictionMs, 120);
		const maxDistance = clampedSpeed * this.config.predictionMs;
		// confidence scales the distance: straight strokes keep ~all of it,
		// curves/corners/deceleration pull it back to prevent overshoot.
		const actualDistance = Math.min(maxDistance, maxDistancePx) * confidence;

		const dirX = speed > 0 ? vx / speed : 0;
		const dirY = speed > 0 ? vy / speed : 0;

		// Blend linear (tangent) and quadratic (curve-following) extrapolation
		// based on straightness: clean lines use the tangent, gentle curves
		// follow the curvature so the tail doesn't fly off the arc.
		const curveBlend = this.smoothstep(BLEND_LOW, BLEND_HIGH, straightness); // 1=line, 0=curve

		// Adaptive ease-out: high confidence extends gently (more lag hiding);
		// low confidence retracts quickly (less overshoot at corners/stops).
		const easeSharpness = this.lerp(EASE_GENTLE, EASE_STEEP, 1 - confidence);

		const stepMs = this.config.predictionMs / PREDICTION_STEPS;
		const points: Point[] = [];
		for (let i = 1; i <= PREDICTION_STEPS; i++) {
			const t = i * stepMs;
			const frac = t / this.config.predictionMs;
			// Ease-out: prediction tapers off rather than extending at full speed.
			// easedFrac = 1 - (1 - frac)^easeSharpness, generalizing the original
			// frac*(2-frac) (which is the easeSharpness=2 case).
			const easedFrac = 1 - Math.pow(1 - frac, easeSharpness);
			// linear displacement along the velocity direction
			const linDx = dirX * actualDistance * easedFrac;
			const linDy = dirY * actualDistance * easedFrac;
			// quadratic displacement: 0.5*a*t^2 adds curvature so the tail bends
			// along the observed arc instead of leaving on the tangent.
			const half = 0.5;
			const quadDx = linDx + half * ax * t * t;
			const quadDy = linDy + half * ay * t * t;
			points.push({
				x: newest.x + this.lerp(quadDx, linDx, curveBlend),
				y: newest.y + this.lerp(quadDy, linDy, curveBlend),
				pressure: this.lastPressure,
			});
		}

		return points;
	}

	/**
	 * Straightness: how well the linear fit explains the samples.
	 * 1 / (1 + k * weightedResidual), where the residual is the weighted mean
	 * squared error of the linear fit. Collinear samples → ~1; curved or
	 * scattered samples → <1.
	 */
	private computeStraightness(
		vx: number, vy: number,
		sumW: number, sumWT: number, sumWT2: number,
		sumWX: number, sumWTX: number, sumWY: number, sumWTY: number,
		det: number,
	): number {
		if (this.samples.length < 2 || Math.abs(det) < 1e-9) {
			return 1;
		}
		const newest = this.samples[this.samples.length - 1]!;
		const decay = Math.max(8, this.estimatedIntervalMs * 0.5);
		// intercepts at t=0 (the newest sample time)
		const x0 = (sumWT2 * sumWX - sumWT * sumWTX) / det;
		const y0 = (sumWT2 * sumWY - sumWT * sumWTY) / det;
		let residual = 0;
		let totalW = 0;
		for (let i = 0; i < this.samples.length; i++) {
			const s = this.samples[i]!;
			const age = newest.time - s.time;
			const w = Math.exp(-age / decay);
			const t = s.time - newest.time;
			const ex = s.x - (x0 + vx * t);
			const ey = s.y - (y0 + vy * t);
			residual += w * (ex * ex + ey * ey);
			totalW += w;
		}
		if (totalW < 1e-9) {
			return 1;
		}
		const meanResidual = residual / totalW;
		return 1 / (1 + STRAIGHTNESS_K * meanResidual);
	}

	/**
	 * Direction consistency and sharp-corner detection from consecutive
	 * segment vectors. Consistency is the product of cosines of turn angles
	 * between consecutive segments (1 = perfectly straight). cornerDamp
	 * drops sharply when the most recent turn exceeds the threshold.
	 */
	private computeDirectionConsistency(): { directionConsistency: number; cornerDamp: number } {
		const n = this.samples.length;
		if (n < 3) {
			return { directionConsistency: 1, cornerDamp: 1 };
		}
		const dirs: Array<{ x: number; y: number }> = [];
		for (let i = 1; i < n; i++) {
			const a = this.samples[i - 1]!;
			const b = this.samples[i]!;
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const len = Math.sqrt(dx * dx + dy * dy);
			if (len > 1e-6) {
				dirs.push({ x: dx / len, y: dy / len });
			}
		}
		if (dirs.length < 2) {
			return { directionConsistency: 1, cornerDamp: 1 };
		}
		let consistency = 1;
		for (let i = 1; i < dirs.length; i++) {
			const p = dirs[i - 1]!;
			const q = dirs[i]!;
			const dot = this.clamp01(p.x * q.x + p.y * q.y);
			consistency *= dot;
		}
		// cornerDamp uses the most recent turn for responsiveness.
		const lastP = dirs[dirs.length - 2]!;
		const lastQ = dirs[dirs.length - 1]!;
		const lastDot = this.clamp01(lastP.x * lastQ.x + lastP.y * lastQ.y);
		const lastTurn = Math.acos(lastDot);
		let cornerDamp = 1;
		if (lastTurn > CORNER_TURN_THRESHOLD) {
			const span = Math.max(1e-6, Math.PI - CORNER_TURN_THRESHOLD);
			const t = this.clamp01((lastTurn - CORNER_TURN_THRESHOLD) / span);
			cornerDamp = 1 - t * (1 - CORNER_DAMP_FLOOR);
		}
		return { directionConsistency: consistency, cornerDamp };
	}

	/**
	 * Speed stability: 1 / (1 + k * coefficientOfVariation) of the per-sample
	 * speeds. Steady speed → ~1; speed surging or fluctuating → <1.
	 */
	private computeSpeedStability(): number {
		const n = this.samples.length;
		if (n < 3) {
			return 1;
		}
		const speeds: number[] = [];
		for (let i = 1; i < n; i++) {
			const a = this.samples[i - 1]!;
			const b = this.samples[i]!;
			const dt = b.time - a.time;
			if (dt <= 0) {
				continue;
			}
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			speeds.push(Math.sqrt(dx * dx + dy * dy) / dt);
		}
		if (speeds.length < 2) {
			return 1;
		}
		let mean = 0;
		for (const s of speeds) {
			mean += s;
		}
		mean /= speeds.length;
		if (mean < 1e-6) {
			return 1;
		}
		let variance = 0;
		for (const s of speeds) {
			const d = s - mean;
			variance += d * d;
		}
		variance /= speeds.length;
		const cv = Math.sqrt(variance) / mean;
		return 1 / (1 + SPEED_STABILITY_K * cv);
	}

	/**
	 * Quadratic fit (acceleration ax, ay) via weighted least squares on
	 * x(t) = x0 + vx*t + 0.5*ax*t^2, plus deceleration damping. decelDamp is 1
	 * when accelerating/constant and drops toward 0 when decelerating, so the
	 * tail doesn't run past a stopping point or into a corner.
	 *
	 * Solves the 3x3 normal equations for each axis with Cramer's rule. Falls
	 * back to zero acceleration if the system is ill-conditioned.
	 */
	private computeAcceleration(
		sumW: number, sumWT: number, sumWT2: number, sumWT3: number, sumWT4: number,
		sumWX: number, sumWTX: number, sumWT2X: number,
		sumWY: number, sumWTY: number, sumWT2Y: number,
		vx: number, vy: number, speed: number,
	): { ax: number; ay: number; decelDamp: number } {
		// normal matrix for x(t) = x0 + c1*t + c2*t^2 (c1 = vx, c2 = 0.5*ax):
		//   [ sumW    sumWT   sumWT2  ] [ x0 ]   [ sumWX   ]
		//   [ sumWT   sumWT2  sumWT3  ] [ c1 ] = [ sumWTX  ]
		//   [ sumWT2  sumWT3  sumWT4  ] [ c2 ]   [ sumWT2X ]
		const det3 = sumW * (sumWT2 * sumWT4 - sumWT3 * sumWT3)
			- sumWT * (sumWT * sumWT4 - sumWT3 * sumWT2)
			+ sumWT2 * (sumWT * sumWT3 - sumWT2 * sumWT2);
		let ax = 0;
		let ay = 0;
		if (Math.abs(det3) > 1e-9) {
			// Cramer's rule for c2 (column 3 replaced by the RHS).
			const detC2x = sumW * (sumWT2 * sumWT2X - sumWT3 * sumWTX)
				- sumWT * (sumWT * sumWT2X - sumWT3 * sumWX)
				+ sumWT2 * (sumWT * sumWTX - sumWT2 * sumWX);
			const detC2y = sumW * (sumWT2 * sumWT2Y - sumWT3 * sumWTY)
				- sumWT * (sumWT * sumWT2Y - sumWT3 * sumWY)
				+ sumWT2 * (sumWT * sumWTY - sumWT2 * sumWY);
			ax = 2 * (detC2x / det3);
			ay = 2 * (detC2y / det3);
		}
		// decelDamp: project acceleration onto the velocity direction.
		// accelAlongDir > 0 = speeding up, < 0 = slowing down.
		let decelDamp = 1;
		if (speed > 1e-6) {
			const accelAlongDir = (ax * vx + ay * vy) / speed;
			if (accelAlongDir < 0) {
				decelDamp = this.clamp01(1 + DECEL_K * (accelAlongDir / speed));
			}
		}
		return { ax, ay, decelDamp };
	}

	/** Clamp a value to [0,1]. */
	private clamp01(v: number): number {
		return v < 0 ? 0 : v > 1 ? 1 : v;
	}

	/** Linear interpolation from a to b by t (unclamped). */
	private lerp(a: number, b: number, t: number): number {
		return a + (b - a) * t;
	}

	/** Hermite smoothstep: 0 below edge0, 1 above edge1, smooth in between. */
	private smoothstep(edge0: number, edge1: number, x: number): number {
		const t = this.clamp01((x - edge0) / (edge1 - edge0));
		return t * t * (3 - 2 * t);
	}



	/** Return the most recent real sample fed to the predictor, or undefined. */
	lastSample(): Point | undefined {
		if (this.samples.length === 0) {
			return undefined;
		}
		const s = this.samples[this.samples.length - 1]!;
		return { x: s.x, y: s.y, pressure: this.lastPressure };
	}

	/** Clear the sample buffer for a new stroke. */
	reset(): void {
		this.samples.length = 0;
		this.lastPressure = undefined;
	}
}