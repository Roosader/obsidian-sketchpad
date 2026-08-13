import {
	buildPressureCurveSampler,
	clampPressureCurve,
	clonePressureCurve,
	type PressureControlPoint,
	type PressureCurve,
} from '../technical/pressure-curve';
import {PRESSURE_POINT_SIZE} from '../utilities/constants';

export interface PressureCurveEditor {
	canvas: HTMLCanvasElement;
	setCurve(curve: PressureCurve): void;
}

export function buildPressureCurveEditor(
	container: HTMLElement,
	initialCurve: PressureCurve,
	onChange: (curve: PressureCurve) => void,
): PressureCurveEditor {
	const canvas = container.createEl('canvas', { cls: 'sketchpad-pressure-curve' });

	const SIZE = canvas.clientWidth || canvas.width;
	canvas.width = SIZE;
	canvas.height = SIZE;
	canvas.title = 'Pressure response curve - drag the five points to change how pressure maps to size/opacity';

	let curve: PressureCurve = clampPressureCurve(initialCurve);
	let activePointIndex: 0 | 1 | 2 | 3 | 4 | null = null;
	const plotSize = SIZE;

	function toCanvasPoint(curvePoint: PressureControlPoint): { x: number; y: number } {
		return {
			x: curvePoint.x * plotSize,
			// Canvas y grows downward, the curve's y (intensity) grows upward
			y: (1 - curvePoint.y) * plotSize,
		};
	}

	function fromCanvasPoint(x: number, y: number): PressureControlPoint {
		return {
			x: x / plotSize,
			y: 1 - y / plotSize,
		};
	}

	function cssColor(name: string): string {
		const styles = getComputedStyle(canvas);
		const value = styles.getPropertyValue(name);
		return value;
	}

	function draw(): void {
		const context = canvas.getContext('2d');
		if (!context) {
			return;
		}
		context.clearRect(0, 0, SIZE, SIZE);

		// 4x4 background grid
		context.strokeStyle = cssColor('--grid-color');
		context.lineWidth = 1;
		context.beginPath();
		for (let i = 1; i < 4; i += 1) {
			const pos = (plotSize / 4) * i;
			context.moveTo(pos, 0);
			context.lineTo(pos, plotSize);
			context.moveTo(0, pos);
			context.lineTo(plotSize, pos);
		}
		context.stroke();

		context.strokeStyle = cssColor('--curve-color');
		context.lineWidth = 2;
		context.beginPath();
		const sampler = buildPressureCurveSampler(curve);
		const steps = 24; // maybe put in this constants later
		for (let i = 0; i <= steps; i++) {
			const pressure = i / steps;
			const intensity = sampler.evaluate(pressure);
			const point = toCanvasPoint({ x: pressure, y: intensity });
			if (i === 0) {
				context.moveTo(point.x, point.y);
			} else {
				context.lineTo(point.x, point.y);
			}
		}
		context.stroke();

		for (let i = 0; i < curve.points.length; i += 1) {
			const control = toCanvasPoint(curve.points[i]!);
			const isEdgePoint = i === 0 || i === curve.points.length - 1;
			const isActivePoint = i === activePointIndex;
			context.fillStyle = isActivePoint ? cssColor('--point-active-color') : cssColor('--point-color');
			context.beginPath();
			if (isEdgePoint) {
				// Edge-locked points render as squares to signal they only move vertically.
				const width = PRESSURE_POINT_SIZE * 1.5;
				context.rect(control.x - width / 2, control.y - width / 2, width, width);
			} else {
				context.arc(control.x, control.y, PRESSURE_POINT_SIZE / 2, 0, Math.PI * 2);
			}
			context.fill();
		}
	}

	function nearestControlPointIndex(canvasX: number, canvasY: number): 0 | 1 | 2 | 3 | 4 {
		let bestIndex: 0 | 1 | 2 | 3 | 4 = 0;
		let bestDistanceSq = Number.POSITIVE_INFINITY;
		for (let i = 0; i < curve.points.length; i += 1) {
			const point = toCanvasPoint(curve.points[i]!);
			const dx = canvasX - point.x;
			const dy = canvasY - point.y;
			const distanceSq = dx * dx + dy * dy;
			if (distanceSq < bestDistanceSq) {
				bestDistanceSq = distanceSq;
				bestIndex = i as 0 | 1 | 2 | 3 | 4;
			}
		}
		return bestIndex;
	}

	function mutateActivePoint(canvasX: number, canvasY: number): void {
		if (activePointIndex === null) {
			return;
		}
		const nextCurve = clonePressureCurve(curve);
		const nextPoint = fromCanvasPoint(canvasX, canvasY);
		if (activePointIndex === 0 || activePointIndex === curve.points.length - 1) {
			// Edge-locked points only move vertically, setting the responseat the minimum (left) or maximum (right) pressure.
			nextPoint.x = activePointIndex === 0 ? 0 : 1;
		}
		nextCurve.points[activePointIndex] = nextPoint;
		curve = clampPressureCurve(nextCurve);
	}

	function handleDrag(event: PointerEvent): void {
		const rect = canvas.getBoundingClientRect();
		const scaleX = SIZE / rect.width;
		const scaleY = SIZE / rect.height;
		const canvasX = (event.clientX - rect.left) * scaleX;
		const canvasY = (event.clientY - rect.top) * scaleY;
		mutateActivePoint(canvasX, canvasY);
		draw();
		onChange(curve);
	}

	canvas.addEventListener('pointerdown', (event) => {
		const rect = canvas.getBoundingClientRect();
		const scaleX = SIZE / rect.width;
		const scaleY = SIZE / rect.height;
		const canvasX = (event.clientX - rect.left) * scaleX;
		const canvasY = (event.clientY - rect.top) * scaleY;
		activePointIndex = nearestControlPointIndex(canvasX, canvasY);
		canvas.setPointerCapture(event.pointerId);
		handleDrag(event);
	});
	canvas.addEventListener('pointermove', (event) => {
		if ((event.buttons & 1) !== 0) {
			handleDrag(event);
		}
	});
	canvas.addEventListener('pointerup', (event) => {
		activePointIndex = null;
		canvas.releasePointerCapture(event.pointerId);
		draw();
	});

	draw();

	return {
		canvas,
		setCurve(newCurve: PressureCurve) {
			curve = clampPressureCurve(newCurve);
			activePointIndex = null;
			draw();
		},
	};
}
