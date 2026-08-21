import { Notice } from 'obsidian';
import { syncToolbarToTool, syncToolbarToLayerVisibility, syncToolbarToActiveLayer, type ToolbarElements } from '../ui/top-toolbar';
import { syncToolSettingsSidebar, type ToolSettingsSidebarElements } from '../ui/right-sidebar';
import type SketchpadPlugin from '../main';
import type { LayerName, OraLayer, ToolName, ViewTool } from '../utilities/types';
import type { CanvasViewport } from '../technical/viewport';
import type { DrawingEngine } from '../technical/drawing-engine';

export interface ToolControllerDeps {
	plugin: SketchpadPlugin;
	getLayers: () => OraLayer[];
	engine: DrawingEngine;
	viewport: CanvasViewport;
	getToolbar: () => ToolbarElements | undefined;
	getToolSettingsSidebar: () => ToolSettingsSidebarElements | undefined;

	commitSelection: () => void;

	syncLayerSidebar: () => void;

	// when false (no file open), no tool button carries the layer-active highlight
	hasOpenFile?: () => boolean;

	onToolChange?: () => void;
}

// maps a layer back to its associated drawing tool
function layerToTool(layer: LayerName): ToolName | null {
	if (layer === 'Sketch') {
		return 'pencil';
	}
	if (layer === 'Ink') {
		return 'pen';
	}
	if (layer === 'Paint') {
		return 'brush';
	}
	return null;
}

export class ToolController {
	currentTool: ViewTool = 'pencil';
	lastDrawTool: ToolName = 'pencil';
	activeLayer: LayerName = 'Sketch';
	lastActiveLayer: LayerName = 'Sketch';

	constructor(private readonly deps: ToolControllerDeps) {}

	getCurrentTool(): ViewTool {
		return this.currentTool;
	}

	getLastDrawTool(): ToolName {
		return this.lastDrawTool;
	}

	getActiveLayer(): LayerName {
		return this.activeLayer;
	}

	private isViewTool(tool: ViewTool): boolean {
		return tool === 'hand' || tool === 'zoom-in' || tool === 'zoom-out' || tool === 'rotate';
	}

	setTool(tool: ViewTool): void {
		// leaving the lasso for an actual editing tool/eyedropper applies any active selection
		// leaving it for a view tool keeps the selection alive
		if (this.currentTool === 'lasso' && tool !== 'lasso' && !this.isViewTool(tool)) {
			this.deps.commitSelection();
		}
		this.currentTool = tool;
		if (tool === 'pencil' || tool === 'pen' || tool === 'brush' || tool === 'eraser') {
			this.lastDrawTool = tool;
			this.activeLayer = this.getToolLayer(tool);
			this.lastActiveLayer = tool === 'eraser' ? this.lastActiveLayer : this.activeLayer;
		}

		this.refreshToolSettingsUI();
		this.deps.viewport.updateViewControlsUI();
		this.deps.viewport.updateCanvasPanelCursor();
		this.syncToolbarLayerVisibility();
		this.deps.syncLayerSidebar();
		this.deps.onToolChange?.();
	}

	pickColorAtPointer(event: PointerEvent): void {
		if (this.lastDrawTool === 'eraser') {
			new Notice('Eyedropper is unavailable while eraser is the active draw tool.');
			return;
		}

		const point = this.deps.viewport.getPoint(event);
		const x = Math.round(point.x);
		const y = Math.round(point.y);
		const sampledPixel = this.deps.engine.sampleFlattenedPixel(x, y);
		if (!sampledPixel || sampledPixel.a === 0) {
			return;
		}

		// sample a color by combining the pixel's color with its alpha
		const alpha = sampledPixel.a / 255;
		const composite = (channel: number): number =>
			Math.round(channel * alpha + 255 * (1 - alpha));
		const red = composite(sampledPixel.r);
		const green = composite(sampledPixel.g);
		const blue = composite(sampledPixel.b);
		const sampled = `#${red.toString(16).padStart(2, '0')}${green.toString(16).padStart(2, '0')}${blue.toString(16).padStart(2, '0')}`;
		this.deps.plugin.toolSettings[this.lastDrawTool].color = sampled;
		this.refreshToolSettingsUI();
		void this.deps.plugin.saveToolSettings();
	}

	// syncs the top-row tool button highlight and the right-side settings panel
	refreshToolSettingsUI(): void {
		const toolbar = this.deps.getToolbar();
		const sidebar = this.deps.getToolSettingsSidebar();
		if (!toolbar || !sidebar) {
			return;
		}
		syncToolbarToTool(toolbar, this.currentTool);
		syncToolSettingsSidebar(sidebar, this.deps.plugin.toolSettings[this.lastDrawTool], this.lastDrawTool);
	}

	getToolLayer(tool: ToolName): LayerName {
		if (tool === 'pencil') {
			return 'Sketch';
		}
		if (tool === 'pen') {
			return 'Ink';
		}
		if (tool === 'brush') {
			return 'Paint';
		}
		return this.lastActiveLayer;
	}

	// maps each drawing tool to whether its target layer is currently visible
	private getDrawingToolVisibilityMap(): Partial<Record<ToolName, boolean>> {
		const map: Partial<Record<ToolName, boolean>> = {};
		for (const tool of ['pencil', 'pen', 'brush', 'eraser'] as ToolName[]) {
			const layer = this.deps.getLayers().find((entry) => entry.name === this.getToolLayer(tool));
			map[tool] = layer ? layer.visible : true;
		}
		return map;
	}

	syncToolbarLayerVisibility(): void {
		const toolbar = this.deps.getToolbar();
		if (!toolbar) {
			return;
		}
		syncToolbarToActiveLayer(toolbar, this.deps.hasOpenFile?.() === false ? null : this.activeLayer);
		const visibilityMap = this.getDrawingToolVisibilityMap();
		syncToolbarToLayerVisibility(toolbar, visibilityMap);

		// switch active tool if the current tool's layer is hidden, falling back to hand tool if none are available
		if (this.currentTool === 'pencil' || this.currentTool === 'pen' || this.currentTool === 'brush' || this.currentTool === 'eraser') {
			if (!visibilityMap[this.currentTool]) {
				const fallback = (['pencil', 'pen', 'brush', 'eraser'] as ToolName[]).find((tool) => visibilityMap[tool]);
				this.setTool(fallback ?? 'hand');
			}
		}
	}

	updateActiveLayer(tool: ToolName): void {
		this.activeLayer = tool === 'eraser' ? this.lastActiveLayer : this.getToolLayer(tool);
		if (tool !== 'eraser') {
			this.lastActiveLayer = this.activeLayer;
		}
	}

	activateLayer(layerName: LayerName): void {
		if (layerName === 'Paper') {
			return;
		}

		if (this.currentTool === 'pencil' || this.currentTool === 'pen' || this.currentTool === 'brush') {
			const tool = layerToTool(layerName);
			if (tool) {
				this.setTool(tool);
			}
			return;
		}

		if (this.currentTool === 'lasso') {
			// Bake in (or cancel) any selection on the previous layer, then
			// keep the lasso tool for the newly activated layer.
			this.deps.commitSelection();
		}

		this.activeLayer = layerName;
		this.lastActiveLayer = layerName;
		this.refreshToolSettingsUI();
		this.deps.viewport.updateViewControlsUI();
		this.deps.viewport.updateCanvasPanelCursor();
		this.syncToolbarLayerVisibility();
		this.deps.syncLayerSidebar();
	}

	getTargetLayer(tool: ToolName): OraLayer {
		const layerName = tool === 'eraser' ? this.lastActiveLayer : this.activeLayer;
		const layer = this.deps.getLayers().find((entry) => entry.name === layerName);
		if (!layer) {
			throw new Error(`Layer ${layerName} not found`);
		}
		return layer;
	}
}
