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

/**
 * Velocity-based pointer predictor that extrapolates a short tail of future
 * positions ahead of the most recent real sample. Raw pointer updates feed
 * samples; when prediction is enabled, predict() returns 2-3 extrapolated
 * points that the engine renders as a preview tail (rolled back before the
 * next real sample arrives).
 *
 * Algorithm: weighted-least-squares linear fit over a small rolling buffer
 * with exponential decay weights, so the predictor responds quickly to
 * direction changes. Prediction distance is damped as velocity drops, and
 * clamped to a configurable lookahead window.
 */
export class PointerPredictor {
	private readonly samples: Sample[] = [];
	private lastPressure: number | undefined;
	private config: PredictionConfig;

	constructor(config?: PredictionConfig) {
		this.config = { predictionMs: 25, minVelocity: 0.5, ...config };
	}

	/** Replace the live config without resetting the sample buffer. */
	setConfig(config: PredictionConfig): void {
		this.config = { ...this.config, ...config };
	}

	/** Feed one real pointer sample (document-space position + timestamp). */
	addSample(point: Point, time: number): void {
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

		// Weighted least-squares linear fit on x(t) and y(t) independently.
		// Weights decay exponentially: newer samples have much higher weight.
		const newest = this.samples[this.samples.length - 1]!;
		let sumW = 0;
		let sumWT = 0;
		let sumWT2 = 0;
		let sumWX = 0;
		let sumWTX = 0;
		let sumWY = 0;
		let sumWTY = 0;

		for (let i = 0; i < this.samples.length; i++) {
			const s = this.samples[i]!;
			// Age in ms relative to newest sample; weight falls off with a ~30ms half-life
			const age = newest.time - s.time;
			const w = Math.exp(-age / 20);
			const t = s.time - newest.time; // negative for older samples

			sumW += w;
			sumWT += w * t;
			sumWT2 += w * t * t;
			sumWX += w * s.x;
			sumWTX += w * t * s.x;
			sumWY += w * s.y;
			sumWTY += w * t * s.y;
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

		// Damping: reduce prediction as speed decreases toward MIN_VELOCITY
		const dampFactor = Math.min(1, (speed - this.config.minVelocity) / (this.config.minVelocity * 3));
		const clampedSpeed = speed * dampFactor;

		// Clamp prediction distance: at most predictionMs of travel, and never
		// more than a per-call limit that scales with predictionMs so the
		// "Prediction distance" setting has headroom at higher values
		// (2.4 px/ms ≈ a fast flick; 2.4 * predictionMs caps the overshoot).
		const maxDistancePx = Math.min(2.4 * this.config.predictionMs, 120);
		const maxDistance = clampedSpeed * this.config.predictionMs;
		const actualDistance = Math.min(maxDistance, maxDistancePx);

		const dirX = speed > 0 ? vx / speed : 0;
		const dirY = speed > 0 ? vy / speed : 0;

		const stepMs = this.config.predictionMs / PREDICTION_STEPS;
		const points: Point[] = [];
		for (let i = 1; i <= PREDICTION_STEPS; i++) {
			const t = i * stepMs;
			const frac = t / this.config.predictionMs;
			// Ease-out: prediction tapers off rather than extending at full speed
			const easedFrac = frac * (2 - frac);
			points.push({
				x: newest.x + dirX * actualDistance * easedFrac,
				y: newest.y + dirY * actualDistance * easedFrac,
				pressure: this.lastPressure,
			});
		}

		return points;
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