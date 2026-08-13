import { getLayerFallbackColor } from '../utilities/layer-colors';
import type SketchpadPlugin from '../main';
import type { DrawingEngine } from '../technical/drawing-engine';
import type { CanvasViewport } from '../technical/viewport';
import type { SelectionController } from './selection-controller';
import type { ToolController } from './tool-controller';
import type { ToolName } from '../utilities/types';
import type { ToolSettingsSidebarElements } from '../ui/right-sidebar';

export interface DrawingControllerDeps {
	plugin: SketchpadPlugin;
	engine: DrawingEngine;
	viewport: CanvasViewport;
	tools: ToolController;
	selection: SelectionController;
	canvas: HTMLCanvasElement;
	render: () => void;
	refreshUndoRedoUI: () => void;
	getToolSettingsSidebar: () => ToolSettingsSidebarElements | undefined;
}

export class DrawingController {
	private pointerIsDown = false;
	private drawingStarted = false;
	private activeDrawTool: ToolName | null = null;

	private lastPressureReadoutTime = 0;
	private readonly pressureReadoutIntervalMs = 50;

	constructor(private readonly deps: DrawingControllerDeps) {}

	// handles pointer events that start from outside image
	pointerDown(event: PointerEvent): void {
		if (this.deps.viewport.tryHandleTouchPointerDown(event)) {
			return;
		}
		const target = event.target as HTMLElement | null;
		if (target?.closest('button')) {
			return;
		}
		const startedOnCanvas = event.target === this.deps.canvas;
		if ((this.deps.tools.getCurrentTool() === 'hand' || this.deps.tools.getCurrentTool() === 'rotate') && !startedOnCanvas) {
			this.handlePointerDown(event);
			return;
		}

		if (startedOnCanvas) {
			return;
		}

		if (event.pointerType !== 'pen') {
			return;
		}
		this.pointerIsDown = true;
		this.drawingStarted = false;
	}

	pointerUp(event: PointerEvent): void {
		if (this.deps.viewport.tryHandleTouchPointerUp(event)) {
			return;
		}
		if ((this.deps.viewport.isPanning || this.deps.viewport.isRotating) && this.deps.viewport.viewGestureSource === 'panel') {
			this.handlePointerUp(event);
			return;
		}
		this.pointerIsDown = false;
		this.drawingStarted = false;
	}

	pointerMove(event: PointerEvent): void {
		if (this.deps.viewport.tryHandleTouchPointerMove(event)) {
			return;
		}
		if ((this.deps.viewport.isPanning || this.deps.viewport.isRotating) && this.deps.viewport.viewGestureSource === 'panel') {
			this.handlePointerMove(event);
			return;
		}
		if (!this.pointerIsDown || this.drawingStarted) {
			return;
		}
		const el = document.elementFromPoint(event.clientX, event.clientY);
		if (el === this.deps.canvas || this.deps.canvas.contains(el)) {
			this.drawingStarted = true;
			this.handlePointerDown(event);
		}
	}

	// handle pointer events that start from inside image
	handlePointerEnter = (event: PointerEvent): void => {
		if (this.deps.plugin.touchCanvasControlsEnabled && event.pointerType === 'touch') {
			return;
		}
		const primaryButtonHeld = (event.buttons & 1) !== 0;
		if (primaryButtonHeld && !this.deps.viewport.isPanning && !this.deps.engine.isDrawing()) {
			this.handlePointerDown(event);
		}
	};

	handlePointerDown = (event: PointerEvent): void => {
		if (this.deps.viewport.tryHandleTouchPointerDown(event)) {
			return;
		}
		this.updatePressureReadout(event);
		const tool = this.deps.tools.getCurrentTool();
		if (tool === 'eyedropper') {
			this.deps.tools.pickColorAtPointer(event);
			return;
		}
		if (tool === 'hand') {
			this.deps.viewport.beginPan(event);
			return;
		}
		if (tool === 'lasso') {
			this.deps.selection.handleLassoPointerDown(event);
			return;
		}
		if (tool === 'zoom-in') {
			this.deps.viewport.beginZoom(event);
			return;
		}
		if (tool === 'zoom-out') {
			this.deps.viewport.beginZoom(event);
			return;
		}
		if (tool === 'rotate') {
			this.deps.viewport.beginRotate(event);
			return;
		}

		this.activeDrawTool = tool;
		this.deps.tools.updateActiveLayer(tool);
		const layer = this.deps.tools.getTargetLayer(tool);
		const settings = this.deps.plugin.toolSettings[tool];
		const point = this.deps.viewport.getPoint(event);
		this.deps.engine.beginStroke(layer, point, { tool, ...settings });
		this.drawLivePreview(this.activeDrawTool);
		this.deps.canvas.setPointerCapture(event.pointerId);
	};

	handlePointerMove = (event: PointerEvent): void => {
		if (this.deps.viewport.tryHandleTouchPointerMove(event)) {
			return;
		}
		this.updatePressureReadout(event);
		if (this.deps.viewport.isPanning) {
			this.deps.viewport.updatePan(event);
			return;
		}
		if (this.deps.viewport.isZooming) {
			this.deps.viewport.updateZoom(event);
			return;
		}
		if (this.deps.viewport.isRotating) {
			this.deps.viewport.updateRotate(event);
			return;
		}
		if (this.deps.tools.getCurrentTool() === 'lasso') {
			this.deps.selection.handleLassoPointerMove(event);
			return;
		}
		if (!this.deps.engine.isDrawing() || !this.activeDrawTool) {
			return;
		}

		// use coalesced events for more fine-grained sampling on fast pointer movements
		const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
		const samples = coalesced.length > 0 ? coalesced : [event];
		for (const sample of samples) {
			this.deps.engine.appendPoint(this.deps.viewport.getPoint(sample));
		}
		this.drawLivePreview(this.activeDrawTool);
	};

	handlePointerUp = (event: PointerEvent): void => {
		if (this.deps.viewport.tryHandleTouchPointerUp(event)) {
			return;
		}
		if (this.deps.viewport.isPanning) {
			this.deps.viewport.endPan(event);
			return;
		}
		if (this.deps.viewport.isZooming) {
			this.deps.viewport.endZoom(event);
			return;
		}
		if (this.deps.viewport.isRotating) {
			this.deps.viewport.endRotate(event);
			return;
		}
		if (this.deps.tools.getCurrentTool() === 'lasso') {
			this.deps.selection.handleLassoPointerUp(event);
			return;
		}
		if (!this.deps.engine.isDrawing() || !this.activeDrawTool) {
			return;
		}
		this.deps.engine.appendPoint(this.deps.viewport.getPoint(event));
		const layer = this.deps.tools.getTargetLayer(this.activeDrawTool);
		this.deps.engine.finishStroke(layer);
		this.activeDrawTool = null;
		this.deps.canvas.releasePointerCapture(event.pointerId);
		this.deps.refreshUndoRedoUI();
		this.deps.render();
	};

	// helpers
	private drawLivePreview(tool: ToolName): void {
		const layer = this.deps.tools.getTargetLayer(tool);
		this.deps.engine.drawPreview(layer, getLayerFallbackColor(layer.name));
	}

	private updatePressureReadout(event: PointerEvent): void {
		const now = performance.now();
		if (now - this.lastPressureReadoutTime < this.pressureReadoutIntervalMs) {
			return;
		}
		this.lastPressureReadoutTime = now;
		const sidebar = this.deps.getToolSettingsSidebar();
		if (!sidebar) {
			return;
		}
		const raw = event.pressure.toFixed(2);
		const used = this.deps.viewport.getPressure(event).toFixed(2);
		sidebar.pressureReadoutEl.setText(`Pointer: ${event.pointerType} · raw: ${raw} · used: ${used}`);
	}
}
