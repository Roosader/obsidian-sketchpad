import { getRotateHandlePosition, getTransformedCorners, getTransformedPolygon } from '../technical/selection-geometry';
import { ROTATE_HANDLE_ICON } from '../utilities/constants';
import type { Point, SelectionBounds, SelectionTransform } from '../utilities/types';

export interface GizmoScreenContext {
	zoom: number;
	rotation: number; // degrees
	panX: number;
	panY: number;
	flipX: boolean;
	flipY: boolean;
	docWidth: number;
	docHeight: number;
	panelWidth: number;
	panelHeight: number;
	devicePixelRatio: number;
}

export function createSelectionOverlay(container: HTMLElement): HTMLCanvasElement {
	return container.createEl('canvas', { cls: 'sketchpad-selection-overlay' });
}

export function resizeSelectionOverlay(canvas: HTMLCanvasElement, panel: HTMLElement): void {
	const dpr = window.devicePixelRatio || 1;
	const rect = panel.getBoundingClientRect();
	const width = Math.max(1, Math.round(rect.width * dpr));
	const height = Math.max(1, Math.round(rect.height * dpr));
	if (canvas.width !== width) { canvas.width = width; }
	if (canvas.height !== height) { canvas.height = height; }
}

export function clearSelectionOverlay(canvas: HTMLCanvasElement): void {
	const ctx = canvas.getContext('2d');
	if (!ctx) { return; }
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// sets the 2D context's transform so the selection gizmo lines up with the canvas underneath it
function applyDocTransform(ctx: CanvasRenderingContext2D, screen: GizmoScreenContext): void {
	const centerX = screen.docWidth / 2;
	const centerY = screen.docHeight / 2;
	const left = (screen.panelWidth - screen.docWidth) / 2;
	const top = (screen.panelHeight - screen.docHeight) / 2;
	const scaleX = screen.zoom * (screen.flipX ? -1 : 1);
	const scaleY = screen.zoom * (screen.flipY ? -1 : 1);
	ctx.setTransform(screen.devicePixelRatio, 0, 0, screen.devicePixelRatio, 0, 0);
	ctx.translate(left + screen.panX + centerX, top + screen.panY + centerY);
	ctx.rotate((screen.rotation * Math.PI) / 180);
	ctx.scale(scaleX, scaleY);
	ctx.translate(-centerX, -centerY);
}

// keeps the handles and rotate icon a constant size on screen
function docToDevice(screen: GizmoScreenContext, x: number, y: number): Point {
	const cx = x - screen.docWidth / 2;
	const cy = y - screen.docHeight / 2;
	const scaleX = screen.zoom * (screen.flipX ? -1 : 1);
	const scaleY = screen.zoom * (screen.flipY ? -1 : 1);
	const sx = cx * scaleX;
	const sy = cy * scaleY;
	const rad = (screen.rotation * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	const rx = sx * cos - sy * sin;
	const ry = sx * sin + sy * cos;
	const left = (screen.panelWidth - screen.docWidth) / 2;
	const top = (screen.panelHeight - screen.docHeight) / 2;
	return {
		x: (rx + screen.panX + left + screen.docWidth / 2) * screen.devicePixelRatio,
		y: (ry + screen.panY + top + screen.docHeight / 2) * screen.devicePixelRatio,
	};
}

// draws the path while the user is dragging the lasso tool
export function drawLassoPath(canvas: HTMLCanvasElement, points: Point[], screen: GizmoScreenContext): void {
	const ctx = canvas.getContext('2d');
	if (!ctx) { return; }
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	if (points.length < 2) { return; }
	applyDocTransform(ctx, screen);
	drawMarchingAnts(ctx, points, false, screen.zoom);
}

const HANDLE_RADIUS = 5;         
const ROTATE_HANDLE_RADIUS = 15; 

export function drawSelectionGizmo(
	canvas: HTMLCanvasElement,
	polygon: Point[],
	bounds: SelectionBounds,
	transform: SelectionTransform,
	screen: GizmoScreenContext,
): void {
	const ctx = canvas.getContext('2d');
	if (!ctx) { return; }
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, canvas.width, canvas.height);

	const corners = getTransformedCorners(bounds, transform);
	const outline = getTransformedPolygon(polygon, bounds, transform);
	const rotateHandle = getRotateHandlePosition(bounds, transform, screen.zoom);

	applyDocTransform(ctx, screen);
	drawMarchingAnts(ctx, outline, true, screen.zoom);

	// bounding-box edges + rotate connector
	const dpr = screen.devicePixelRatio;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	const rectPts = corners.map((corner) => {
		const dev = docToDevice(screen, corner.x, corner.y);
		return { x: dev.x / dpr, y: dev.y / dpr };
	});
	const topMid = {
		x: (rectPts[0]!.x + rectPts[1]!.x) / 2,
		y: (rectPts[0]!.y + rectPts[1]!.y) / 2,
	};
	const rotateDev = docToDevice(screen, rotateHandle.x, rotateHandle.y);
	const rotatePos = { x: rotateDev.x / dpr, y: rotateDev.y / dpr };

	ctx.setLineDash([]);
	ctx.strokeStyle = '#ffffff';
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.moveTo(rectPts[0]!.x, rectPts[0]!.y);
	for (const corner of rectPts.slice(1)) { ctx.lineTo(corner.x, corner.y); }
	ctx.closePath();
	ctx.stroke();

	ctx.strokeStyle = '#02b0f5';
	ctx.beginPath();
	ctx.moveTo(rectPts[0]!.x + 1, rectPts[0]!.y + 1);
	for (const corner of rectPts.slice(1)) { ctx.lineTo(corner.x + 1, corner.y + 1); }
	ctx.closePath();
	ctx.stroke();

	ctx.beginPath();
	ctx.moveTo(topMid.x, topMid.y);
	ctx.lineTo(rotatePos.x, rotatePos.y);
	ctx.stroke();

	const midpoints = [
		{ x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 },
		{ x: (corners[1].x + corners[2].x) / 2, y: (corners[1].y + corners[2].y) / 2 },
		{ x: (corners[2].x + corners[3].x) / 2, y: (corners[2].y + corners[3].y) / 2 },
		{ x: (corners[3].x + corners[0].x) / 2, y: (corners[3].y + corners[0].y) / 2 },
	];

	// handles + rotate icon
	for (const handle of [...corners, ...midpoints]) {
		const pos = docToDevice(screen, handle.x, handle.y);
		drawHandleSquare(ctx, { x: pos.x / dpr, y: pos.y / dpr }, HANDLE_RADIUS);
	}
	drawRotateHandle(ctx, rotatePos, ROTATE_HANDLE_RADIUS);
}

function drawMarchingAnts(ctx: CanvasRenderingContext2D, points: Point[], close: boolean, zoom: number): void {
	if (points.length < 2) { return; }
	const path = new Path2D();
	path.moveTo(points[0]!.x, points[0]!.y);
	for (const point of points.slice(1)) { path.lineTo(point.x, point.y); }
	if (close) { path.closePath(); }

	const k = 1 / Math.max(zoom, 0.001);
	ctx.lineWidth = k;
	ctx.setLineDash([8 * k, 8 * k]); // 4px on, 4px off of dashes
	ctx.lineDashOffset = 0;
	ctx.strokeStyle = '#000000';
	ctx.stroke(path);
	ctx.lineDashOffset =8 * k; //offset the white stroke, must be equal the first number of setLineDash
	ctx.strokeStyle = '#ffffff';
	ctx.stroke(path);
}

function drawHandleSquare(ctx: CanvasRenderingContext2D, center: Point, radius: number): void {
	ctx.fillStyle = '#ffffff';
	ctx.strokeStyle = '#000000';
	ctx.lineWidth = 1;
	ctx.fillRect(center.x - radius, center.y - radius, radius * 2, radius * 2);
	ctx.strokeRect(center.x - radius, center.y - radius, radius * 2, radius * 2);
}


const rotateHandleIcon = new Image();
rotateHandleIcon.src = ROTATE_HANDLE_ICON;

function drawRotateHandle(ctx: CanvasRenderingContext2D, center: Point, radius: number): void {
	if (rotateHandleIcon.complete && rotateHandleIcon.naturalWidth > 0) {
		ctx.drawImage(rotateHandleIcon, center.x - radius, center.y - radius, radius * 2, radius * 2);
	}
}
