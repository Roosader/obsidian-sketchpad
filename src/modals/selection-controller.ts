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

	constructor(private readonly deps: SelectionControllerDeps) {}

	handleLassoPointerDown(event: PointerEvent): void {
		const point = this.deps.viewport.getPoint(event);
		if (this.selectionActive && this.selectionBounds) {
			const hit = hitTestSelection(point, this.selectionBounds, this.selectionTransform, this.deps.viewport.view.zoom);
			if (hit !== 'none') {
				this.selectionDrag = { mode: hit, pointerDoc: point, transform: { ...this.selectionTransform } };
				this.deps.canvas.setPointerCapture(event.pointerId);
				return;
			}
			// click outside the current selection to apply it then start a fresh lasso capture from this same point.
			this.commitSelection();
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
		if (this.selectionDrag) {
			this.selectionDrag = null;
			return;
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
		clearSelectionOverlay(this.deps.selectionCanvas);
	}
}
