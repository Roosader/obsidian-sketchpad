import {clampRotation, clampZoom, cssTransformFor, fitToView, DEFAULT_VIEW_TRANSFORM, type ViewTransform,} from './view-transform';
import { syncViewControls, type ViewControlElements } from '../ui/left-sidebar';
import {toolCursorClasses, ROTATE_TOOL_SENSITIVITY, ZOOM_TOOL_SENSITIVITY, ZOOM_TOOL_CLICK_FACTOR, WHEEL_ZOOM_FACTOR,} from '../utilities/constants';
import type { Point, ViewTool } from '../utilities/types';

export interface ViewportDeps {
	canvas: HTMLCanvasElement;
	canvasPanel: HTMLElement;
	canvasStack: HTMLDivElement;
	getDocumentSize: () => { width: number; height: number };
	getCurrentTool: () => ViewTool;
	getViewControls: () => ViewControlElements | undefined;
	isActive: () => boolean;
	isTouchToDrawEnabled: () => boolean;

	refreshCursorOverlay?: () => void;	// called when the custom tool cursor should be redrawn

	onViewTransformChange?: () => void; //called on zoom/rotate/flip/fit

	onTouchTap?: (fingerCount: number) => void; //for multi-touch undo/redo

	// fired when a second finger lands while touch-to-draw is enabled
	onMultiTouchGestureStart?: (wasTapCandidate: boolean) => void;
}

const TOUCH_TAP_MOVE_PX = 12; // max any finger may drift from its down point (screen CSS px)
const TOUCH_TAP_DURATION_MS = 500; // max first-finger-down -> last-finger-up for a tap

export class CanvasViewport {
	view: ViewTransform = { ...DEFAULT_VIEW_TRANSFORM };

	isPanning = false;
	isZooming = false;
	isRotating = false;
	viewGestureSource: 'canvas' | 'panel' | null = null;

	private panStart = { x: 0, y: 0, panX: 0, panY: 0 };
	private zoomStart = {
		x: 0,
		y: 0,
		zoom: 1,
		anchor: { x: 0, y: 0 },
		anchorScreen: { x: 0, y: 0 },
		stackCenter: { x: 0, y: 0 },
	};
	private rotatePreviousAngle = 0;
	// cached screen-space center of the canvas stack (transform-origin), which
	// only changes when the panel or stack geometry changes, not while drawing
	private cachedStackCenter: { x: number; y: number } | null = null;
	private activeTouchPoints = new Map<number, { x: number; y: number }>();
	private touchPanStart: { x: number; y: number; panX: number; panY: number } | null = null;
	private touchGestureStart: {
		anchorDoc: Point;
		startMidX: number;
		startMidY: number;
		startDistance: number;
		startAngle: number;
		startZoom: number;
		startRotation: number;
	} | null = null;

	private touchTapDownPositions = new Map<number, { x: number; y: number }>();
	private touchTapActive = false;
	private touchTapMaxPoints = 0;
	private touchTapStartTime = 0;
	private touchTapMoved = false;
	private touchGestureActive = false;

	constructor(private readonly deps: ViewportDeps) {}

	private get size(): { width: number; height: number } {
		return this.deps.getDocumentSize();
	}

	// center of the canvas-stack box in screen coordinates
	// transform anchor for zoom, flip
	private getStackCenter(): { x: number; y: number } {
		if (!this.cachedStackCenter) {
			this.cachedStackCenter = this.computeStackCenter();
		}
		return this.cachedStackCenter;
	}

	private computeStackCenter(): { x: number; y: number } {
		const panelRect = this.deps.canvasPanel.getBoundingClientRect();
		return {
			x: panelRect.left + this.deps.canvasStack.offsetLeft + this.size.width / 2,
			y: panelRect.top + this.deps.canvasStack.offsetTop + this.size.height / 2,
		};
	}

	// the cached stack center depends on the panel's screen position and the
	// stack's size/position, none of which change while drawing. Call this
	// whenever those could have changed so the next read recomputes fresh.
	invalidateGeometryCache(): void {
		this.cachedStackCenter = null;
	}

	// center of the canvas panel (the on-screen viewport) in screen coordinates. 
	// anchor for rotation pivot
	private getPanelCenter(): { x: number; y: number } {
		const rect = this.deps.canvasPanel.getBoundingClientRect();
		return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
	}

	// routes pointer capture to whichever element actually received the
	// gesture (the canvas or its wrapping panel), so moves keep flowing to
	// the right element even when the pointer leaves it.
	private capturePointer(event: PointerEvent): void {
		if (this.viewGestureSource === 'panel') {
			this.deps.canvasPanel.setPointerCapture(event.pointerId);
		} else {
			this.deps.canvas.setPointerCapture(event.pointerId);
		}
	}

	private releasePointer(event: PointerEvent): void {
		if (this.viewGestureSource === 'panel') {
			this.deps.canvasPanel.releasePointerCapture(event.pointerId);
		} else {
			this.deps.canvas.releasePointerCapture(event.pointerId);
		}
	}

	// wraps a raw angle delta (radians) into (-π, π] so rotation never jumps
	// a full turn when the pointer crosses the ±π boundary.
	private wrapAngleDelta(delta: number): number {
		if (delta > Math.PI) {
			delta -= 2 * Math.PI;
		}
		if (delta < -Math.PI) {
			delta += 2 * Math.PI;
		}
		return delta;
	}

	/* Panning functions */
	beginPan(event: PointerEvent): void {
		this.isPanning = true;
		this.viewGestureSource = event.target === this.deps.canvas ? 'canvas' : 'panel';
		this.panStart = { x: event.clientX, y: event.clientY, panX: this.view.panX, panY: this.view.panY };
		this.capturePointer(event);
	}

	updatePan(event: PointerEvent): void {
		this.view.panX = this.panStart.panX + (event.clientX - this.panStart.x);
		this.view.panY = this.panStart.panY + (event.clientY - this.panStart.y);
		this.applyViewTransform();
		// move the selection gizmo with the image when panning
		this.deps.onViewTransformChange?.();
	}

	endPan(event: PointerEvent): void {
		this.updatePan(event);
		this.isPanning = false;
		this.releasePointer(event);
		this.viewGestureSource = null;
	}


	/* Zoom functions */
	setZoom(zoom: number): void {
		const clamped = clampZoom(zoom);
		if (clamped === this.view.zoom) {
			return;
		}
		const center = this.getPanelCenter();
		const anchorDoc = this.getPointFromClient(center.x, center.y);
		this.applyZoomAt(clamped, anchorDoc, center, this.getStackCenter());
	}

	beginZoom(event: PointerEvent): void {
		this.isZooming = true;
		const stackCenter = this.getStackCenter();
		this.zoomStart = {
			x: event.clientX,
			y: event.clientY,
			zoom: this.view.zoom,
			anchor: this.getPoint(event),
			anchorScreen: { x: event.clientX, y: event.clientY },
			stackCenter,
		};
		this.deps.canvas.setPointerCapture(event.pointerId);
	}

	updateZoom(event: PointerEvent): void {
		const dx = event.clientX - this.zoomStart.x;
		const zoomFactor = Math.exp(dx * ZOOM_TOOL_SENSITIVITY);
		const newZoom = clampZoom(this.zoomStart.zoom * zoomFactor);
		this.zoomAtPointer(newZoom);
	}

	endZoom(event: PointerEvent): void {
		this.isZooming = false;
		const dx = event.clientX - this.zoomStart.x;
		const dy = event.clientY - this.zoomStart.y;

		if (Math.hypot(dx, dy) < 4) {
			if (this.deps.getCurrentTool() === 'zoom-in') {
				this.zoomAtPointer(this.view.zoom * ZOOM_TOOL_CLICK_FACTOR);
			} else {
				this.zoomAtPointer(this.view.zoom / ZOOM_TOOL_CLICK_FACTOR);
			}
		} else {
			this.updateZoom(event);
			this.updateViewControlsUI();
		}

		this.deps.canvas.releasePointerCapture(event.pointerId);
	}

	private zoomAtPointer(newZoom: number): void {
		this.applyZoomAt(newZoom, this.zoomStart.anchor, this.zoomStart.anchorScreen, this.zoomStart.stackCenter);
	}

	private applyZoomAt(
		newZoom: number,
		anchor: Point,
		anchorScreen: { x: number; y: number },
		stackCenter: { x: number; y: number },
	): void {
		const scaleX = this.view.flipX ? -newZoom : newZoom;
		const scaleY = this.view.flipY ? -newZoom : newZoom;
		const docCenterX = this.size.width / 2;
		const docCenterY = this.size.height / 2;
		const angle = (this.view.rotation * Math.PI) / 180;
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);

		const rotatedX = (anchor.x - docCenterX) * scaleX * cos - (anchor.y - docCenterY) * scaleY * sin;
		const rotatedY = (anchor.x - docCenterX) * scaleX * sin + (anchor.y - docCenterY) * scaleY * cos;

		this.view.zoom = newZoom;
		this.view.panX = anchorScreen.x - stackCenter.x - rotatedX;
		this.view.panY = anchorScreen.y - stackCenter.y - rotatedY;
		this.applyViewTransform();
		this.updateViewControlsUI();
	}

	// mouse-wheel up zooms in, down zooms out, 
	handleWheel = (event: WheelEvent): void => {
		if (!this.deps.isActive()) {
			return;
		}
		this.invalidateGeometryCache();
		event.preventDefault();
		const factor = event.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
		const newZoom = clampZoom(this.view.zoom * factor);
		if (newZoom === this.view.zoom) {
			return;
		}
		const anchor = this.getPointFromClient(event.clientX, event.clientY);
		const anchorScreen = { x: event.clientX, y: event.clientY };
		this.applyZoomAt(newZoom, anchor, anchorScreen, this.getStackCenter());
	};

	/* Rotation functions */
	beginRotate(event: PointerEvent): void {
		this.isRotating = true;
		this.viewGestureSource = event.target === this.deps.canvas ? 'canvas' : 'panel';

		const center = this.getPanelCenter();
		this.rotatePreviousAngle = Math.atan2(event.clientY - center.y, event.clientX - center.x);

		this.capturePointer(event);
	}

	updateRotate(event: PointerEvent): void {
		const center = this.getPanelCenter();

		const angle = Math.atan2(event.clientY - center.y, event.clientX - center.x) * ROTATE_TOOL_SENSITIVITY;

		// Keep the angle delta in (-π, π].
		const delta = this.wrapAngleDelta(angle - this.rotatePreviousAngle);

		this.rotatePreviousAngle = angle;

		this.rotateAroundScreenCenter((delta * 180) / Math.PI);
	}

	endRotate(event: PointerEvent): void {
		this.updateRotate(event);
		this.isRotating = false;
		this.releasePointer(event);
		this.viewGestureSource = null;
	}

	setRotation(rotation: number): void {
		const clamped = clampRotation(rotation);
		if (clamped === this.view.rotation) {
			return;
		}
		const center = this.getPanelCenter();
		const anchorDoc = this.getPointFromClient(center.x, center.y);
		this.applyAnchoredViewTransform(anchorDoc, center, this.view.zoom, clamped);
	}

	// rotates the canvas by the given number of degrees (counter-clockwise
	// for negative values), normalizing to (-180, 180].
	rotateBy(degrees: number): void {
		this.rotateAroundScreenCenter(degrees);
	}

	private rotateAroundScreenCenter(degrees: number): void {
		const center = this.getPanelCenter();
		const anchorDoc = this.getPointFromClient(center.x, center.y);
		const newRotation = clampRotation(this.normalizeDegrees(this.view.rotation + degrees));
		this.applyAnchoredViewTransform(anchorDoc, center, this.view.zoom, newRotation);
	}


	// flips the canvas around the center of the screen, not the center of the image
	toggleFlip(axis: 'flipX' | 'flipY'): void {
		this.view[axis] = !this.view[axis];
		this.view.rotation = -this.view.rotation;

		const panelCenter = this.getPanelCenter();
		const stackCenter = this.getStackCenter();
		if (axis === 'flipX') {
			this.view.panX = 2 * (panelCenter.x - stackCenter.x) - this.view.panX;
		} else {
			this.view.panY = 2 * (panelCenter.y - stackCenter.y) - this.view.panY;
		}

		this.applyViewTransform();
		this.updateViewControlsUI();
	}

	resetView(): void {
		this.view = { ...DEFAULT_VIEW_TRANSFORM };
		this.applyViewTransform();
		this.updateViewControlsUI();
	}

	applyViewTransform(): void {
		this.deps.canvasStack.style.transform = cssTransformFor(this.view);
	}

	fitDocumentToView(): ViewTransform {
		const panelRect = this.deps.canvasPanel.getBoundingClientRect();
		return fitToView(panelRect, this.size);
	}

	fitDocumentToViewAndApply(): void {
		this.view = this.fitDocumentToView();
		this.positionCanvasStack();
		this.applyViewTransform();
		this.updateViewControlsUI();
	}

	positionCanvasStack(): void {
		const panelRect = this.deps.canvasPanel.getBoundingClientRect();
		const left = (panelRect.width - this.size.width) / 2;
		const top = (panelRect.height - this.size.height) / 2;
		this.deps.canvasStack.style.left = `${left}px`;
		this.deps.canvasStack.style.top = `${top}px`;
		this.invalidateGeometryCache();
	}

	updateViewControlsUI(): void {
		const controls = this.deps.getViewControls();
		if (controls) {
			syncViewControls(controls, this.view, this.deps.getCurrentTool());
		}

		this.deps.refreshCursorOverlay?.();
		this.deps.onViewTransformChange?.();
	}

	updateCanvasPanelCursor(): void {
		this.deps.canvasPanel.classList.remove(...toolCursorClasses);
		this.deps.canvasPanel.classList.add(`sketchpad-${this.deps.getCurrentTool()}-active`);
		this.deps.refreshCursorOverlay?.();
	}

	// converts a pointer event's viewport coordinates into document pixels
	getPoint(event: PointerEvent): Point {
		const docPoint = this.getPointFromClient(event.clientX, event.clientY);
		return { ...docPoint, pressure: this.getPressure(event) };
	}

	getPointFromClient(clientX: number, clientY: number): Point {
		// invert the canvas stack's CSS transform directly from this.view
		const center = this.getStackCenter();
		const ox = this.size.width / 2;
		const oy = this.size.height / 2;

		const scaleX = this.view.flipX ? -this.view.zoom : this.view.zoom;
		const scaleY = this.view.flipY ? -this.view.zoom : this.view.zoom;
		const angle = (this.view.rotation * Math.PI) / 180;
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);

		// undo translate
		const rx = clientX - center.x - this.view.panX;
		const ry = clientY - center.y - this.view.panY;

		// undo rotate
		const sx = rx * cos + ry * sin;
		const sy = -rx * sin + ry * cos;

		// undo scale/flip and add back the local origin
		return {
			x: sx / scaleX + ox,
			y: sy / scaleY + oy,
		};
	}

	getPressure(event: PointerEvent): number {
		if (event.pointerType !== 'pen') {
			return 1;
		}
		return event.pressure;
	}

	/* touch input handling */
	isTouchDrawActive(): boolean {
		return !this.touchGestureActive && this.activeTouchPoints.size === 1;
	}

	tryHandleTouchPointerDown(event: PointerEvent): boolean {
		if (event.pointerType !== 'touch') {
			return false;
		}

		event.preventDefault();
		// The first finger of a gesture starts a fresh tap candidate.
		if (this.activeTouchPoints.size === 0) {
			this.touchTapActive = true;
			this.touchTapMaxPoints = 1;
			this.touchTapStartTime = performance.now();
			this.touchTapMoved = false;
			this.touchGestureActive = !this.deps.isTouchToDrawEnabled();
		}
		this.activeTouchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
		this.touchTapDownPositions.set(event.pointerId, { x: event.clientX, y: event.clientY });
		this.touchTapMaxPoints = Math.max(this.touchTapMaxPoints, this.activeTouchPoints.size);

		if (this.activeTouchPoints.size >= 2) {
			// a second finger arrived mid-stroke: switch to a view gesture and
			// preserve or discard the in-progress one-finger stroke.
			if (!this.touchGestureActive) {
				this.touchGestureActive = true;
				this.deps.onMultiTouchGestureStart?.(!this.touchTapMoved);
			}
			this.initializeTouchTransformGesture();
			return true;
		}

		if (this.touchGestureActive) {
			this.initializeTouchPanGesture();
			return true;
		}

		// single finger + touch-to-draw enabled: let the drawing controller handle it
		return false;
	}

	tryHandleTouchPointerMove(event: PointerEvent): boolean {
		if (event.pointerType !== 'touch') {
			return false;
		}

		if (!this.activeTouchPoints.has(event.pointerId)) {
			return true;
		}

		event.preventDefault();
		this.activeTouchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });

		// movement beyond the tap slop disqualifies the gesture as a tap
		// the flag is sticky so it can't re-validate mid-gesture
		if (this.touchTapActive) {
			const down = this.touchTapDownPositions.get(event.pointerId);
			if (
				down &&
				Math.hypot(event.clientX - down.x, event.clientY - down.y) > TOUCH_TAP_MOVE_PX
			) {
				this.touchTapMoved = true;
			}
		}

		if (!this.touchGestureActive) {
			return false;
		}

		if (this.activeTouchPoints.size >= 2) {
			this.updateTouchTransformGesture();
		} else {
			this.updateTouchPanGesture();
		}

		return true;
	}

	tryHandleTouchPointerUp(event: PointerEvent): boolean {
		if (event.pointerType !== 'touch') {
			return false;
		}

		event.preventDefault();

		if (event.type === 'pointercancel') {
			this.touchTapActive = false;
		}
		this.activeTouchPoints.delete(event.pointerId);
		this.touchTapDownPositions.delete(event.pointerId);

		if (!this.touchGestureActive) {
			this.resetTouchGestureState();
			return false;
		}

		if (this.activeTouchPoints.size >= 2) {
			this.initializeTouchTransformGesture();
			return true;
		}

		if (this.activeTouchPoints.size === 1) {
			this.initializeTouchPanGesture();
			return true;
		}

		// evaluate the tap candidate (2- or 3-finger tap)
		if (
			this.touchTapActive &&
			!this.touchTapMoved &&
			this.touchTapMaxPoints >= 2 &&
			this.touchTapMaxPoints <= 3 &&
			performance.now() - this.touchTapStartTime <= TOUCH_TAP_DURATION_MS
		) {
			this.deps.onTouchTap?.(this.touchTapMaxPoints);
		}
		this.resetTouchGestureState();
		return true;
	}

	private resetTouchGestureState(): void {
		this.touchGestureActive = false;
		this.touchTapActive = false;
		this.touchTapMaxPoints = 0;
		this.touchTapStartTime = 0;
		this.touchTapMoved = false;
		this.touchPanStart = null;
		this.touchGestureStart = null;
	}

	private initializeTouchPanGesture(): void {
		const firstPoint = this.activeTouchPoints.values().next().value;
		if (!firstPoint) {
			this.touchPanStart = null;
			return;
		}
		this.touchPanStart = {
			x: firstPoint.x,
			y: firstPoint.y,
			panX: this.view.panX,
			panY: this.view.panY,
		};
		this.touchGestureStart = null;
	}

	private updateTouchPanGesture(): void {
		if (!this.touchPanStart) {
			this.initializeTouchPanGesture();
		}
		const firstPoint = this.activeTouchPoints.values().next().value;
		if (!firstPoint || !this.touchPanStart) {
			return;
		}

		this.view.panX = this.touchPanStart.panX + (firstPoint.x - this.touchPanStart.x);
		this.view.panY = this.touchPanStart.panY + (firstPoint.y - this.touchPanStart.y);
		this.applyViewTransform();
		this.updateViewControlsUI();
	}

	private initializeTouchTransformGesture(): void {
		const points = Array.from(this.activeTouchPoints.values());
		if (points.length < 2) {
			this.touchGestureStart = null;
			return;
		}

		const first = points[0];
		const second = points[1];
		if (!first || !second) {
			this.touchGestureStart = null;
			return;
		}
		const startMidX = (first.x + second.x) / 2;
		const startMidY = (first.y + second.y) / 2;
		const dx = second.x - first.x;
		const dy = second.y - first.y;
		const startDistance = Math.max(1, Math.hypot(dx, dy));
		const startAngle = Math.atan2(dy, dx);

		this.touchPanStart = null;
		this.touchGestureStart = {
			anchorDoc: this.getPointFromClient(startMidX, startMidY),
			startMidX,
			startMidY,
			startDistance,
			startAngle,
			startZoom: this.view.zoom,
			startRotation: this.view.rotation,
		};
	}

	private updateTouchTransformGesture(): void {
		if (!this.touchGestureStart) {
			this.initializeTouchTransformGesture();
		}
		const points = Array.from(this.activeTouchPoints.values());
		if (points.length < 2 || !this.touchGestureStart) {
			return;
		}

		const first = points[0];
		const second = points[1];
		if (!first || !second) {
			return;
		}
		const midX = (first.x + second.x) / 2;
		const midY = (first.y + second.y) / 2;
		const dx = second.x - first.x;
		const dy = second.y - first.y;
		const distance = Math.max(1, Math.hypot(dx, dy));
		const angle = Math.atan2(dy, dx);

		const zoomRatio = distance / this.touchGestureStart.startDistance;
		const zoom = clampZoom(this.touchGestureStart.startZoom * zoomRatio);

		const deltaRadians = this.wrapAngleDelta(angle - this.touchGestureStart.startAngle);
		const deltaDegrees = (deltaRadians * 180) / Math.PI;
		const rotation = clampRotation(this.normalizeDegrees(this.touchGestureStart.startRotation + deltaDegrees));

		this.applyAnchoredViewTransform(this.touchGestureStart.anchorDoc, { x: midX, y: midY }, zoom, rotation);
	}

	private applyAnchoredViewTransform(
		anchorDoc: Point,
		anchorScreen: { x: number; y: number },
		zoom: number,
		rotation: number,
	): void {
		const stackCenter = this.getStackCenter();

		const scaleX = this.view.flipX ? -zoom : zoom;
		const scaleY = this.view.flipY ? -zoom : zoom;
		const docCenterX = this.size.width / 2;
		const docCenterY = this.size.height / 2;
		const angle = (rotation * Math.PI) / 180;
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);

		const rotatedX = (anchorDoc.x - docCenterX) * scaleX * cos - (anchorDoc.y - docCenterY) * scaleY * sin;
		const rotatedY = (anchorDoc.x - docCenterX) * scaleX * sin + (anchorDoc.y - docCenterY) * scaleY * cos;

		this.view.zoom = zoom;
		this.view.rotation = rotation;
		this.view.panX = anchorScreen.x - stackCenter.x - rotatedX;
		this.view.panY = anchorScreen.y - stackCenter.y - rotatedY;
		this.applyViewTransform();
		this.updateViewControlsUI();
	}

	private normalizeDegrees(value: number): number {
		let normalized = value;
		while (normalized > 180) {
			normalized -= 360;
		}
		while (normalized <= -180) {
			normalized += 360;
		}
		return normalized;
	}
}
