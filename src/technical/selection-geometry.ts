import type { Point, SelectionBounds, SelectionTransform } from '../utilities/types';

export const DEFAULT_SELECTION_TRANSFORM: SelectionTransform = {
	translateX: 0,
	translateY: 0,
	rotation: 0,
	scaleX: 1,
	scaleY: 1,
};

const MIN_SCALE = 0.05;

const HANDLE_HIT_PX = 10;
const ROTATE_HANDLE_OFFSET_PX = 28; //gap between top edge and rotate handle

export type HandleHit =
	| 'move'
	| 'rotate'
	| 'corner-tl'
	| 'corner-tr'
	| 'corner-bl'
	| 'corner-br'
	| 'edge-top'
	| 'edge-bottom'
	| 'edge-left'
	| 'edge-right'
	| 'none';

function centerOf(bounds: SelectionBounds): Point {
	return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
}

// maps a document-space point into the selection's own local, unrotated, unscaled coordinate frame
function toLocal(point: Point, bounds: SelectionBounds, transform: SelectionTransform): Point {
	const center = centerOf(bounds);
	const dx = point.x - (center.x + transform.translateX);
	const dy = point.y - (center.y + transform.translateY);
	const cos = Math.cos(-transform.rotation);
	const sin = Math.sin(-transform.rotation);
	const rx = dx * cos - dy * sin;
	const ry = dx * sin + dy * cos;
	return {
		x: transform.scaleX !== 0 ? rx / transform.scaleX : rx,
		y: transform.scaleY !== 0 ? ry / transform.scaleY : ry,
	};
}

// maps a local-frame point (relative to the bounding-box center, before scale/rotate/translate) into document space
function toDocument(local: Point, bounds: SelectionBounds, transform: SelectionTransform): Point {
	const center = centerOf(bounds);
	const sx = local.x * transform.scaleX;
	const sy = local.y * transform.scaleY;
	const cos = Math.cos(transform.rotation);
	const sin = Math.sin(transform.rotation);
	const rx = sx * cos - sy * sin;
	const ry = sx * sin + sy * cos;
	return { x: center.x + transform.translateX + rx, y: center.y + transform.translateY + ry };
}

export function getTransformedCorners(bounds: SelectionBounds, transform: SelectionTransform): [Point, Point, Point, Point] {
	const hw = bounds.width / 2;
	const hh = bounds.height / 2;
	return [
		toDocument({ x: -hw, y: -hh }, bounds, transform),
		toDocument({ x: hw, y: -hh }, bounds, transform),
		toDocument({ x: hw, y: hh }, bounds, transform),
		toDocument({ x: -hw, y: hh }, bounds, transform),
	];
}

export function getTransformedPolygon(points: Point[], bounds: SelectionBounds, transform: SelectionTransform): Point[] {
	const center = centerOf(bounds);
	return points.map((point) => toDocument({ x: point.x - center.x, y: point.y - center.y }, bounds, transform));
}

export function getRotateHandlePosition(bounds: SelectionBounds, transform: SelectionTransform, zoom: number): Point {
	const hh = bounds.height / 2;
	const scaleY = Math.max(Math.abs(transform.scaleY), MIN_SCALE);
	const offset = ROTATE_HANDLE_OFFSET_PX / zoom / scaleY;
	return toDocument({ x: 0, y: -hh - offset }, bounds, transform);
}

// determines which part of the transform gizmo (if any) a document-space point is over
// for deciding what a pointerdown should start dragging
export function hitTestSelection(point: Point, bounds: SelectionBounds, transform: SelectionTransform, zoom: number): HandleHit {
	const local = toLocal(point, bounds, transform);
	const hw = bounds.width / 2;
	const hh = bounds.height / 2;
	const scaleX = Math.max(Math.abs(transform.scaleX), MIN_SCALE);
	const scaleY = Math.max(Math.abs(transform.scaleY), MIN_SCALE);
	const rx = (HANDLE_HIT_PX / zoom) / scaleX;
	const ry = (HANDLE_HIT_PX / zoom) / scaleY;

	const rotateLocalY = -hh - (ROTATE_HANDLE_OFFSET_PX / zoom) / scaleY;
	if (Math.abs(local.x) <= rx * 1.5 && Math.abs(local.y - rotateLocalY) <= ry * 1.5) {
		return 'rotate';
	}

	const nearLeft = Math.abs(local.x + hw) <= rx;
	const nearRight = Math.abs(local.x - hw) <= rx;
	const nearTop = Math.abs(local.y + hh) <= ry;
	const nearBottom = Math.abs(local.y - hh) <= ry;
	const withinX = local.x >= -hw - rx && local.x <= hw + rx;
	const withinY = local.y >= -hh - ry && local.y <= hh + ry;

	if (nearLeft && nearTop) { return 'corner-tl'; }
	if (nearRight && nearTop) { return 'corner-tr'; }
	if (nearLeft && nearBottom) { return 'corner-bl'; }
	if (nearRight && nearBottom) { return 'corner-br'; }
	if (nearTop && withinX) { return 'edge-top'; }
	if (nearBottom && withinX) { return 'edge-bottom'; }
	if (nearLeft && withinY) { return 'edge-left'; }
	if (nearRight && withinY) { return 'edge-right'; }

	if (local.x >= -hw && local.x <= hw && local.y >= -hh && local.y <= hh) {
		return 'move';
	}
	return 'none';
}

export interface SelectionDragStart {
	mode: HandleHit;
	pointerDoc: Point;
	transform: SelectionTransform;
}

function clampScale(scale: number): number {
	return Math.abs(scale) < MIN_SCALE ? Math.sign(scale || 1) * MIN_SCALE : scale;
}

// returns the new transform given how a drag started and the pointer's current document position
export function updateTransformForDrag(start: SelectionDragStart, bounds: SelectionBounds, pointerDoc: Point): SelectionTransform {
	const { mode, transform } = start;

	if (mode === 'move') {
		return {
			...transform,
			translateX: start.transform.translateX + (pointerDoc.x - start.pointerDoc.x),
			translateY: start.transform.translateY + (pointerDoc.y - start.pointerDoc.y),
		};
	}

	const center = {
		x: bounds.left + bounds.width / 2 + start.transform.translateX,
		y: bounds.top + bounds.height / 2 + start.transform.translateY,
	};

	if (mode === 'rotate') {
		const startAngle = Math.atan2(start.pointerDoc.y - center.y, start.pointerDoc.x - center.x);
		const currentAngle = Math.atan2(pointerDoc.y - center.y, pointerDoc.x - center.x);
		return { ...transform, rotation: start.transform.rotation + (currentAngle - startAngle) };
	}

	const cos = Math.cos(-start.transform.rotation);
	const sin = Math.sin(-start.transform.rotation);
	const toUnrotated = (p: Point): Point => {
		const dx = p.x - center.x;
		const dy = p.y - center.y;
		return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
	};
	const startLocal = toUnrotated(start.pointerDoc);
	const currentLocal = toUnrotated(pointerDoc);

	if (mode === 'corner-tl' || mode === 'corner-tr' || mode === 'corner-bl' || mode === 'corner-br') {
		const startDist = Math.hypot(startLocal.x, startLocal.y) || 1;
		const currentDist = Math.hypot(currentLocal.x, currentLocal.y);
		const ratio = Math.max(currentDist / startDist, MIN_SCALE);
		return { ...transform, scaleX: clampScale(start.transform.scaleX * ratio), scaleY: clampScale(start.transform.scaleY * ratio) };
	}

	if (mode === 'edge-left' || mode === 'edge-right') {
		const halfWidth = bounds.width / 2;
		if (halfWidth <= 0) {
			return transform;
		}
		const edgeDelta = currentLocal.x - startLocal.x;
		const scaleDelta = edgeDelta / (2 * halfWidth);
		const nextScaleX = mode === 'edge-right'
			? clampScale(start.transform.scaleX + scaleDelta)
			: clampScale(start.transform.scaleX - scaleDelta);

		// keeps the opposite edge fixed means when transforming by edges
		const localShiftX = edgeDelta * 0.5;
		const worldShiftX = localShiftX * Math.cos(start.transform.rotation);
		const worldShiftY = localShiftX * Math.sin(start.transform.rotation);

		return {
			...transform,
			scaleX: nextScaleX,
			translateX: start.transform.translateX + worldShiftX,
			translateY: start.transform.translateY + worldShiftY,
		};
	}
	if (mode === 'edge-top' || mode === 'edge-bottom') {
		const halfHeight = bounds.height / 2;
		if (halfHeight <= 0) {
			return transform;
		}
		const edgeDelta = currentLocal.y - startLocal.y;
		const scaleDelta = edgeDelta / (2 * halfHeight);
		const nextScaleY = mode === 'edge-bottom'
			? clampScale(start.transform.scaleY + scaleDelta)
			: clampScale(start.transform.scaleY - scaleDelta);

		const localShiftY = edgeDelta * 0.5;
		const worldShiftX = -localShiftY * Math.sin(start.transform.rotation);
		const worldShiftY = localShiftY * Math.cos(start.transform.rotation);

		return {
			...transform,
			scaleY: nextScaleY,
			translateX: start.transform.translateX + worldShiftX,
			translateY: start.transform.translateY + worldShiftY,
		};
	}

	return transform;
}
