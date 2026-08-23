import type { Point } from '../utilities/types';

interface Sample {
	x: number;
	y: number;
	time: number;
}

const MAX_SAMPLES = 6;
const PREDICTION_STEPS = 3;

export interface PredictionConfig {
	/** Lookahead window in milliseconds. */
	predictionMs: number;

	/** Minimum velocity in px/ms below which prediction is suppressed. */
	minVelocity: number;
}

/*
 * Internal tuning constants.
 *
 * These are intentionally kept out of PredictionConfig so the public
 * configuration remains simple.
 */

// Minimum confidence. Prevents several mildly-bad signals from multiplying
// together and completely eliminating prediction.
const CONFIDENCE_FLOOR = 0.15;

// Recent velocity smoothing.
// Higher = responds faster.
const VELOCITY_SMOOTH_STRAIGHT = 0.30;
const VELOCITY_SMOOTH_TURNING = 0.75;

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

/**
 * Pointer predictor designed for short-latency pen prediction.
 *
 * The predictor estimates recent velocity using a weighted linear regression,
 * estimates turning from recent segment directions, estimates deceleration
 * from recent speed, and generates a short arc-shaped prediction tail.
 *
 * The public API matches the previous predictor:
 *
 * - addSample()
 * - predict()
 * - lastSample()
 * - reset()
 * - setConfig()
 */
export class PointerPredictor {
	private readonly samples: Sample[] = [];

	private lastPressure: number | undefined;

	private config: PredictionConfig;

	private estimatedIntervalMs = 16;

	/*
	 * Smoothed velocity state.
	 *
	 * This makes predictions visually stable between events while adaptive
	 * smoothing allows quick response when the pen changes direction.
	 */
	private filteredVx = 0;
	private filteredVy = 0;
	private hasFilteredVelocity = false;

	constructor(config?: PredictionConfig) {
		this.config = {predictionMs: 25,minVelocity: 0.5,...config,};
	}

	/** Replace the live config without resetting the sample buffer. */
	setConfig(config: PredictionConfig): void {
		this.config = {...this.config,...config,};
	}

	/** Feed one real pointer sample. */
	addSample(point: Point, time: number): void {
		if (this.samples.length > 0) {
			const previous = this.samples[this.samples.length - 1]!;

			const interval = time - previous.time;

			if ( interval > 0 && interval < 200 ) {
				this.estimatedIntervalMs = this.estimatedIntervalMs * 0.7 +interval * 0.3;
			}
		}

		this.samples.push({x: point.x, y: point.y, time,});

		if (this.samples.length > MAX_SAMPLES) {
			this.samples.shift();
		}

		this.lastPressure = point.pressure;
	}

	/**
	 * Return predicted points extending beyond the newest real sample.
	 */
	predict(): Point[] {
		if ( this.samples.length < 2 ) {
			return [];
		}

		const newest = this.samples[this.samples.length - 1]!;

		/*
		 * ------------------------------------------------------------
		 * 1. ESTIMATE VELOCITY
		 * ------------------------------------------------------------
		 *
		 * Weighted linear regression over recent samples.
		 *
		 * Newer samples receive exponentially more weight.
		 */

		const decay = Math.max( 8,this.estimatedIntervalMs * 0.75 );

		let sumW = 0;
		let sumWT = 0;
		let sumWT2 = 0;

		let sumWX = 0;
		let sumWTX = 0;

		let sumWY = 0;
		let sumWTY = 0;

		for ( let i = 0;i < this.samples.length; i++) {
			const sample = this.samples[i]!;

			const age = newest.time - sample.time;

			const weight = Math.exp(-age / decay);

			/*
			 * t = 0 at newest sample.
			 * Older samples have negative t.
			 */
			const t = sample.time -newest.time;

			sumW += weight;
			sumWT += weight * t;
			sumWT2 += weight * t * t;

			sumWX += weight * sample.x;

			sumWTX += weight * t * sample.x;

			sumWY += weight * sample.y;

			sumWTY += weight * t *sample.y;
		}

		const determinant = sumW * sumWT2 - sumWT * sumWT;

		if ( Math.abs(determinant) < 1e-9 ) {
			return [];
		}

		const rawVx = ( sumW * sumWTX - sumWT * sumWX) /determinant;

		const rawVy = ( sumW * sumWTY - sumWT * sumWY) /determinant;

		const rawSpeed = Math.hypot(rawVx,rawVy);

		if ( rawSpeed < this.config.minVelocity ) {
			return [];
		}

		/*
		 * ------------------------------------------------------------
		 * 2. ANALYZE RECENT MOTION
		 * ------------------------------------------------------------
		 */

		const directionInfo = this.computeDirectionInfo();

		const speedInfo = this.computeSpeedInfo();

		/*
		 * ------------------------------------------------------------
		 * 3. ADAPTIVELY SMOOTH VELOCITY
		 * ------------------------------------------------------------
		 *
		 * On straight motion:
		 *   more smoothing for stability.
		 *
		 * During turns:
		 *   respond more quickly.
		 */

		const turnResponse = 1 - directionInfo.consistency;
		const smoothing = this.lerp( VELOCITY_SMOOTH_STRAIGHT, VELOCITY_SMOOTH_TURNING, turnResponse );

		if ( !this.hasFilteredVelocity ) {
			this.filteredVx = rawVx;

			this.filteredVy = rawVy;

			this.hasFilteredVelocity = true;
		} else {
			this.filteredVx += ( rawVx - this.filteredVx ) * smoothing;

			this.filteredVy += ( rawVy - this.filteredVy) * smoothing;
		}

		const vx =this.filteredVx;
		const vy =this.filteredVy;

		const speed = Math.hypot( vx, vy);

		if ( speed < this.config.minVelocity ) {
			return [];
		}

		/*
		 * ------------------------------------------------------------
		 * 4. DECELERATION DAMPING
		 * ------------------------------------------------------------
		 */

		const decelDamp = this.computeDecelerationDamp( speedInfo.accelerationAlongDirection, speed );

		/*
		 * ------------------------------------------------------------
		 * 5. CONFIDENCE
		 * ------------------------------------------------------------
		 *
		 * This is intentionally an additive weighted confidence instead
		 * of multiplying several factors.
		 *
		 * Multiplication caused mildly-imperfect signals to collapse
		 * prediction too aggressively.
		 */

		const confidence = this.clamp01(
				CONFIDENCE_FLOOR +
				directionInfo.consistency * 0.30 +
				directionInfo.cornerDamp * 0.25 +
				speedInfo.stability * 0.15 +
				decelDamp * 0.15
			);

		/*
		 * ------------------------------------------------------------
		 * 6. SPEED DAMPING NEAR STOP
		 * ------------------------------------------------------------
		 */

		const speedRamp =
			this.clamp01(
				( speed -this.config.minVelocity) /
				( this.config.minVelocity * 2 )
			);
		const dampedSpeed = speed * speedRamp;

		/*
		 * ------------------------------------------------------------
		 * 7. PREDICTION DISTANCE
		 * ------------------------------------------------------------
		 */

		const unclampedDistance = dampedSpeed * this.config.predictionMs;

		const absoluteMaxDistance = Math.min( 2.4 * this.config.predictionMs, 120 );

		const predictionDistance = Math.min( unclampedDistance, absoluteMaxDistance ) * confidence;

		if ( predictionDistance < 0.01 ) {
			return [];
		}

		/*
		 * ------------------------------------------------------------
		 * 8. CURVATURE
		 * ------------------------------------------------------------
		 *
		 * Instead of a quadratic x/y fit, we estimate the recent angular
		 * turning rate and rotate the velocity direction over time.
		 *
		 * This is generally more stable for drawing because human pen
		 * strokes are naturally lines and arcs rather than constant
		 * Cartesian acceleration trajectories.
		 */

		let turnRate = directionInfo.turnRate;

		turnRate = Math.max( -MAX_TURN_RATE, Math.min( MAX_TURN_RATE, turnRate ));

		/*
		 * Curvature is suppressed when confidence is low.
		 */
		const curveScale = this.clamp01(
				( confidence - MIN_CURVE_CONFIDENCE ) /
				( 1 - MIN_CURVE_CONFIDENCE)
			);

		turnRate *=curveScale * directionInfo.curveConfidence;

		/*
		 * ------------------------------------------------------------
		 * 9. GENERATE PREDICTION POINTS
		 * ------------------------------------------------------------
		 */

		const baseAngle = Math.atan2( vy, vx );

		const points: Point[] = [];

		for ( let i = 1; i <= PREDICTION_STEPS; i++ ) {
			const fraction = i / PREDICTION_STEPS;

			const time = this.config.predictionMs * fraction;

			/*
			 * Ease-out.
			 *
			 * High confidence = longer tail.
			 * Low confidence = retract earlier.
			 */
			const easePower = this.lerp( 4.0, 1.7, confidence);

			const easedFraction = 1 - Math.pow( 1 - fraction, easePower);

			const allowedDistance = predictionDistance * easedFraction;

			/*
			 * Rotate direction over the prediction horizon.
			 */
			let angleOffset = turnRate * time;
			angleOffset = Math.max( -MAX_TOTAL_TURN, Math.min(MAX_TOTAL_TURN, angleOffset));

			const angle = baseAngle + angleOffset;
			let dx = Math.cos(angle) * allowedDistance;
			let dy = Math.sin(angle) * allowedDistance;

			/*
			 * Hard final clamp.
			 *
			 * This guarantees that no curvature or future tuning change
			 * can extend the predicted point farther than intended.
			 */
			const actualDistance = Math.hypot( dx, dy );

			if ( actualDistance > allowedDistance && actualDistance > 1e-6 ) {
				const scale = allowedDistance / actualDistance;
				dx *= scale;
				dy *= scale;
			}
			points.push({ x: newest.x + dx, y: newest.y + dy, pressure: this.lastPressure, });
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
	 * curveConfidence:
	 *   how trustworthy the curvature estimate is
	 */
	private computeDirectionInfo(): {
		consistency: number;
		cornerDamp: number;
		turnRate: number;
		curveConfidence: number;
	} {
		const n = this.samples.length;

		if (n < 3) {
			return {
				consistency: 1,
				cornerDamp: 1,
				turnRate: 0,
				curveConfidence: 0,
			};
		}

		interface Segment {
			x: number;
			y: number;
			length: number;
			time: number;
		}

		const segments: Segment[] = [];

		for ( let i = 1; i < n; i++) {
			const a = this.samples[i - 1]!;
			const b = this.samples[i]!;

			const dx = b.x - a.x;
			const dy = b.y - a.y;

			const length = Math.hypot( dx, dy );

			const dt = b.time - a.time;

			if ( length > 1e-6 && dt > 0) {
				segments.push({
					x: dx / length,
					y:dy / length,
					length,
					time: dt,
				});
			}
		}

		if ( segments.length < 2 ) {
			return {
				consistency: 1,
				cornerDamp: 1,
				turnRate: 0,
				curveConfidence: 0,
			};
		}

		let weightedConsistency = 0;
		let totalWeight = 0;

		let weightedTurnRate = 0;
		let totalTurnWeight = 0;

		let lastTurn = 0;

		for ( let i = 1; i < segments.length; i++ ) {
			const previous = segments[i - 1]!;

			const current = segments[i]!;

			const rawDot = this.clamp(
					previous.x * current.x +
					previous.y * current.y,
					-1,
					1
				);

			const cross = previous.x * current.y - previous.y * current.x;

			const turn = Math.atan2( cross, rawDot );

			const absTurn = Math.abs( turn );

			/*
			 * Convert turn angle into consistency.
			 *
			 * Small turns remain near 1.
			 */
			const turnConsistency = Math.cos( Math.min( Math.PI, absTurn ) * 0.5 );

			/*
			 * Newer direction changes matter more.
			 */
			const weight = i;

			weightedConsistency += turnConsistency * weight;
			totalWeight += weight;

			const dt = Math.max( 1, ( previous.time + current.time ) * 0.5 );
			const localTurnRate = turn / dt;

			weightedTurnRate += localTurnRate * weight;

			totalTurnWeight += weight;

			if ( i === segments.length - 1 ) {
				lastTurn = absTurn;
			}
		}

		const consistency = totalWeight > 0 ? weightedConsistency / totalWeight: 1;

		const turnRate = totalTurnWeight > 0 ? weightedTurnRate / totalTurnWeight: 0;

		/*
		 * Corner damping uses the newest turn because prediction needs
		 * to react immediately when the pen changes direction.
		 */
		let cornerDamp = 1;

		if ( lastTurn > TURN_START ) {
			const normalizedTurn = this.clamp01( ( lastTurn - TURN_START ) / ( TURN_FULL - TURN_START ));
			cornerDamp = 1 - normalizedTurn * (	1 - CORNER_DAMP_FLOOR );
		}

		/*
		 * Curvature is more trustworthy when the recent turns are
		 * reasonably consistent and not a sudden sharp corner.
		 */
		const curveConfidence = this.clamp01( consistency * cornerDamp);

		return {
			consistency,
			cornerDamp,
			turnRate,
			curveConfidence,
		};
	}

	/**
	 * Analyze recent segment speeds and estimate acceleration along the
	 * direction of travel.
	 */
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

		for ( let i = 1; i < n; i++ ) {
			const a = this.samples[i - 1]!;
			const b = this.samples[i]!;

			const dt = b.time - a.time;
			if ( dt <= 0 ) { continue; }

			const dx = b.x - a.x;
			const dy =b.y - a.y;

			const speed = Math.hypot( dx, dy ) / dt;
			speeds.push({ speed, time: dt, });
		}

		if ( speeds.length < 2 ) {
			return {
				stability: 1,
				accelerationAlongDirection: 0,
			};
		}

		let mean = 0;
		for ( const entry of speeds) {
			mean +=	entry.speed;
		}
		mean /=	speeds.length;

		let variance = 0;

		for ( const entry of speeds) {
			const delta = entry.speed -	mean;
			variance +=	delta *	delta;
		}

		variance /=	speeds.length;

		const standardDeviation = Math.sqrt( variance );

		const coefficientOfVariation = mean > 1e-6 ? standardDeviation / mean: 0;

		const stability = 1 / ( 1 +	SPEED_STABILITY_K *	coefficientOfVariation );

		/*
		 * Estimate acceleration from the first and last speed.
		 *
		 * This is intentionally simpler and more stable than fitting a
		 * second-order polynomial through x/y coordinates.
		 */
		const first = speeds[0]!;

		const last = speeds[ speeds.length - 1 ]!;

		let totalDt = 0;

		for ( let i = 1; i < this.samples.length; i++ ) {
			const a = this.samples[i - 1]!;

			const b = this.samples[i]!;

			const dt = b.time - a.time;

			if ( dt > 0) {
				totalDt += dt;
			}
		}

		const acceleration = totalDt > 0 ? ( last.speed - first.speed ) / totalDt : 0;

		return { stability, accelerationAlongDirection:	acceleration, };
	}

	/**
	 * Convert negative acceleration into prediction damping.
	 */
	private computeDecelerationDamp(
		acceleration: number,
		speed: number
	): number {
		if ( acceleration >= 0 || speed <= 1e-6 ) {
			return 1;
		}

		const normalizedDeceleration =
			this.clamp01( (-acceleration * DECEL_K) / speed );

		return ( 1 - normalizedDeceleration * (1 - DECEL_DAMP_FLOOR) );
	}

	/** Return the most recent real sample. */
	lastSample(): Point | undefined {
		if ( this.samples.length === 0 ) {
			return undefined;
		}

		const sample = this.samples[ this.samples.length - 1 ]!;

		return {
			x: sample.x,
			y: sample.y,
			pressure: this.lastPressure,
		};
	}

	/** Clear all prediction state for a new stroke. */
	reset(): void {
		this.samples.length = 0;

		this.lastPressure = undefined;

		this.estimatedIntervalMs = 16;

		this.filteredVx = 0;
		this.filteredVy = 0;

		this.hasFilteredVelocity = false;
	}

	/** Clamp to [0, 1]. */
	private clamp01( value: number ): number {
		return this.clamp( value, 0, 1 );
	}

	/** Clamp to an arbitrary range. */
	private clamp(
		value: number,
		min: number,
		max: number
	): number {
		return value < min
			? min
			: value > max
				? max
				: value;
	}

	/** Linear interpolation. */
	private lerp(
		a: number,
		b: number,
		t: number
	): number {
		return ( a + ( b - a ) * t);
	}
}