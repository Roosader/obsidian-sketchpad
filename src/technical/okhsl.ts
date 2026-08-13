// OKHSL <-> sRGB conversion.
//
// Port of Björn Ottosson's Okhsl algorithm, as implemented in color.js
// (https://github.com/color-js/color.js, src/spaces/okhsl.js + src/spaces/oklab.js).
//
// ---- License ----
//
// Copyright (c) 2021 Björn Ottosson
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of
// this software and associated documentation files (the "Software"), to deal in
// the Software without restriction, including without limitation the rights to
// use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
// of the Software, and to permit persons to whom the Software is furnished to do
// so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

const tau = 2 * Math.PI;
const K1 = 0.206;
const K2 = 0.03;
const K3 = (1.0 + K1) / (1.0 + K2);
const floatMax = Number.MAX_VALUE;

type V3 = readonly [number, number, number];
type M3 = readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];

// Oklab <-> LMS matrices (color.js oklab.js, recalculated for consistent
// reference white).
const LAB_TO_LMS: M3 = [
	[1.0, 0.3963377773761749, 0.2158037573099136],
	[1.0, -0.1055613458156586, -0.0638541728258133],
	[1.0, -0.0894841775298119, -1.2914855480194092],
];
const LMS_TO_LAB: M3 = [
	[0.210454268309314, 0.7936177747023054, -0.0040720430116193],
	[1.9779985324311684, -2.4285922420485799, 0.450593709617411],
	[0.0259040424655478, 0.7827717124575296, -0.8086757549230774],
];

// sRGB-linear <-> LMS matrices (color.js okhsl.js).
const TO_LMS: M3 = [
	[0.4122214694707629, 0.5363325372617349, 0.0514459932675022],
	[0.2119034958178251, 0.6806995506452344, 0.1073969535369405],
	[0.0883024591900564, 0.2817188391361215, 0.6299787016738222],
];
const TO_SRGB_LINEAR: M3 = [
	[4.0767416360759583, -3.3077115392580629, 0.2309699031821043],
	[-1.2684379732850315, 2.6097573492876882, -0.341319376002657],
	[-0.0041960761386756, -0.7034186179359362, 1.7076146940746117],
];

type V2 = readonly [number, number];
type V5 = readonly [number, number, number, number, number];
type OkCoeff = readonly [readonly [V2, V5], readonly [V2, V5], readonly [V2, V5]];

// Per-channel Kn coefficients used by computeMaxSaturation.
const RGB_COEFF: OkCoeff = [
	[[-1.8817031, -0.80936501], [1.19086277, 1.76576728, 0.59662641, 0.75515197, 0.56771245]],
	[[1.8144408, -1.19445267], [0.73956515, -0.45954404, 0.08285427, 0.12541073, -0.14503204]],
	[[0.13110758, 1.81333971], [1.35733652, -0.00915799, -1.1513021, -0.50559606, 0.00692167]],
];

function multiply3x3(m: M3, v: V3): V3 {
	const [[m00, m01, m02], [m10, m11, m12], [m20, m21, m22]] = m;
	const [x, y, z] = v;
	return [
		m00 * x + m01 * y + m02 * z,
		m10 * x + m11 * y + m12 * z,
		m20 * x + m21 * y + m22 * z,
	];
}

function vdot(a: readonly number[], b: readonly number[]): number {
	let s = 0;
	for (let i = 0; i < a.length; i++) {
		s += a[i]! * b[i]!;
	}
	return s;
}

// Signed power: preserves sign for negative bases (Math.pow would give NaN).
function spow(x: number, p: number): number {
	return Math.sign(x) * Math.abs(x) ** p;
}

/** Toe function for L_r. */
function toe(x: number): number {
	return 0.5 * (K3 * x - K1 + Math.sqrt((K3 * x - K1) * (K3 * x - K1) + 4 * K2 * K3 * x));
}

/** Inverse toe function for L_r. */
function toeInv(x: number): number {
	return (x * x + K1 * x) / (K3 * (x + K2));
}

/** To ST. */
function toSt(cusp: V2): V2 {
	const [l, c] = cusp;
	return [c / l, c / (1 - l)];
}

/**
 * Returns a smooth approximation of the location of the cusp.
 * This polynomial was created by an optimization process. It has been
 * designed so that S_mid < S_max and T_mid < T_max.
 */
function getStMid(a: number, b: number): V2 {
	// prettier-ignore
	const s = 0.11516993 + 1.0 / (
		7.44778970 + 4.15901240 * b +
		a * (
			-2.19557347 + 1.75198401 * b +
			a * (
				-2.13704948 - 10.02301043 * b +
				a * (
					-4.24894561 + 5.38770819 * b + 4.69891013 * a
				)
			)
		)
	);
	// prettier-ignore
	const t = 0.11239642 + 1.0 / (
		1.61320320 - 0.68124379 * b +
		a * (
			0.40370612 + 0.90148123 * b +
			a * (
				-0.27087943 + 0.61223990 * b +
				a * (
					0.00299215 - 0.45399568 * b - 0.14661872 * a
				)
			)
		)
	);
	return [s, t];
}

/** Convert from Oklab to linear RGB (any gamut, via `lmsToRgb` matrix). */
function oklabToLinearRGB(lab: V3): V3 {
	const lms = multiply3x3(LAB_TO_LMS, lab);
	const lmsCubed: V3 = [lms[0] ** 3, lms[1] ** 3, lms[2] ** 3];
	return multiply3x3(TO_SRGB_LINEAR, lmsCubed);
}

/** Convert from linear RGB to Oklab. */
function linearRGBToOklab(rgb: V3): V3 {
	const lms = multiply3x3(TO_LMS, rgb);
	const lmsRoot: V3 = [Math.cbrt(lms[0]), Math.cbrt(lms[1]), Math.cbrt(lms[2])];
	return multiply3x3(LMS_TO_LAB, lmsRoot);
}

/**
 * Finds the maximum saturation possible for a given hue that fits in RGB.
 * Saturation here is defined as `S = C/L`. `a` and `b` must be normalized so
 * `a^2 + b^2 == 1`. Max saturation will be when one of r, g or b goes below zero.
 */
function computeMaxSaturation(a: number, b: number): number {
	// Select different coefficients depending on which component goes below
	// zero first.
	let k0: number, k1: number, k2: number, k3: number, k4: number;
	let wl: number, wm: number, ws: number;
	if (vdot(RGB_COEFF[0][0], [a, b]) > 1) {
		// Red component
		[k0, k1, k2, k3, k4] = RGB_COEFF[0][1];
		[wl, wm, ws] = TO_SRGB_LINEAR[0];
	}
	else if (vdot(RGB_COEFF[1][0], [a, b]) > 1) {
		// Green component
		[k0, k1, k2, k3, k4] = RGB_COEFF[1][1];
		[wl, wm, ws] = TO_SRGB_LINEAR[1];
	}
	else {
		// Blue component
		[k0, k1, k2, k3, k4] = RGB_COEFF[2][1];
		[wl, wm, ws] = TO_SRGB_LINEAR[2];
	}

	// Approximate max saturation using a polynomial.
	let sat = k0 + k1 * a + k2 * b + k3 * a * a + k4 * a * b;

	// Do one step Halley's method to get closer. This gives an error less than
	// 10e6, except for some blue hues where the `dS/dh` is close to infinite.
	const [klRow, kmRow, ksRow] = LAB_TO_LMS;
	const kl = vdot([klRow[1], klRow[2]], [a, b]);
	const km = vdot([kmRow[1], kmRow[2]], [a, b]);
	const ks = vdot([ksRow[1], ksRow[2]], [a, b]);

	const l_ = 1.0 + sat * kl;
	const m_ = 1.0 + sat * km;
	const s_ = 1.0 + sat * ks;

	const l = l_ ** 3;
	const m = m_ ** 3;
	const s = s_ ** 3;

	const lds = 3.0 * kl * l_ ** 2;
	const mds = 3.0 * km * m_ ** 2;
	const sds = 3.0 * ks * s_ ** 2;

	const lds2 = 6.0 * kl * kl * l_;
	const mds2 = 6.0 * km * km * m_;
	const sds2 = 6.0 * ks * ks * s_;

	const f = wl * l + wm * m + ws * s;
	const f1 = wl * lds + wm * mds + ws * sds;
	const f2 = wl * lds2 + wm * mds2 + ws * sds2;

	sat = sat - (f * f1) / (f1 * f1 - 0.5 * f * f2);

	return sat;
}

/** Finds L_cusp and C_cusp for a given hue. `a` and `b` must be normalized so `a^2 + b^2 == 1`. */
function findCusp(a: number, b: number): V2 {
	// First, find the maximum saturation (saturation `S = C/L`).
	const sCusp = computeMaxSaturation(a, b);

	// Convert to linear RGB to find the first point where at least one of r, g
	// or b >= 1.
	const rgb = oklabToLinearRGB([1, sCusp * a, sCusp * b]);
	const lCusp = spow(1.0 / Math.max(...rgb), 1 / 3);
	const cCusp = lCusp * sCusp;

	return [lCusp, cCusp];
}

/**
 * Finds the intersection of the line defined by
 * `L = L0 * (1 - t) + t * L1`, `C = t * C1` with the gamut boundary.
 * `a` and `b` must be normalized so `a^2 + b^2 == 1`.
 */
function findGamutIntersection(a: number, b: number, l1: number, c1: number, l0: number, cusp: V2): number {
	let t: number;

	// Find the intersection for upper and lower half separately.
	if ((l1 - l0) * cusp[1] - (cusp[0] - l0) * c1 <= 0.0) {
		// Lower half
		t = (cusp[1] * l0) / (c1 * cusp[0] + cusp[1] * (l0 - l1));
	}
	else {
		// Upper half
		// First intersect with triangle.
		t = (cusp[1] * (l0 - 1.0)) / (c1 * (cusp[0] - 1.0) + cusp[1] * (l0 - l1));

		// Then one step Halley's method.
		const dl = l1 - l0;
		const dc = c1;

		const [klRow, kmRow, ksRow] = LAB_TO_LMS;
		const kl = vdot([klRow[1], klRow[2]], [a, b]);
		const km = vdot([kmRow[1], kmRow[2]], [a, b]);
		const ks = vdot([ksRow[1], ksRow[2]], [a, b]);

		const ldt_ = dl + dc * kl;
		const mdt_ = dl + dc * km;
		const sdt_ = dl + dc * ks;

		// If higher accuracy is required, 2 or 3 iterations of the following
		// block can be used.
		const L = l0 * (1.0 - t) + t * l1;
		const C = t * c1;

		const l_ = L + C * kl;
		const m_ = L + C * km;
		const s_ = L + C * ks;

		const l = l_ ** 3;
		const m = m_ ** 3;
		const s = s_ ** 3;

		const ldt = 3 * ldt_ * l_ ** 2;
		const mdt = 3 * mdt_ * m_ ** 2;
		const sdt = 3 * sdt_ * s_ ** 2;

		const ldt2 = 6 * ldt_ * ldt_ * l_;
		const mdt2 = 6 * mdt_ * mdt_ * m_;
		const sdt2 = 6 * sdt_ * sdt_ * s_;

		const [rRow, gRow, bRow] = TO_SRGB_LINEAR;

		const r_ = vdot(rRow, [l, m, s]) - 1;
		const r1 = vdot(rRow, [ldt, mdt, sdt]);
		const r2 = vdot(rRow, [ldt2, mdt2, sdt2]);

		const ur = r1 / (r1 * r1 - 0.5 * r_ * r2);
		let tr = -r_ * ur;

		const g_ = vdot(gRow, [l, m, s]) - 1;
		const g1 = vdot(gRow, [ldt, mdt, sdt]);
		const g2 = vdot(gRow, [ldt2, mdt2, sdt2]);

		const ug = g1 / (g1 * g1 - 0.5 * g_ * g2);
		let tg = -g_ * ug;

		const b_ = vdot(bRow, [l, m, s]) - 1;
		const b1 = vdot(bRow, [ldt, mdt, sdt]);
		const b2 = vdot(bRow, [ldt2, mdt2, sdt2]);

		const ub = b1 / (b1 * b1 - 0.5 * b_ * b2);
		let tb = -b_ * ub;

		tr = ur >= 0.0 ? tr : floatMax;
		tg = ug >= 0.0 ? tg : floatMax;
		tb = ub >= 0.0 ? tb : floatMax;

		t += Math.min(tr, Math.min(tg, tb));
	}

	return t;
}

/** Get Cs: [C_0, C_mid, C_max]. */
function getCs(l: number, a: number, b: number): V3 {
	const cusp = findCusp(a, b);

	const cMax = findGamutIntersection(a, b, l, 1, l, cusp);
	const stMax = toSt(cusp);

	// Scale factor to compensate for the curved part of gamut shape.
	const k = cMax / Math.min(l * stMax[0], (1 - l) * stMax[1]);

	const stMid = getStMid(a, b);

	// Use a soft minimum function, instead of a sharp triangle shape to get a
	// smooth value for chroma.
	let ca = l * stMid[0];
	let cb = (1.0 - l) * stMid[1];
	const cMid = 0.9 * k * Math.sqrt(Math.sqrt(1.0 / (1.0 / ca ** 4 + 1.0 / cb ** 4)));

	// For `C_0`, the shape is independent of hue, so `ST` are constant. Values
	// picked to roughly be the average values of `ST`.
	ca = l * 0.4;
	cb = (1.0 - l) * 0.8;

	// Use a soft minimum function, instead of a sharp triangle shape to get a
	// smooth value for chroma.
	const c0 = Math.sqrt(1.0 / (1.0 / ca ** 2 + 1.0 / cb ** 2));

	return [c0, cMid, cMax];
}

/** Wrap an angle (in degrees) into [0, 360). */
function constrainAngle(h: number): number {
	return ((h % 360) + 360) % 360;
}

/** Convert Okhsl to Oklab. `hsl` = [hue deg 0-360, saturation 0-1, lightness 0-1]. */
function okhslToOklab(hsl: V3): V3 {
	const [h, s, l] = hsl;
	const L = toeInv(l);
	const hNorm = constrainAngle(h) / 360.0;

	if (L !== 0.0 && L !== 1.0 && s !== 0) {
		const a_ = Math.cos(tau * hNorm);
		const b_ = Math.sin(tau * hNorm);

		const [c0, cMid, cMax] = getCs(L, a_, b_);

		// Interpolate the three values for C so that:
		//   At s=0: dC/ds = C_0, C=0
		//   At s=0.8: C=C_mid
		//   At s=1.0: C=C_max
		const mid = 0.8;
		const midInv = 1.25;
		let t: number, k0: number, k1: number, k2: number;

		if (s < mid) {
			t = midInv * s;
			k0 = 0.0;
			k1 = mid * c0;
			k2 = 1.0 - k1 / cMid;
		}
		else {
			t = 5 * (s - 0.8);
			k0 = cMid;
			k1 = (0.2 * cMid * cMid * 1.25 * 1.25) / c0;
			k2 = 1.0 - k1 / (cMax - cMid);
		}

		const c = k0 + (t * k1) / (1.0 - k2 * t);

		return [L, c * a_, c * b_];
	}

	return [L, 0, 0];
}

/** Convert Oklab to Okhsl. Returns [hue deg 0-360 (0 if achromatic), saturation 0-1, lightness 0-1]. */
function oklabToOkhsl(lab: V3): V3 {
	// Epsilon for lightness should approach close to 32 bit lightness. Epsilon
	// for saturation just needs to be sufficiently close when denoting
	// achromatic.
	const epsilonL = 1e-7;
	const epsilonS = 1e-4;

	const [L, labA, labB] = lab;
	let s = 0.0;
	const l = toe(L);

	const c = Math.sqrt(labA * labA + labB * labB);
	let h = 0.5 + Math.atan2(-labB, -labA) / tau;

	if (l !== 0.0 && l !== 1.0 && c !== 0) {
		const a_ = labA / c;
		const b_ = labB / c;

		const [c0, cMid, cMax] = getCs(L, a_, b_);

		const mid = 0.8;
		const midInv = 1.25;
		let k0: number, k1: number, k2: number, t: number;

		if (c < cMid) {
			k1 = mid * c0;
			k2 = 1.0 - k1 / cMid;

			t = c / (k1 + k2 * c);
			s = t * mid;
		}
		else {
			k0 = cMid;
			k1 = (0.2 * cMid * cMid * midInv * midInv) / c0;
			k2 = 1.0 - k1 / (cMax - cMid);

			t = (c - k0) / (k1 + k2 * (c - k0));
			s = mid + 0.2 * t;
		}
	}

	const achromatic = Math.abs(s) < epsilonS;
	if (achromatic || l === 0.0 || Math.abs(1 - l) < epsilonL) {
		h = 0;
		// Due to floating point imprecision near lightness of 1, we can end up
		// with really high saturation around white; force it back to 0 for
		// consistency.
		if (!achromatic) {
			s = 0.0;
		}
	}
	else {
		h = constrainAngle(h * 360);
	}

	return [h, s, l];
}

// ---- sRGB gamma (color.js srgb.js transfer functions) ----

function srgbToLinear(c: number): number {
	const sign = c < 0 ? -1 : 1;
	const abs = Math.abs(c);
	if (abs <= 0.04045) {
		return c / 12.92;
	}
	return sign * Math.pow((abs + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
	const sign = c < 0 ? -1 : 1;
	const abs = Math.abs(c);
	if (abs > 0.0031308) {
		return sign * (1.055 * Math.pow(abs, 1 / 2.4) - 0.055);
	}
	return c * 12.92;
}

// ---- Public API ----

export interface OkhslColor {
	/** Hue in degrees, 0-360. */
	h: number;
	/** Saturation, 0-1. */
	s: number;
	/** Lightness, 0-1. */
	l: number;
}

/** Convert Okhsl (h 0-360, s 0-1, l 0-1) to 8-bit sRGB [r, g, b]. */
export function okhslToRgb255(h: number, s: number, l: number): [number, number, number] {
	const [L, a, b] = okhslToOklab([h, s, l]);
	const [rLin, gLin, bLin] = oklabToLinearRGB([L, a, b]);
	const clamp = (v: number): number => Math.min(255, Math.max(0, Math.round(linearToSrgb(v) * 255)));
	return [clamp(rLin), clamp(gLin), clamp(bLin)];
}

/** Convert 8-bit sRGB [r, g, b] (0-255) to Okhsl [h, s, l]. */
export function srgb255ToOkhsl(r: number, g: number, b: number): [number, number, number] {
	const lab = linearRGBToOklab([srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255)]);
	const [h, s, l] = oklabToOkhsl(lab);
	return [h, s, l];
}

/** Convert Okhsl (h 0-360, s 0-1, l 0-1) to a `#rrggbb` hex string. */
export function okhslToHex(h: number, s: number, l: number): string {
	const [r, g, b] = okhslToRgb255(h, s, l);
	const to2 = (v: number): string => v.toString(16).padStart(2, '0');
	return `#${to2(r)}${to2(g)}${to2(b)}`;
}

/** Convert a `#rrggbb` (or `#rgb`) hex string to Okhsl. */
export function hexToOkhsl(hex: string): OkhslColor {
	let value = hex.trim().replace(/^#/, '');
	if (value.length === 3) {
		value = value.split('').map((c) => c + c).join('');
	}
	const int = parseInt(value, 16);
	if (Number.isNaN(int) || value.length < 6) {
		return { h: 0, s: 0, l: 1 };
	}
	const r = (int >> 16) & 0xff;
	const g = (int >> 8) & 0xff;
	const b = int & 0xff;
	const [h, s, l] = srgb255ToOkhsl(r, g, b);
	return { h, s, l };
}
