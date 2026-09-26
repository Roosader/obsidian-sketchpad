import {DEFAULT_SELECTION_TRANSFORM, hitTestSelection, updateTransformForDrag, type SelectionDragStart,} from '../technical/selection-geometry';
import { clearSelectionOverlay, drawLassoPath, drawSelectionGizmo, type GizmoScreenContext } from '../ui/selection-overlay';
import type { DrawingEngine } from '../technical/drawing-engine';
import type { CanvasViewport } from '../technical/viewport';
import type { LayerName, OraLayer, Point, SelectionBounds, SelectionTransform } from '../utilities/types';

export interface SelectionControllerDeps {
	getLayers: () => OraLayer[];
	engine: DrawingEngine;
	viewport: CanvasViewport;
	canvas: HTMLCanvasElement;
	selectionCanvas: HTMLCanvasElement;
	getActiveLayer: () => LayerName;
	getScreenContext: () => GizmoScreenContext;
	render: () => void;
	refreshUndoRedoUI: () => void;
}

// selection controller for the lasso tool
export class SelectionController {
	selectionActive = false;
	selectionLayerName: LayerName | null = null;
	selectionBounds: SelectionBounds | null = null;
	selectionPolygon: Point[] = [];
	selectionTransform: SelectionTransform = { ...DEFAULT_SELECTION_TRANSFORM };
	isLassoDrawing = false;
	selectionDrag: SelectionDragStart | null = null;
	// touch lasso: first-finger commit deferred until the gesture is known not
	// to be a view gesture (a second finger may still join); cleared on
	// release/cancel alongside the provisional polygon
	private pendingTouchCommitOut = false;
	private pendingTouchCommitPoint: Point | null = null;
	private pendingTouchSelectionPolygon: Point[] | null = null;

	constructor(private readonly deps: SelectionControllerDeps) {}

	handleLassoPointerDown(event: PointerEvent): void {
		const point = this.deps.viewport.getPoint(event);
		if (this.selectionActive && this.selectionBounds) {
			// Preserve the persistent marching-ants polygon before any touch
			// interaction can mutate it. A second finger may turn this into a
			// view gesture, in which case the original selection must be
			// restored rather than leaving an empty outline.
			if (event.pointerType === 'touch') {
				this.pendingTouchSelectionPolygon = this.selectionPolygon.map((selectionPoint) => ({ ...selectionPoint }));
			}
			const hit = hitTestSelection(point, this.selectionBounds, this.selectionTransform, this.deps.viewport.view.zoom);
			if (hit !== 'none') {
				this.pendingTouchCommitOut = false;
				this.pendingTouchCommitPoint = null;
				this.selectionDrag = { mode: hit, pointerDoc: point, transform: { ...this.selectionTransform } };
				this.deps.canvas.setPointerCapture(event.pointerId);
				return;
			}
			// click outside the current selection to apply it then start a fresh lasso capture from this same point.
			// for touch the commit is deferred (see handleTouchLassoPointerUpTouch /
			// discardPendingTouchPointer): the contact may turn out to be the start
			// of a multi-finger view gesture, and a nondestructive gesture must not
			// bake the selection. Mouse/pen commit synchronously as before.
			if (event.pointerType === 'touch') {
				this.pendingTouchCommitOut = true;
				this.pendingTouchCommitPoint = { ...point };
				this.pendingTouchSelectionPolygon = this.selectionPolygon.map((selectionPoint) => ({ ...selectionPoint }));
			} else {
				this.commitSelection();
			}
		}
		this.isLassoDrawing = true;
		this.selectionPolygon = [point];
		this.deps.canvas.setPointerCapture(event.pointerId);
	}

	handleLassoPointerMove(event: PointerEvent): void {
		const point = this.deps.viewport.getPoint(event);
		if (this.selectionDrag && this.selectionBounds) {
			this.selectionTransform = updateTransformForDrag(this.selectionDrag, this.selectionBounds, point);
			this.updateSelectionPreview();
			return;
		}
		if (this.isLassoDrawing) {
			// only add a point once the pointer has moved a meaningful distance
			const last = this.selectionPolygon[this.selectionPolygon.length - 1];
			if (!last || Math.hypot(point.x - last.x, point.y - last.y) >= 2) {
				this.selectionPolygon.push(point);
			}
			drawLassoPath(this.deps.selectionCanvas, this.selectionPolygon, this.deps.getScreenContext());
		}
	}

	handleLassoPointerUp(event: PointerEvent): void {
		this.deps.canvas.releasePointerCapture(event.pointerId);
		if (event.type === 'pointercancel') {
			// touch interrupted mid-gesture: discard any deferred commit and
			// the provisional polygon, keeping the surviving selection intact
			this.discardPendingTouchPointer();
			return;
		}
		if (this.selectionDrag) {
			this.selectionDrag = null;
			return;
		}
		if (event.pointerType === 'touch') {
			this.handleTouchLassoPointerUpTouch();
		}
		if (!this.isLassoDrawing) {
			return;
		}
		this.isLassoDrawing = false;
		clearSelectionOverlay(this.deps.selectionCanvas);
		if (this.selectionPolygon.length < 3) {
			this.selectionPolygon = [];
			return;
		}

		const layer = this.getActiveLayerObject();
		this.deps.engine.beginSelection(layer, this.selectionPolygon);
		const bounds = this.deps.engine.getSelectionBounds();
		if (!bounds) {
			this.selectionPolygon = [];
			return;
		}
		this.selectionActive = true;
		this.selectionLayerName = layer.name;
		this.selectionBounds = bounds;
		this.selectionTransform = { ...DEFAULT_SELECTION_TRANSFORM };
		this.deps.refreshUndoRedoUI();
		this.updateSelectionPreview();
	}

	getActiveLayerObject(): OraLayer {
		const layer = this.deps.getLayers().find((entry) => entry.name === this.deps.getActiveLayer());
		if (!layer) {
			throw new Error(`Layer ${this.deps.getActiveLayer()} not found`);
		}
		return layer;
	}

	// touch lasso: the down missed an active selection, but the contact may
	// still turn out to be a single-finger tap-outside. By release time a
	// second finger would have joined (making it a view gesture), so a
	// pending commit here means the gesture was a genuine tap-outside.
	private handleTouchLassoPointerUpTouch(): void {
		if (!this.pendingTouchCommitOut) {
			return;
		}
		// Preserve the full provisional path across commitSelection(), which
		// clears controller state. A tap has one point and is discarded below;
		// a genuine one-finger drag can still create a new selection.
		const polygon = this.selectionPolygon.length > 0
			? this.selectionPolygon.map((point) => ({ ...point }))
			: this.pendingTouchCommitPoint
				? [{ ...this.pendingTouchCommitPoint }]
				: [];
		this.pendingTouchCommitOut = false;
		this.pendingTouchCommitPoint = null;
		this.pendingTouchSelectionPolygon = null;
		this.commitSelection();
		this.isLassoDrawing = polygon.length > 0;
		this.selectionPolygon = polygon;
	}

	// touch lasso: a view gesture actually started, so discard the deferred
	// commit and the provisional polygon. The surviving selection is repainted
	// so the overlay matches the document.
	discardPendingTouchPointer(): void {
		// The gesture callback can run without a lasso interaction having
		// started (for example, the second finger lands on a panel gesture).
		// Do not clear an already-stable selection in that case.
		const hadPendingInteraction = this.isLassoDrawing
			|| this.selectionDrag !== null
			|| this.pendingTouchCommitOut
			|| this.pendingTouchCommitPoint !== null
			|| this.pendingTouchSelectionPolygon !== null;
		if (!hadPendingInteraction) {
			return;
		}

		const savedPolygon = this.pendingTouchSelectionPolygon;
		const savedTransform = this.selectionDrag?.transform;
		this.pendingTouchCommitOut = false;
		this.pendingTouchCommitPoint = null;
		this.isLassoDrawing = false;
		this.selectionPolygon = savedPolygon?.map((point) => ({ ...point })) ?? [];
		this.pendingTouchSelectionPolygon = null;
		// A first finger may have grabbed a handle before the second finger
		// arrived. Revert that provisional transform and leave the original
		// selection active.
		if (savedTransform) {
			this.selectionTransform = { ...savedTransform };
		}
		this.selectionDrag = null;
		// The provisional lasso path may have been painted over the surviving
		// selection gizmo. Clear it before repainting the retained selection.
		clearSelectionOverlay(this.deps.selectionCanvas);
		this.updateSelectionPreview();
	}

	updateSelectionPreview(): void {
		if (!this.selectionActive || !this.selectionBounds || !this.selectionLayerName) {
			return;
		}
		const layer = this.deps.getLayers().find((entry) => entry.name === this.selectionLayerName);
		if (!layer) {
			return;
		}
		this.deps.engine.drawSelectionPreview(layer, this.selectionTransform);
		drawSelectionGizmo(
			this.deps.selectionCanvas,
			this.selectionPolygon,
			this.selectionBounds,
			this.selectionTransform,
			this.deps.getScreenContext(),
		);
	}

	// redraws the selection overlay canvas at the current view transform
	refreshOverlay(): void {
		if (this.isLassoDrawing && this.selectionPolygon.length >= 2) {
			drawLassoPath(this.deps.selectionCanvas, this.selectionPolygon, this.deps.getScreenContext());
			return;
		}
		if (!this.selectionActive || !this.selectionBounds) {
			return;
		}
		drawSelectionGizmo(
			this.deps.selectionCanvas,
			this.selectionPolygon,
			this.selectionBounds,
			this.selectionTransform,
			this.deps.getScreenContext(),
		);
	}

	commitSelection(): void {
		if (!this.selectionActive || !this.selectionLayerName) {
			return;
		}
		const layer = this.deps.getLayers().find((entry) => entry.name === this.selectionLayerName);
		if (layer) {
			this.deps.engine.commitSelection(layer, this.selectionTransform);
		}
		this.clearSelectionState();
		this.deps.refreshUndoRedoUI();
		this.deps.render();
	}

	cancelSelection(): void {
		if (!this.selectionActive || !this.selectionLayerName) {
			return;
		}
		const layer = this.deps.getLayers().find((entry) => entry.name === this.selectionLayerName);
		if (layer) {
			this.deps.engine.cancelSelection(layer);
		}
		this.clearSelectionState();
		this.deps.refreshUndoRedoUI();
		this.deps.render();
	}

	clearSelectionState(): void {
		this.selectionActive = false;
		this.selectionLayerName = null;
		this.selectionBounds = null;
		this.selectionPolygon = [];
		this.selectionDrag = null;
		this.isLassoDrawing = false;
		this.selectionTransform = { ...DEFAULT_SELECTION_TRANSFORM };
		this.pendingTouchCommitOut = false;
		this.pendingTouchCommitPoint = null;
		this.pendingTouchSelectionPolygon = null;
		clearSelectionOverlay(this.deps.selectionCanvas);
	}
}
