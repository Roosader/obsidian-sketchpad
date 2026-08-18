import { Plugin } from 'obsidian';
import SketchpadView, { SKETCHPAD_VIEW_TYPE } from './modals/sketchpad-modal';
import { registerOraEmbedPreview } from './rendering/ora-embed';
import { cloneToolSettings, type ToolSettings, type ToolSettingsMap } from './utilities/tool-settings';
import { DEFAULT_TOOL_HOTKEYS, DEFAULT_ROTATE_HOTKEYS, DEFAULT_ROTATE_SENSITIVITY, DEFAULT_FILE_NAME, DEFAULT_IMAGE_WIDTH, DEFAULT_IMAGE_HEIGHT, DEFAULT_PAPER_COLOR, DEFAULT_GRID_SIZE, DEFAULT_GRID_COLOR, DEFAULT_GRID_OPACITY, DEFAULT_LAYER_ORDER, DEFAULT_AUTOSAVE_INTERVAL_MINUTES } from './utilities/constants';
import type { ToolName, ViewTool, RotateAction, LayerName } from './utilities/types';
import { SketchpadSettingTab } from './utilities/settings';
import { sanitizeAutosaveInterval, sanitizeDimension, sanitizeGridOpacity, sanitizeGridSize, sanitizeLayerOrder, sanitizePaperColor, sanitizePanelPos } from './utilities/utils';

interface SketchpadPluginData {
	toolSettings?: Partial<Record<ToolName, Partial<ToolSettings>>>;
	touchToDrawEnabled?: boolean;

	minimalUI?: boolean;

	leftSidebarPos?: { x: number; y: number };
	rightSidebarPos?: { x: number; y: number };

	toolHotkeys?: Partial<Record<ViewTool, string>>;

	rotateHotkeys?: Partial<Record<RotateAction, string>>;
	rotateSensitivity?: number;

	defaultFileName?: string;
	defaultImageWidth?: number;
	defaultImageHeight?: number;
	defaultPaperColor?: string;

	gridEnabled?: boolean;
	gridSize?: number;
	gridColor?: string;
	gridOpacity?: number;

	defaultLayerOrder?: LayerName[];

	layerReorderEnabled?: boolean;

	autosaveEnabled?: boolean;
	autosaveIntervalMinutes?: number;

	layerPanelCollapsed?: boolean;
	toolSettingsCollapsed?: boolean;
	okhslPickerCollapsed?: boolean;
}

export default class SketchpadPlugin extends Plugin {

	toolSettings: ToolSettingsMap = cloneToolSettings();
	touchToDrawEnabled = false;
	minimalUI = true;
	leftSidebarPos: { x: number; y: number } | null = null;
	rightSidebarPos: { x: number; y: number } | null = null;
	toolHotkeys: Partial<Record<ViewTool, string>> = { ...DEFAULT_TOOL_HOTKEYS };
	rotateHotkeys: Partial<Record<RotateAction, string>> = { ...DEFAULT_ROTATE_HOTKEYS };
	rotateSensitivity = DEFAULT_ROTATE_SENSITIVITY;
	defaultFileName = DEFAULT_FILE_NAME;
	defaultImageWidth = DEFAULT_IMAGE_WIDTH;
	defaultImageHeight = DEFAULT_IMAGE_HEIGHT;
	defaultPaperColor = DEFAULT_PAPER_COLOR;
	gridEnabled = false;
	gridSize = DEFAULT_GRID_SIZE;
	gridColor = DEFAULT_GRID_COLOR;
	gridOpacity = DEFAULT_GRID_OPACITY;
	defaultLayerOrder: LayerName[] = [...DEFAULT_LAYER_ORDER];
	layerReorderEnabled = false;
	autosaveEnabled = false;
	autosaveIntervalMinutes = DEFAULT_AUTOSAVE_INTERVAL_MINUTES;
	layerPanelCollapsed = false;
	toolSettingsCollapsed = false;
	okhslPickerCollapsed = false;

	private autosaveTimerId = 0; // 0 = autosave is disabled

	async onload(): Promise<void> { 

		const data = (await this.loadData()) as SketchpadPluginData | null;

		this.toolSettings = cloneToolSettings(data?.toolSettings);
		this.touchToDrawEnabled = data?.touchToDrawEnabled ?? false;
		this.minimalUI = data?.minimalUI ?? true;
		this.leftSidebarPos = sanitizePanelPos(data?.leftSidebarPos);
		this.rightSidebarPos = sanitizePanelPos(data?.rightSidebarPos);
		this.toolHotkeys = { ...DEFAULT_TOOL_HOTKEYS, ...(data?.toolHotkeys ?? {}) };
		this.rotateHotkeys = { ...DEFAULT_ROTATE_HOTKEYS, ...(data?.rotateHotkeys ?? {}) };
		this.rotateSensitivity = data?.rotateSensitivity ?? DEFAULT_ROTATE_SENSITIVITY;
		this.defaultFileName = data?.defaultFileName?.trim() || DEFAULT_FILE_NAME;
		this.defaultImageWidth = sanitizeDimension(data?.defaultImageWidth, DEFAULT_IMAGE_WIDTH);
		this.defaultImageHeight = sanitizeDimension(data?.defaultImageHeight, DEFAULT_IMAGE_HEIGHT);
		this.defaultPaperColor = sanitizePaperColor(data?.defaultPaperColor);
		this.gridEnabled = data?.gridEnabled ?? false;
		this.gridSize = sanitizeGridSize(data?.gridSize, DEFAULT_GRID_SIZE);
		this.gridColor = sanitizePaperColor(data?.gridColor ?? DEFAULT_GRID_COLOR);
		this.gridOpacity = sanitizeGridOpacity(data?.gridOpacity, DEFAULT_GRID_OPACITY);
		this.defaultLayerOrder = sanitizeLayerOrder(data?.defaultLayerOrder, DEFAULT_LAYER_ORDER);
		this.layerReorderEnabled = data?.layerReorderEnabled ?? false;
		this.autosaveEnabled = data?.autosaveEnabled ?? false;
		this.autosaveIntervalMinutes = sanitizeAutosaveInterval(data?.autosaveIntervalMinutes);
		this.layerPanelCollapsed = data?.layerPanelCollapsed ?? false;
		this.toolSettingsCollapsed = data?.toolSettingsCollapsed ?? false;
		this.okhslPickerCollapsed = data?.okhslPickerCollapsed ?? false;

		this.registerExtensions(['ora'], SKETCHPAD_VIEW_TYPE);

		this.registerView(SKETCHPAD_VIEW_TYPE, (leaf) => new SketchpadView(leaf, this));

		registerOraEmbedPreview(this);

		this.addSettingTab(new SketchpadSettingTab(this));
			
		this.addRibbonIcon('notebook-pen', 'Open Sketchpad', () => {
			void this.openSketchpad();
		});

		this.addCommand({
			id: 'open',
			name: 'Open',
			callback: () => {
				void this.openSketchpad();
			},
		});

		this.addCommand({
			id: 'undo',
			name: 'Undo',
			checkCallback: (checking) => this.withActiveView(checking, (view) => view.performUndo()),
		});

		this.addCommand({
			id: 'redo',
			name: 'Redo',
			checkCallback: (checking) => this.withActiveView(checking, (view) => view.performRedo()),
		});

		this.addCommand({
			id: 'new-file',
			name: 'New sketch file',
			checkCallback: (checking) => this.withActiveView(checking, (view) => void view.createNewSketchDocument()),
		});

		this.addCommand({
			id: 'open-file',
			name: 'Open sketch file',
			checkCallback: (checking) => this.withActiveView(checking, (view) => void view.openDocument()),
		});

		this.addCommand({
			id: 'save',
			name: 'Save sketch file',
			checkCallback: (checking) => this.withActiveView(checking, (view) => void view.saveDocument()),
		});

		this.addCommand({
			id: 'close-file',
			name: 'Close sketch file',
			checkCallback: (checking) => this.withActiveView(checking, (view) => void view.closeDocument()),
		});

		this.addCommand({
			id: 'flip-canvas-horizontal',
			name: 'Flip canvas horizontally',
			checkCallback: (checking) => this.withActiveView(checking, (view) => view.flipCanvasHorizontal()),
		});

		this.addCommand({
			id: 'flip-canvas-vertical',
			name: 'Flip canvas vertically',
			checkCallback: (checking) => this.withActiveView(checking, (view) => view.flipCanvasVertical()),
		});

		this.addCommand({
			id: 'fit-to-view',
			name: 'Fit sketch to view',
			checkCallback: (checking) => this.withActiveView(checking, (view) => view.fitToView()),
		});

		this.setupAutosave();
		this.registerSketchpadSwipeGuard();
	}

	async saveToolSettings(): Promise<void> {
		await this.saveData({
			toolSettings: this.toolSettings,
			touchToDrawEnabled: this.touchToDrawEnabled,
			minimalUI: this.minimalUI,
			leftSidebarPos: this.leftSidebarPos ?? undefined,
			rightSidebarPos: this.rightSidebarPos ?? undefined,
			toolHotkeys: this.toolHotkeys,
			rotateHotkeys: this.rotateHotkeys,
			rotateSensitivity: this.rotateSensitivity,
			defaultFileName: this.defaultFileName,
			defaultImageWidth: this.defaultImageWidth,
			defaultImageHeight: this.defaultImageHeight,
			defaultPaperColor: this.defaultPaperColor,
			gridEnabled: this.gridEnabled,
			gridSize: this.gridSize,
			gridColor: this.gridColor,
			gridOpacity: this.gridOpacity,
			defaultLayerOrder: this.defaultLayerOrder,
			layerReorderEnabled: this.layerReorderEnabled,
			autosaveEnabled: this.autosaveEnabled,
			autosaveIntervalMinutes: this.autosaveIntervalMinutes,
			layerPanelCollapsed: this.layerPanelCollapsed,
			toolSettingsCollapsed: this.toolSettingsCollapsed,
			okhslPickerCollapsed: this.okhslPickerCollapsed,
		} satisfies SketchpadPluginData);
	}

	// Push grid settings to every open sketchpad view
	notifyGridSettingsChanged(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(SKETCHPAD_VIEW_TYPE)) {
			(leaf.view as SketchpadView).updateGridOverlay();
		}
	}

	resetPanelPositions(): void {
		this.leftSidebarPos = null;
		this.rightSidebarPos = null;
		for (const leaf of this.app.workspace.getLeavesOfType(SKETCHPAD_VIEW_TYPE)) {
			(leaf.view as SketchpadView).resetSidebarPositions();
		}
	}

	//Cancel the hotkey commands if the active view is not a sketchpad view
	private withActiveView(checking: boolean, action: (view: SketchpadView) => void): boolean {
		const view = this.app.workspace.getActiveViewOfType(SketchpadView);
		if (!view) {
			return false;
		}
		if (!checking) {
			action(view);
		}
		return true;
	}

	// hack to prevent Obsidian mobile from hijacking touch swipes
	private registerSketchpadSwipeGuard(): void {
		let inSketchpad = false;

		this.registerDomEvent(
			document,
			'touchstart',
			(event) => {
				inSketchpad = (event.target as HTMLElement | null)?.closest('.sketchpad-modal') != null;
			},
			{ passive: true, capture: true },
		);

		this.registerDomEvent(
			document,
			'touchmove',
			(event) => {
				if (!inSketchpad) {
					return;
				}
				event.stopPropagation();
			},
			{ passive: false, capture: true },
		);
	}

	setupAutosave(): void {
		if (this.autosaveTimerId) {
			window.clearInterval(this.autosaveTimerId);
			this.autosaveTimerId = 0;
		}
		if (!this.autosaveEnabled) {
			return;
		}
		this.autosaveTimerId = this.registerInterval(
			window.setInterval(() => void this.autosaveTick(), this.autosaveIntervalMinutes * 60_000),
		);
	}

	private async autosaveTick(): Promise<void> {
		for (const leaf of this.app.workspace.getLeavesOfType(SKETCHPAD_VIEW_TYPE)) {
			await (leaf.view as SketchpadView).saveDocument(true);
		}
	}
	
	private async openSketchpad(): Promise<void> {
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({ type: SKETCHPAD_VIEW_TYPE, active: true });
	}
}
