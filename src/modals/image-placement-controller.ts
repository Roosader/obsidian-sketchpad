import { hitTestSelection, updateTransformForDrag, DEFAULT_SELECTION_TRANSFORM, type SelectionDragStart } from '../technical/selection-geometry';
import { clearSelectionOverlay, drawSelectionGizmo, type GizmoScreenContext } from '../ui/selection-overlay';
import type { DrawingEngine } from '../technical/drawing-engine';
import type { CanvasViewport } from '../technical/viewport';
import type { LayerName, OraLayer, SelectionBounds, SelectionTransform } from '../utilities/types';

export interface ImagePlacementControllerDeps {
engine: DrawingEngine;
viewport: CanvasViewport;
canvas: HTMLCanvasElement;
selectionCanvas: HTMLCanvasElement;
getScreenContext: () => GizmoScreenContext;
onApplied: () => void;
		onEnd?: () => void;
}

// transform gizmo for a freshly imported image, same behaviors as the lasso selection
export class ImagePlacementController {
	private layer: OraLayer | null = null;
	private bounds: SelectionBounds | null = null;
	private transform: SelectionTransform = { ...DEFAULT_SELECTION_TRANSFORM };
	private drag: SelectionDragStart | null = null;
	private applyOnRelease = false;
	// touch placement, defer applying until release, or cancel it when a view gesture actually starts
	private pendingTouchTapOut = false;

	constructor(private readonly deps: ImagePlacementControllerDeps) {}

	async begin(layer: OraLayer, imageDataUrl: string): Promise<SelectionBounds | null> {
		this.layer = layer;
		this.transform = { ...DEFAULT_SELECTION_TRANSFORM };
		this.drag = null;
		this.applyOnRelease = false;
		this.pendingTouchTapOut = false;
		const bounds = await this.deps.engine.beginImagePlacement(layer, imageDataUrl);
		if (!bounds) {
			this.layer = null;
			return null;
		}
		this.bounds = bounds;
		this.drawGizmo();
		return bounds;
	}

	isActive(): boolean {
	return this.layer !== null && this.bounds !== null;
	}

	getLayerName(): LayerName | null {
		return this.layer?.name ?? null;
	}

	// redraws the gizmo at the current transform
	private drawGizmo(): void {
		if (!this.layer || !this.bounds) {
			return;
		}
		drawSelectionGizmo(this.deps.selectionCanvas, [], this.bounds, this.transform, this.deps.getScreenContext());
	}

	handlePointerDown(event: PointerEvent): void {
		if (!this.layer || !this.bounds) {
			return;
		}
		const point = this.deps.viewport.getPoint(event);
		const hit = hitTestSelection(point, this.bounds, this.transform, this.deps.viewport.view.zoom);
		this.drawGizmo();
		if (hit !== 'none') {
			this.pendingTouchTapOut = false;
			this.drag = { mode: hit, pointerDoc: point, transform: { ...this.transform } };
			this.applyOnRelease = false;
			try {
				this.deps.canvas.setPointerCapture(event.pointerId);
			} catch {
				// capture can fail if the pointer was already released; the
				// panel-level move routing keeps drags working regardless
			}
			return;
		}
		// clicking outside the image applies the placement - deferred to
		// pointerup so a missed handle grab doesn't commit mid-gesture.
		// For touch the arming itself is deferred (see handleTouchPointerUpTouch /
		// discardPendingTouchPointer): the contact may turn out to be the start
		// of a multi-finger view gesture, and a nondestructive gesture must not
		// bake the image. Mouse/pen arm on down as before.
		if (event.pointerType === 'touch') {
			this.pendingTouchTapOut = true;
		} else {
			this.pendingTouchTapOut = false;
			this.applyOnRelease = true;
		}
	}

	handlePointerMove(event: PointerEvent): void {
		if (!this.layer || !this.bounds) {
			return;
		}
		if (!this.drag) {
			// no active drag: keep the gizmo visible (the overlay may have
			// been reset externally since the last draw)
			this.drawGizmo();
			return;
		}
		const point = this.deps.viewport.getPoint(event);
		this.transform = updateTransformForDrag(this.drag, this.bounds, point);
		this.deps.engine.drawImagePlacementPreview(this.layer, this.transform);
		this.drawGizmo();
	}

	handlePointerUp(event: PointerEvent): void {
		try {
			this.deps.canvas.releasePointerCapture(event.pointerId);
		} catch {
			// capture was already released implicitly on pointerup
		}

		if (event.type === 'pointercancel') {
			// touch interrupted mid-gesture: discard any deferred apply, the
			// image is not baked
			this.discardPendingTouchPointer();
			return;
		}
		this.drag = null;
		if (event.pointerType === 'touch' && this.pendingTouchTapOut) {
			this.pendingTouchTapOut = false;
			this.applyOnRelease = true;
		}
		if (this.applyOnRelease) {
			this.applyOnRelease = false;
			this.apply();
			return;
		}
		// redraw at the final transform so the gizmo never sits cleared
		// after a drag ends
		this.drawGizmo();
	}

	// bakes the transformed image into the target layer
	apply(): void {
		if (!this.layer) {
			return;
		}
		this.deps.engine.commitImagePlacement(this.layer, this.transform);
		this.end();
		this.deps.onApplied();
	}

	// discards the placement without touching the layer
	cancel(): void {
		if (!this.layer) {
			return;
		}
		this.deps.engine.cancelImagePlacement();
		this.end();
	}

	// redraws the gizmo after a view transform change
	refreshGizmo(): void {
		if (!this.layer || !this.bounds) {
			return;
		}
		this.drawGizmo();
	}

	// redraws the placement preview and gizmo after a base render or view change
	refreshPreview(): void {
		if (!this.layer) {
			return;
		}
		this.deps.engine.drawImagePlacementPreview(this.layer, this.transform);
		this.drawGizmo();
	}

	// A second finger converts a one-finger touch interaction into a nondestructive canvas gesture
	// Drop deferred apply/drag state and restore the placement transform captured when the provisional drag started.
	discardPendingTouchPointer(): void {
		const drag = this.drag;
		this.pendingTouchTapOut = false;
		this.applyOnRelease = false;
		this.drag = null;
		if (this.layer) {
			if (drag) {
				this.transform = { ...drag.transform };
			}
			// The image preview is part of the GPU canvas, not just the separate gizmo canvas. Restore it unconditionally
			this.deps.engine.drawImagePlacementPreview(this.layer, this.transform);
		}
		this.refreshGizmo();
	}

	private end(): void {
		this.layer = null;
		this.bounds = null;
		this.transform = { ...DEFAULT_SELECTION_TRANSFORM };
		this.drag = null;
		this.applyOnRelease = false;
		this.pendingTouchTapOut = false;
		clearSelectionOverlay(this.deps.selectionCanvas);
		this.deps.onEnd?.();
	}
}
