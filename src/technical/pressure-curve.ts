export interface PressureControlPoint {
	x: number;
	y: number;
}

// customizable pressure curve with 5 points
export interface PressureCurve {
	points: [
		PressureControlPoint, // left edge (min pressure)
		PressureControlPoint,
		PressureControlPoint,
		PressureControlPoint,
		PressureControlPoint, // right edge (max pressure)
	];
}

export const DEFAULT_PRESSURE_CURVE: PressureCurve = {
	points: [
		{ x: 0, y: 0 },
		{ x: 0.25, y: 0.25 },
		{ x: 0.5, y: 0.5 },
		{ x: 0.75, y: 0.75 },
		{ x: 1, y: 1 },
	],
};

const MIN_X_GAP = 0.01;

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

export function clonePressureCurve(curve: PressureCurve): PressureCurve {
	const clamped = clampPressureCurve(curve);
	return {
		points: clamped.points.map((point) => ({ ...point })) as [
			PressureControlPoint,
			PressureControlPoint,
			PressureControlPoint,
			PressureControlPoint,
			PressureControlPoint,
		],
	};
}

function sanitizePoint(point: Partial<PressureControlPoint> | undefined, fallback: PressureControlPoint): PressureControlPoint {
	return {
		x: typeof point?.x === 'number' ? point.x : fallback.x,
		y: typeof point?.y === 'number' ? point.y : fallback.y,
	};
}

export function clampPressureCurve(curve: PressureCurve | Partial<PressureCurve>): PressureCurve {
	const defaults = DEFAULT_PRESSURE_CURVE.points;
	const source = curve.points;
	const points: [PressureControlPoint, PressureControlPoint, PressureControlPoint, PressureControlPoint, PressureControlPoint] = [
		sanitizePoint(source?.[0], defaults[0]),
		sanitizePoint(source?.[1], defaults[1]),
		sanitizePoint(source?.[2], defaults[2]),
		sanitizePoint(source?.[3], defaults[3]),
		sanitizePoint(source?.[4], defaults[4]),
	];

	// first and last points only move vertically
	points[0].x = 0;
	points[4].x = 1;
	points[0].y = clamp01(points[0].y);
	points[4].y = clamp01(points[4].y);

	// keeps the points from going past each other horizontally
	for (let i = 1; i < 4; i += 1) {
		points[i]!.x = Math.max(points[i - 1]!.x + MIN_X_GAP, points[i]!.x);
	}
	for (let i = 3; i >= 1; i -= 1) {
		points[i]!.x = Math.min(points[i + 1]!.x - MIN_X_GAP, points[i]!.x);
	}

	points[1].y = clamp01(points[1].y);
	points[2].y = clamp01(points[2].y);
	points[3].y = clamp01(points[3].y);

	return { points };
}

export interface PressureCurveSampler {
	evaluate(pressure: number): number;
}



// uses a smooth piecewise-cubic Hermite interpolation (PCHIP/Fritsch–Carlson)
export function buildPressureCurveSampler(curve: PressureCurve): PressureCurveSampler {
	const c = clampPressureCurve(curve);

	const knots: PressureControlPoint[] = c.points;
	const n = knots.length;
	const h: number[] = [];
	const delta: number[] = [];
	for (let i = 0; i < n - 1; i += 1) {
		const dx = Math.max(1e-6, knots[i + 1]!.x - knots[i]!.x);
		h.push(dx);
		delta.push((knots[i + 1]!.y - knots[i]!.y) / dx);
	}

	const m = new Array<number>(n).fill(0);

	const h0 = h[0]!;
	const h1 = h[1]!;
	m[0] = ((2 * h0 + h1) * delta[0]! - h0 * delta[1]!) / (h0 + h1);
	const hLast = h[n - 2]!;
	const hPrevLast = h[n - 3]!;
	m[n - 1] = ((2 * hLast + hPrevLast) * delta[n - 2]! - hLast * delta[n - 3]!) / (hLast + hPrevLast);

	for (let i = 1; i < n - 1; i += 1) {
		const dPrev = delta[i - 1]!;
		const dNext = delta[i]!;
		if (dPrev === 0 || dNext === 0 || dPrev * dNext < 0) {
			m[i] = 0;
			continue;
		}
		const hPrev = h[i - 1]!;
		const hNext = h[i]!;
		const w1 = 2 * hNext + hPrev;
		const w2 = hNext + 2 * hPrev;
		m[i] = (w1 + w2) / (w1 / dPrev + w2 / dNext);
	}

	// endpoint limiting to keep tangents well-behaved and shape-preserving.
	const mFirst = m[0] ?? 0;
	const dFirst = delta[0] ?? 0;
	if (mFirst * dFirst < 0) {
		m[0] = 0;
	} else if (Math.abs(mFirst) > 3 * Math.abs(dFirst)) {
		m[0] = 3 * dFirst;
	}
	const mLast = m[n - 1] ?? 0;
	const dLast = delta[n - 2] ?? 0;
	if (mLast * dLast < 0) {
		m[n - 1] = 0;
	} else if (Math.abs(mLast) > 3 * Math.abs(dLast)) {
		m[n - 1] = 3 * dLast;
	}

	return {
		evaluate(pressure: number): number {
			const p = clamp01(pressure);
			for (let i = 0; i < n - 1; i += 1) {
				const a = knots[i]!;
				const b = knots[i + 1]!;
				if (p <= b.x || i === n - 2) {
					const segH = h[i]!;
					const t = clamp01((p - a.x) / segH);
					const t2 = t * t;
					const t3 = t2 * t;
					const h00 = 2 * t3 - 3 * t2 + 1;
					const h10 = t3 - 2 * t2 + t;
					const h01 = -2 * t3 + 3 * t2;
					const h11 = t3 - t2;
					const y = h00 * a.y + h10 * segH * m[i]! + h01 * b.y + h11 * segH * m[i + 1]!;
					return clamp01(y);
				}
			}
			return 1;
		},
	};
}

// builds a sampler once when the curve is stable and reusing it.
export function evaluatePressureCurve(curve: PressureCurve, pressure: number): number {
	return buildPressureCurveSampler(curve).evaluate(pressure);
}
