import { ItemView, Notice, TFile, WorkspaceLeaf, normalizePath, setIcon, setTooltip, type ViewStateResult } from 'obsidian';
import { applyDefaultLayerOrder, cloneDocument, countExtraLayers, DEFAULT_DOCUMENT, isFixedLayerName, nextExtraLayerName, normalizeDocument, reorderLayer } from '../technical/sketchpad-document';
import { buildMergedPngBytes, buildOraArchive } from '../ora/ora-writer';
import { GpuStrokeEngine } from '../technical/gpu-stroke-engine';
import type { DrawingEngine } from '../technical/drawing-engine';
import { getGpuContext, isGpuSupported } from '../rendering/gpu-context';
import { buildToolbar, type ToolbarElements } from '../ui/top-toolbar';
import { buildToolSettingsSidebar, sizeToSlider, sliderToSize, type ToolSettingsSidebarElements } from '../ui/right-sidebar';
import { buildLayerSidebar, buildViewControls, syncLayerSidebar, type LayerControls, type ViewControlElements } from '../ui/left-sidebar';
import { createSelectionOverlay, resizeSelectionOverlay, type GizmoScreenContext } from '../ui/selection-overlay';
import { createGridOverlay, drawGrid, clearGrid } from '../ui/grid-overlay';
import { CursorOverlay } from '../ui/cursor-overlay';
import { createPenPatchCover, type PenPatchCover, type StaleHoverPoint } from '../ui/pen-veil';
import type SketchpadPlugin from '../main';
import type { LayerName, OraDocument, OraLayer, ViewTool } from '../utilities/types';
import { DEFAULT_FILE_NAME, MAX_EXTRA_LAYERS, TOOL_TIP_MAX_SIZE, toolCursorClasses } from '../utilities/constants';
import { sampleDataUrlColor } from '../utilities/layer-colors';
import { blurControlFocusHandler } from '../utilities/utils';
import { parseOraArchive } from '../ora/ora-parser';
import { CanvasViewport } from '../technical/viewport';
import { ToolController } from './tool-controller';
import { SelectionController } from './selection-controller';
import { HotkeyController } from './hotkey-controller';
import { DrawingController } from './drawing-controller';
import { ImagePlacementController } from './image-placement-controller';
import { ImportImageModal } from './import-image-modal';
import { DeleteLayerModal } from './delete-layer-modal';

import NewFileModal from './new-file-modal';
import OpenFileModal from './open-file-modal';
import ExportFileModal from './export-file-modal';
import { ConfirmModal, type ConfirmChoice } from './confirm-modal';

export const SKETCHPAD_VIEW_TYPE = 'sketchpad-view';

export default class SketchpadView extends ItemView {
	private readonly canvas: HTMLCanvasElement;
	private pendingOpenFile: TFile | null = null;

	private documentState: OraDocument;

	private engine!: DrawingEngine;
	private undoButton?: HTMLButtonElement;
	private redoButton?: HTMLButtonElement;

	private filePath = '';
	private fileName = DEFAULT_FILE_NAME;

	private toolSelected = false;

	// true when the open document has been changed since its last save/open
	private documentDirty = false;

	private get hasOpenFile(): boolean {
		return this.filePath !== '';
	}

	private layerControls: LayerControls = new Map();
	private toolbar?: ToolbarElements;
	private toolSettingsSidebar?: ToolSettingsSidebarElements;
	private viewControls?: ViewControlElements;

	private sketchpadShell!: HTMLDivElement;
	private canvasRegion!: HTMLElement;
	private canvasPanel!: HTMLElement;

	private leftSidebar!: HTMLDivElement;
	private rightSidebar!: HTMLDivElement;

	private canvasStack!: HTMLDivElement;

	private selectionCanvas!: HTMLCanvasElement;

	private gridCanvas!: HTMLCanvasElement;

	private cursorOverlay?: CursorOverlay;

	// small cursor:none patches parked over the last known outside-leaf hover points 
	private penPatchCover: PenPatchCover | null = null;

	// Last known stale hover positions
	private lastMouseHover: StaleHoverPoint | null = null;
	private lastPenHoverOutside: StaleHoverPoint | null = null;
	// Guards the mouse slot against Chromium's synthetic mouse re-dispatch after pen interaction
	private lastMouseButtons = -1;

	// Windows Ink + Chromium: on pen-up Chromium can repaint the OS cursor
	// for one frame with the stale hover shape cached from before the stroke
	// (often outside the modal). Showing cursor:none patches over the stale
	// hover points for pen contact plus a short window after release covers
	// that flash frame.
	private penCursorHoldTimeout: number | null = null;
	private penCursorHoldActive = false;
	private static readonly PEN_CURSOR_HOLD_MS = 300;

	private headerEl: HTMLElement;
	private headerTitleEl: HTMLElement;

	// feature controllers
	private viewport!: CanvasViewport;
	private selectionController!: SelectionController;
	private imagePlacementController: ImagePlacementController | null = null;
	private toolController!: ToolController;
	private hotkeyController!: HotkeyController;
	private drawingController!: DrawingController;

	// the leaf's original detach(), saved so the constructor's tab-close
	// interception can be undone on close (avoids retaining this view on a
	// long-lived WorkspaceLeaf).
	private originalLeafDetach!: () => void;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: SketchpadPlugin) {
		super(leaf);
		this.documentState = cloneDocument(DEFAULT_DOCUMENT);
		this.canvas = createEl('canvas');

		this.navigation = false;

		this.headerEl = this.containerEl.querySelector('.view-header')!;
		this.headerEl.addClass('sketchpad-header');
		this.headerTitleEl = this.headerEl.querySelector('.view-header-title')!;
		this.headerTitleEl.classList.add('sketchpad-header-title');
		this.headerEl.querySelector('.view-header-nav-buttons')?.remove();

		const newFileButton = this.headerEl.createEl('button', { text: 'New...' });
		newFileButton.addClass('sketchpad-header-button');
		this.headerEl.insertAfter(newFileButton, this.headerEl.firstChild);
		this.registerDomEvent(newFileButton, 'click', () => {
			void this.createNewSketchDocument();
		});

		const openButton = this.headerEl.createEl('button', { text: 'Open...' });
		openButton.addClass('sketchpad-header-button');
		this.registerDomEvent(openButton, 'click', () => this.openDocument());
		this.headerEl.insertAfter(openButton, newFileButton);
		
		const exportButton = this.headerEl.createEl('button', { text: 'Export...' });
		exportButton.addClass('sketchpad-header-button');
		this.registerDomEvent(exportButton, 'click', () => this.openExportModal());
		this.headerEl.insertAfter(exportButton, openButton);

		const importButton = this.headerEl.createEl('button', {text: 'Import...'});
		importButton.addClass('sketchpad-header-button');
		setTooltip(importButton, 'Import an image from vault to a layer of the document');
		this.registerDomEvent(importButton, 'click', () => this.openImportImageModal());
		this.headerEl.insertAfter(importButton, exportButton);

		const saveButton = this.headerEl.createEl('button', { text: 'Save' });
		saveButton.addClass('sketchpad-header-button');
		this.registerDomEvent(saveButton, 'click', () => void this.saveDocument());
		this.headerEl.insertAfter(saveButton, importButton);

		this.undoButton = this.headerEl.createEl('button');
		setIcon(this.undoButton, 'undo');
		this.undoButton.addClass('sketchpad-header-button');
		this.registerDomEvent(this.undoButton, 'click', () => this.performUndo());
		this.headerEl.insertAfter(this.undoButton, saveButton);

		this.redoButton = this.headerEl.createEl('button');
		setIcon(this.redoButton, 'redo');
		this.redoButton.addClass('sketchpad-header-button');
		this.registerDomEvent(this.redoButton, 'click', () => this.performRedo());
		this.headerEl.insertAfter(this.redoButton, this.undoButton);

		const closeButton = this.headerEl.createEl('button', { text: 'Close file' });
		closeButton.addClass('sketchpad-header-button');
		this.registerDomEvent(closeButton, 'click', () => this.closeDocument());

		this.headerEl.insertBefore(closeButton, this.headerEl.querySelector('.view-actions'));

		// intercept tab closes to offer to save an open file 
		this.originalLeafDetach = this.leaf.detach.bind(this.leaf);
		let closePromptOpen = false;
		this.leaf.detach = (): void => {
			if (!this.hasOpenFile || closePromptOpen || !this.documentDirty) {
				this.originalLeafDetach();
				return;
			}
			closePromptOpen = true;
			void (async () => {
				try {
					const choice = await new Promise<ConfirmChoice>((resolve) => {
						new ConfirmModal(
							this.app,
							'Do you want to save the file before closing Sketchpad?',
							resolve,
						).open();
					});
					if (choice === 'cancel') {
						return; // keep the tab open, discarding nothing
					}
					if (choice === 'yes') {
						await this.saveDocument();
					}
				} finally {
					closePromptOpen = false;
				}
				this.originalLeafDetach();
			})();
		};
	}

	async openDocument(): Promise<void> {
		// preselect the current file's folder in the open-file modal 
		const slash = this.filePath.lastIndexOf('/');
		const defaultFolder = slash === -1 ? undefined : this.filePath.slice(0, slash);
		new OpenFileModal(
			this.app,
			(choice) => {
				if (!choice) {
					return;
				}
				if (choice.file) {
					if (choice.file.path === this.filePath) {
						new Notice('The selected file is already open');
						return;
					}
					void this.openFileInTab(choice.file);
				}
			},
			defaultFolder,
		).open();
	}

	async closeDocument(): Promise<void> {
		if (!this.hasOpenFile) {
			return;
		}

		if (!this.documentDirty) {
			this.closeCurrentFile();
			return;
		}
		new ConfirmModal(
			this.app,
			'Do you want to save before closing the file?',
			(choice) => {
				if (choice === 'cancel') {
					return;
				}
				void (async () => {
					if (choice === 'yes') {
						await this.saveDocument();
					}
					this.closeCurrentFile();
				})();
			},
		).open();
	}

	private closeCurrentFile(): void {
		this.imagePlacementController?.cancel();
		this.documentState = cloneDocument(DEFAULT_DOCUMENT);
		this.filePath = '';
		this.fileName = DEFAULT_FILE_NAME;
		this.headerTitleEl.setText('Sketchpad');
		this.viewport.resetView();
		this.canvas.addClass('sketchpad-canvas-hidden');
		this.toolController?.syncActiveLayerToDocument();
		this.toolController?.syncToolbarLayerVisibility();
		this.updateNoFileUI();
	}

	async createNewSketchDocument(): Promise<void> {
		// preselect the current file's folder in the new-file modal 
		const slash = this.filePath.lastIndexOf('/');
		const defaultFolder = slash === -1 ? undefined : this.filePath.slice(0, slash);
		const choice = await new Promise<{ options?: { width: number; height: number; paperColor: string; name: string; folder?: string } } | null>((resolve) => {
			new NewFileModal(
				this.app,
				(selected) => {
					resolve(selected);
				},
				{
					defaultFileName: this.plugin.defaultFileName,
					defaultImageWidth: this.plugin.defaultImageWidth,
					defaultImageHeight: this.plugin.defaultImageHeight,
					defaultPaperColor: this.plugin.defaultPaperColor,
					defaultFolder,
				},
			).open();
		});

		if (!choice?.options) {
			return;
		}

		const { width, height, paperColor, name, folder } = choice.options;

		const folderPath = normalizePath(folder?.trim() ?? '').replace(/^\/+|\/+$/g, '');
		const folderPrefix = folderPath ? `${folderPath}/` : '';
		// file names must be unique across the whole vault
		const baseName = `${name}.ora`;
		const usedNames = new Set<string>();
		for (const file of this.app.vault.getAllLoadedFiles()) {
			usedNames.add(file.name);
		}
		let candidateBase = baseName;
		let index = 1;
		while (usedNames.has(candidateBase)) {
			candidateBase = `${name}-${index}.ora`;
			index += 1;
		}
		const candidate = `${folderPrefix}${candidateBase}`;
		const filePath = normalizePath(candidate);
		if (!(await this.checkForOpenedFile())) {
			return;
		}

		try {
			if (folderPath) {
				const existing = this.app.vault.getAbstractFileByPath(folderPath);
				if (existing instanceof TFile) {
					new Notice(`Unable to create sketch document: a file already exists at ${folderPath}.`);
					return;
				}
				if (!existing) {
					await this.app.vault.createFolder(folderPath);
				}
			}
			let file: TFile;
			const document = cloneDocument(DEFAULT_DOCUMENT);
			document.layers = applyDefaultLayerOrder(document.layers, this.plugin.defaultLayerOrder);
			document.width = width;
			document.height = height;
			document.paperColor = paperColor;
			const archive = buildOraArchive(document);
			file = await this.app.vault.createBinary(filePath, archive);
			await this.setDocument(file, document);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Unable to create sketch document: ${message}`);
		}
	}

	async openFileInTab(file: TFile): Promise<void> {
		if (!(await this.checkForOpenedFile())) {
			return;
		}
		const document = await this.readOraDocument(file);
		await this.setDocument(file, document);
	}

	async checkForOpenedFile(): Promise<boolean> {
		if (!this.hasOpenFile || !this.documentDirty) {
			return true;
		}

		const choice = await new Promise<ConfirmChoice>((resolve) => {
			new ConfirmModal(
				this.app,
				'There is a file currently opened. Do you want to save it before opening a new file?',
				resolve,
			).open();
		});

		if (choice === 'cancel') {
			return false;
		}

		if (choice === 'yes') {
			await this.saveDocument();
		}

		return true;
	}

	async readOraDocument(file: TFile): Promise<OraDocument> {
		try {
			const binary = await this.app.vault.readBinary(file);
			const parsed = parseOraArchive(binary);
			if (parsed) {
				return parsed.document;
			}
		} catch {
			// Fall back to the default document if the archive is not a readable OpenRaster package.
		}
		return cloneDocument(DEFAULT_DOCUMENT);
	}

	async setDocument(file: TFile, sketchDocument: OraDocument): Promise<void> {
		this.selectionController?.clearSelectionState();
		this.documentDirty = false;
		this.filePath = file.path;
		this.fileName = file.name;
		const documentState = (this.documentState = cloneDocument(normalizeDocument(sketchDocument)));

		// get paper color by sampling the paper layer
		const paperColor = await this.samplePaperColor(documentState);
		if (paperColor) {
			documentState.paperColor = paperColor;
		}
		this.imagePlacementController?.cancel();
		this.engine.setDocument(this.documentState, () => this.render());
		this.refreshUndoRedoUI();

		// the previously active layer may not exist in this document
		this.toolController?.syncActiveLayerToDocument();

		this.toolSelected = true;
		this.renderView();
		this.updateToolSettingsUI();
	}

	private async samplePaperColor(documentState: OraDocument): Promise<string | undefined> {
		const paper = documentState.layers.find((layer) => layer.name === 'Paper');
		return paper?.baseImageDataUrl ? sampleDataUrlColor(paper.baseImageDataUrl) : undefined;
	}

	getViewType(): string {
		return SKETCHPAD_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Sketchpad';
	}

	getIcon(): string {
		return 'pencil';
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);

		const filePath = (state as { file?: string } | undefined)?.file;
		if (!filePath?.toLowerCase().endsWith('.ora')) {
			return;
		}

		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile) || file.extension !== 'ora') {
			return;
		}

		if (!this.engine) {
			this.pendingOpenFile = file;
			return;
		}
		await this.openFileInTab(file);
	}

	// makes the sketchpad tab open empty upon Obsidian restart
	getState(): { file?: string } {
		return {};
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('sketchpad-modal');

		const gpu = isGpuSupported() ? await getGpuContext() : null;
		if (!gpu) {
			new Notice('Sketchpad requires webgl2, which is unavailable in this environment.');
			this.contentEl.createEl('p', { text: 'Sketchpad requires webgl2, which is unavailable in this environment.' });
			return;
		}
		this.engine = new GpuStrokeEngine(this.documentState, this.canvas, gpu, () => this.markDocumentDirty());
		this.refreshUndoRedoUI();

		const onContextLost = (event: Event): void => {
			event.preventDefault();
			new Notice('Sketchpad lost its webgl context. Close and reopen this tab to continue.');
		};
		this.canvas.addEventListener('webglcontextlost', onContextLost);
		this.register(() => this.canvas.removeEventListener('webglcontextlost', onContextLost));

		this.sketchpadShell = this.contentEl.createDiv({ cls: 'sketchpad-shell' });

		this.leftSidebar = this.sketchpadShell.createDiv({ cls: 'sketchpad-left-sidebar' });
		// the toolbar floats in this region (a sibling of the panel) so panel pointer routing never sees toolbar interactions
		this.canvasRegion = this.sketchpadShell.createDiv({ cls: 'sketchpad-canvas-region' });
		this.canvasPanel = this.canvasRegion.createDiv({ cls: 'sketchpad-canvas-panel' });
		this.rightSidebar = this.sketchpadShell.createDiv({ cls: 'sketchpad-right-sidebar' });

		if (this.plugin.minimalUI) { 
			this.leftSidebar.classList.add('sketchpad-minimal');
			this.rightSidebar.classList.add('sketchpad-minimal');
		}

		this.canvasStack = this.canvasPanel.createDiv({ cls: 'sketchpad-canvas-stack' });
		this.canvasStack.appendChild(this.canvas);

		this.gridCanvas = createGridOverlay(this.canvasStack);
		
		this.selectionCanvas = createSelectionOverlay(this.canvasPanel);

		// Stale-hover patch layer created once per view and destroyed in onClose
		this.penPatchCover = createPenPatchCover();
		this.register(() => {
			this.penPatchCover?.destroy();
			this.penPatchCover = null;
		});

		// Track stale hover candidates while the view is open, only outside-leaf positions update the slots.
		this.registerDomEvent(document, 'pointermove', (event: PointerEvent) => {
			this.trackStaleHoverPoint(event);
		}, { capture: true, passive: true });
		// Window blur mid-stroke must never leave a patch blocking.
		this.registerDomEvent(window, 'blur', () => this.clearPenCursorHold());

		// custom tool cursors
		this.cursorOverlay = new CursorOverlay(
			this.canvasPanel,
			() => this.toolController?.getCurrentTool() ?? 'pencil',
			(tool) => {
				// the eraser end uses the eraser's own size
				const name = tool === 'eraser' ? 'eraser' : (this.toolController?.getLastDrawTool() ?? 'pencil');
				return this.plugin.toolSettings[name].size;
			},
			() => this.viewport?.view.zoom ?? 1,
			() => this.toolSelected,
			() => this.viewport?.isTouchDrawActive() ?? false,
			() => this.plugin.hideCursorWhileDrawing,
			() => this.engine?.isDrawing() ?? false,
		);
		const cursorResizeObserver = new ResizeObserver(() => this.cursorOverlay?.resize());
		cursorResizeObserver.observe(this.canvasPanel);
		this.register(() => cursorResizeObserver.disconnect());

		const selectionResizeObserver = new ResizeObserver(() => {
			this.viewport.positionCanvasStack();
			resizeSelectionOverlay(this.selectionCanvas, this.canvasPanel);
			this.selectionController?.refreshOverlay();
			this.imagePlacementController?.refreshGizmo();
		});
		selectionResizeObserver.observe(this.canvasPanel);
		this.register(() => selectionResizeObserver.disconnect());

		this.canvas.addClass('sketchpad-canvas-hidden');
		this.canvas.className = 'sketchpad-canvas';

		// pan/zoom/rotate/touch gestures
		this.viewport = new CanvasViewport({
			canvas: this.canvas,
			canvasPanel: this.canvasPanel,
			canvasStack: this.canvasStack,
			getDocumentSize: () => ({ width: this.documentState.width, height: this.documentState.height }),
			getCurrentTool: () => this.toolController?.getCurrentTool() ?? 'pencil',
			getViewControls: () => this.viewControls,
			isActive: () => this.app.workspace.getActiveViewOfType(SketchpadView) === this,
			isTouchToDrawEnabled: () => this.plugin.touchToDrawEnabled,
			refreshCursorOverlay: () => this.cursorOverlay?.refresh(),

			onViewTransformChange: () => {
				this.selectionController?.refreshOverlay();
				this.imagePlacementController?.refreshGizmo();
			},

			onMultiTouchGestureStart: (wasTap) => {
				// A second finger converts the interaction into a nondestructive
				// view gesture. Commit/finish any provisional drawing stroke first:
				// that cleanup may render the base layer and clear the placement
				// preview. The selection/placement restore below must be last.
				this.drawingController?.commitActiveStroke(wasTap);
				// Drop provisional one-finger work; existing selections and image
				// placements remain intact and are repainted after stroke cleanup.
				this.selectionController?.discardPendingTouchPointer();
				this.imagePlacementController?.discardPendingTouchPointer();
				// hide the custom cursor while pan/zoom/rotate is active
				this.cursorOverlay?.handlePointerLeave();
			},

			onTouchTap: (fingers) => {
				if (fingers === 2) {
					this.performUndo();
				} else if (fingers === 3) {
					this.performRedo();
				}
			},
		});

		this.toolbar = buildToolbar(
			this.canvasRegion,
			this.plugin,
			null,
			() => this.toolController?.getCurrentTool() ?? 'pencil',
			(tool) => this.switchTool(tool),
		);

		// flag the hover so the custom cursor is hidden while pointer is hovering over a tool button
		const toolbarElement = this.toolbar.toolbar;
		this.registerDomEvent(toolbarElement, 'pointerover', (event) => {
			const related = event.relatedTarget;
			if (related instanceof Node && toolbarElement.contains(related)) {
				return;
			}
			this.cursorOverlay?.setOverToolbar(true);
		});
		this.registerDomEvent(toolbarElement, 'pointerout', (event) => {
			const related = event.relatedTarget;
			if (related === null) {
				// pointer left the window entirely: the hover is over and
				// there is no position, so clear both (a stale overToolbar
				// flag would keep the cursor hidden on re-entry)
				this.cursorOverlay?.handlePointerLeave();
				this.cursorOverlay?.setOverToolbar(false);
				return;
			}
			if (related instanceof Node && toolbarElement.contains(related)) {
				return;
			}
			this.cursorOverlay?.setOverToolbar(false);
		});

		this.toolSettingsSidebar = buildToolSettingsSidebar(
			this.rightSidebar,
			this.plugin,
			() => this.toolController?.getLastDrawTool() ?? 'pencil',
			// re-render the tip-size preview when the size slider moves.
			() => this.cursorOverlay?.refresh(),
		);
		this.layerControls = this.constructLayerSidebar(true);
		this.viewControls = buildViewControls(
			this.leftSidebar,
			this.viewport.view,
			{
				onZoomChange: (zoom) => this.viewport.setZoom(zoom),
				onRotationChange: (rotation) => this.viewport.setRotation(rotation),
				onToggleFlipX: () => this.viewport.toggleFlip('flipX'),
				onToggleFlipY: () => this.viewport.toggleFlip('flipY'),
				onFitToView: () => this.viewport.fitDocumentToViewAndApply(),
				onPanelMove: (position) => {
					this.plugin.leftSidebarPos = position;
					void this.plugin.saveToolSettings();
				},
				onLayerPanelToggle: (visible) => {
					this.plugin.layerPanelCollapsed = !visible;
					void this.plugin.saveToolSettings();
				},
			},
			this.plugin.minimalUI,
			this.plugin.layerPanelCollapsed,
		);

		// restores saved floating sidebar positions 
		this.applySidebarPositions();

		// re-clamp the floating sidebars whenever the shell resizes so they can't grow past the shell's edge
		const shellResizeObserver = new ResizeObserver(() => this.applySidebarPositions());
		shellResizeObserver.observe(this.sketchpadShell);
		this.register(() => shellResizeObserver.disconnect());

		// re-clamp a positioned sidebar whenever its own size changes
		const sidebarResizeObserver = new ResizeObserver(() => this.applySidebarPositions());
		sidebarResizeObserver.observe(this.leftSidebar);
		sidebarResizeObserver.observe(this.rightSidebar);
		this.register(() => sidebarResizeObserver.disconnect());

		this.selectionController = new SelectionController({
			getLayers: () => this.documentState.layers,
			engine: this.engine,
			viewport: this.viewport,
			canvas: this.canvas,
			selectionCanvas: this.selectionCanvas,
			getActiveLayer: () => this.toolController?.getActiveLayer() ?? 'Sketch',
			getScreenContext: (): GizmoScreenContext => {
				const panelRect = this.canvasPanel.getBoundingClientRect();
				return {
					zoom: this.viewport.view.zoom,
					rotation: this.viewport.view.rotation,
					panX: this.viewport.view.panX,
					panY: this.viewport.view.panY,
					flipX: this.viewport.view.flipX,
					flipY: this.viewport.view.flipY,
					docWidth: this.documentState.width,
					docHeight: this.documentState.height,
					panelWidth: panelRect.width,
					panelHeight: panelRect.height,
					devicePixelRatio: window.devicePixelRatio || 1,
				};
			},
			render: () => this.render(),
			refreshUndoRedoUI: () => this.refreshUndoRedoUI(),
		});

		this.imagePlacementController = new ImagePlacementController({
			engine: this.engine,
			viewport: this.viewport,
			canvas: this.canvas,
			selectionCanvas: this.selectionCanvas,
			getScreenContext: (): GizmoScreenContext => {
				const panelRect = this.canvasPanel.getBoundingClientRect();
				return {
					zoom: this.viewport.view.zoom,
					rotation: this.viewport.view.rotation,
					panX: this.viewport.view.panX,
					panY: this.viewport.view.panY,
					flipX: this.viewport.view.flipX,
					flipY: this.viewport.view.flipY,
					docWidth: this.documentState.width,
					docHeight: this.documentState.height,
					panelWidth: panelRect.width,
					panelHeight: panelRect.height,
					devicePixelRatio: window.devicePixelRatio || 1,
				};
			},
			onApplied: () => {
				this.refreshUndoRedoUI();
				this.render();
			},
			onEnd: () => {
				this.viewport.updateCanvasPanelCursor();
				this.cursorOverlay?.setSuppressed(false);
			},
		});

		this.toolController = new ToolController({
			plugin: this.plugin,
			getLayers: () => this.documentState.layers,
			engine: this.engine,
			viewport: this.viewport,
			getToolbar: () => this.toolbar,
			getToolSettingsSidebar: () => this.toolSettingsSidebar,
			commitSelection: () => this.selectionController?.commitSelection(),
			commitImagePlacement: () => this.imagePlacementController?.apply(),
			syncLayerSidebar: () => this.syncLayerSidebarActive(),
			hasOpenFile: () => this.hasOpenFile,
			onToolChange: () => {
				this.toolSelected = true;
				this.updateToolSettingsUI();
				this.cursorOverlay?.refresh();
			},
		});

		this.hotkeyController = new HotkeyController({
			plugin: this.plugin,
			viewport: this.viewport,
			isActive: () => this.app.workspace.getActiveViewOfType(SketchpadView) === this,
			getCurrentTool: () => this.toolController?.getCurrentTool() ?? 'pencil',
			setTool: (tool) => this.toolController?.setTool(tool),
			hasActiveSelection: () => this.selectionController?.selectionActive ?? false,
			cancelSelection: () => this.selectionController?.cancelSelection(),
			hasActiveImagePlacement: () => this.imagePlacementController?.isActive() ?? false,
			cancelImagePlacement: () => this.imagePlacementController?.cancel(),
			adjustToolSize: (delta) => this.adjustToolSize(delta),
		});

		this.drawingController = new DrawingController({
			plugin: this.plugin,
			engine: this.engine,
			viewport: this.viewport,
			tools: this.toolController,
			selection: this.selectionController,
			canvas: this.canvas,
			render: () => this.render(),
			refreshUndoRedoUI: () => this.refreshUndoRedoUI(),
			imagePlacementActive: () => this.imagePlacementController?.isActive() ?? false,
			getToolSettingsSidebar: () => this.toolSettingsSidebar,
		});

		// when available, raw pointer updates drive the custom cursor at native rate
		const supportsRawPointerUpdate = typeof window !== 'undefined' && 'onpointerrawupdate' in window;

		// panel-level pointer routing (handles pen drawing that starts off-canvas).
		this.registerDomEvent(this.canvasPanel, 'pointerdown', (event) => {
			this.cursorOverlay?.handlePointerDown(event.pointerType, event.buttons);
			if (event.pointerType === 'pen') {
				this.setPenCursorHold(true);
			}
			// With touch-to-draw disabled the viewport exclusively owns touch
			// input. With it enabled, the viewport declines a first touch but
			// claims it as soon as a second finger joins, so lasso/placement
			// must not act on the first contact before that decision.
			if (event.pointerType === 'touch') {
				this.viewport.invalidateGeometryCache();
				if (this.viewport.tryHandleTouchPointerDown(event)) {
					return;
				}
			}
			// gizmo handles can sit outside the canvas (rotate handle, enlarged
			// selections); route panel events that missed the canvas so they
			// still work. Canvas hits are handled by the canvas listeners.
			if (event.target !== this.canvas) {
				if (!this.toolController?.isViewToolActive() && this.imagePlacementController?.isActive()) {
					this.imagePlacementController.handlePointerDown(event);
					return;
				}
				if (this.toolController?.getCurrentTool() === 'lasso') {
					// grabs existing handles when a selection is active, or starts
					// a fresh lasso otherwise; the controller captures the pointer,
					// so move/up keep flowing after the start. A single click
					// outside any selection just clears it, as on-canvas.
					this.selectionController.handleLassoPointerDown(event);
					return;
				}
			}
			this.drawingController?.pointerDown(event);
		});
		this.registerDomEvent(this.canvasPanel, 'pointerup', (event) => {
			if (event.pointerType === 'pen') {
				this.setPenCursorHold(false);
			}
			if (event.target !== this.canvas && event.pointerType === 'touch' && this.viewport.tryHandleTouchPointerUp(event)) {
				this.cursorOverlay?.handlePointerUp(event.buttons);
				return;
			}
			if (event.target !== this.canvas && !this.toolController?.isViewToolActive() && this.imagePlacementController?.isActive()) {
				// panel events that missed the canvas (placement end)
				this.imagePlacementController.handlePointerUp(event);
				return;
			}
			this.drawingController?.pointerUp(event);
			this.cursorOverlay?.handlePointerUp(event.buttons);
		});
		this.registerDomEvent(this.canvasPanel, 'pointermove', (event) => {
			// Panel-origin touch gestures are captured by the panel, so their
			// moves must reach the viewport before placement/lasso routing.
			if (event.target !== this.canvas && event.pointerType === 'touch' && this.viewport.tryHandleTouchPointerMove(event)) {
				return;
			}
			if (event.target !== this.canvas && !this.toolController?.isViewToolActive() && this.imagePlacementController?.isActive()) {
				// panel events that missed the canvas (placement)
				this.imagePlacementController.handlePointerMove(event);
				return;
			}
			if (!supportsRawPointerUpdate) {
				this.cursorOverlay?.handlePointerMove(event.clientX, event.clientY, event.pointerType, event.buttons);
			}
			this.drawingController?.pointerMove(event);
		});
		this.registerDomEvent(this.canvasPanel, 'pointercancel', (event) => {
			if (event.pointerType === 'pen') {
				this.setPenCursorHold(false);
			}
			if (event.target !== this.canvas && event.pointerType === 'touch' && this.viewport.tryHandleTouchPointerUp(event)) {
				this.cursorOverlay?.handlePointerUp(event.buttons);
				return;
			}
			if (event.target !== this.canvas && !this.toolController?.isViewToolActive() && this.imagePlacementController?.isActive()) {
				this.imagePlacementController.handlePointerUp(event);
				this.cursorOverlay?.handlePointerUp(event.buttons);
				return;
			}
			this.drawingController?.pointerUp(event);
			this.cursorOverlay?.handlePointerUp(event.buttons);
		});
		this.registerDomEvent(this.canvasPanel, 'pointerenter', () => {
			this.cursorOverlay?.refresh();
		});
		this.registerDomEvent(this.canvasPanel, 'pointerleave', () => {
			this.cursorOverlay?.handlePointerLeave();
		});

		this.registerDomEvent(this.containerEl, 'click', blurControlFocusHandler(), true);

		if (supportsRawPointerUpdate) {
		const onPanelRawUpdate = (event: Event): void => {
				const pe = event as PointerEvent;
				this.cursorOverlay?.handlePointerMove(pe.clientX, pe.clientY, pe.pointerType, pe.buttons);

				this.drawingController?.handleRawPointerUpdate(pe);

				const off = this.drawingController?.getCursorPredictionOffset();
				if (off && (off.dx !== 0 || off.dy !== 0)) {
					this.cursorOverlay?.setPredictionOffset(off.dx, off.dy);
				} else if (off) {
					this.cursorOverlay?.setPredictionOffset(0, 0);
				}
			};
			this.canvasPanel.addEventListener('pointerrawupdate', onPanelRawUpdate, { passive: true });
			this.register(() => {
				this.canvasPanel.removeEventListener('pointerrawupdate', onPanelRawUpdate);
			});
		}

		this.registerDomEvent(this.canvas, 'pointerdown', (event) => {
			if (event.pointerType === 'pen') {
				this.setPenCursorHold(true);
			}
			// Offer touch to the viewport before image-placement handling. This
			// makes touch-to-draw off a true pan/zoom/rotate mode and ensures a
			// second finger can convert a one-finger interaction into a view
			// gesture before any image apply is armed.
			if (this.viewport.tryHandleTouchPointerDown(event)) {
				return;
			}
			if (!this.toolController?.isViewToolActive() && this.imagePlacementController?.isActive()) {
				this.imagePlacementController.handlePointerDown(event);
				return;
			}
			this.cursorOverlay?.handlePointerDown(event.pointerType, event.buttons);
			this.drawingController.handlePointerDown(event);
			//hide the cursor while drawing if the user opted in
			this.cursorOverlay?.refresh();
		});
		this.registerDomEvent(this.canvas, 'pointerenter', this.drawingController.handlePointerEnter);
		this.registerDomEvent(this.canvas, 'pointermove', (event) => {
			// Keep viewport touch tracking ahead of selection/placement routing.
			// On the second finger this updates the pan/zoom/rotate gesture.
			if (event.pointerType === 'touch' && this.viewport.tryHandleTouchPointerMove(event)) {
				return;
			}
			if (!this.toolController?.isViewToolActive() && this.imagePlacementController?.isActive()) {
				this.imagePlacementController.handlePointerMove(event);
				return;
			}
			if (!supportsRawPointerUpdate) {
				this.cursorOverlay?.handlePointerMove(event.clientX, event.clientY, event.pointerType, event.buttons);
			}
			this.drawingController?.handlePointerMove(event);

			if (!supportsRawPointerUpdate) {
				const off = this.drawingController?.getCursorPredictionOffset();
				if (off && (off.dx !== 0 || off.dy !== 0)) {
					this.cursorOverlay?.setPredictionOffset(off.dx, off.dy);
				} else if (off) {
					this.cursorOverlay?.setPredictionOffset(0, 0);
				}
			}
		});
		this.registerDomEvent(this.canvas, 'pointerup', (event) => {
			if (event.pointerType === 'pen') {
				this.setPenCursorHold(false);
			}
			if (event.pointerType === 'touch' && this.viewport.tryHandleTouchPointerUp(event)) {
				this.cursorOverlay?.handlePointerUp(event.buttons);
				return;
			}
			if (!this.toolController?.isViewToolActive() && this.imagePlacementController?.isActive()) {
				this.imagePlacementController.handlePointerUp(event);
				return;
			}
			this.drawingController.handlePointerUp(event);
			//restore the cursor if it was hidden while drawing
			this.cursorOverlay?.handlePointerUp(event.buttons);
		});
		this.registerDomEvent(this.canvas, 'pointerleave', (event) => {
			this.drawingController.handlePointerUp(event);
			this.cursorOverlay?.handlePointerUp(event.buttons);
		});
		// Explicit capture loss (e.g. the OS takes the pen stream) must release
		// the hold even if no pointerup/cancel arrives.
		this.registerDomEvent(this.canvas, 'lostpointercapture', (event: PointerEvent) => {
			if (event.pointerType === 'pen') {
				this.setPenCursorHold(false);
			}
		});
		this.registerDomEvent(this.canvasPanel, 'lostpointercapture', (event: PointerEvent) => {
			if (event.pointerType === 'pen') {
				this.setPenCursorHold(false);
			}
		});
		this.registerDomEvent(this.canvas, 'pointercancel', (event) => {
			if (event.pointerType === 'pen') {
				this.setPenCursorHold(false);
			}
			if (event.pointerType === 'touch' && this.viewport.tryHandleTouchPointerUp(event)) {
				this.cursorOverlay?.handlePointerUp(event.buttons);
				return;
			}
			if (!this.toolController?.isViewToolActive() && this.imagePlacementController?.isActive()) {
				this.imagePlacementController.handlePointerUp(event);
				this.cursorOverlay?.handlePointerUp(event.buttons);
				return;
			}
			this.drawingController.handlePointerUp(event);
			this.cursorOverlay?.handlePointerUp(event.buttons);
		});
		
		// swallow Escape in capture phase before Obsidian's app-level key handling
		this.registerDomEvent(window, 'keydown', this.hotkeyController.handleKeyDown, { capture: true });
		this.registerDomEvent(window, 'keyup', this.hotkeyController.handleKeyUp);
		this.registerDomEvent(this.canvasPanel, 'wheel', this.viewport.handleWheel, { passive: false });

		this.toolController?.syncToolbarLayerVisibility();
		this.updateToolSettingsUI();
		this.updateNoFileUI();
		this.cursorOverlay?.refresh();

		if (this.pendingOpenFile) {
			const file = this.pendingOpenFile;
			this.pendingOpenFile = null;
			await this.openFileInTab(file);
		}
	}

	// Hold (or release) the stale-hover cover
	setPenCursorHold(active: boolean): void {
		if (active) {
			if (this.penCursorHoldTimeout !== null) {
				window.clearTimeout(this.penCursorHoldTimeout);
				this.penCursorHoldTimeout = null;
			}
			if (!this.penCursorHoldActive) {
				this.penCursorHoldActive = true;
			}
			this.showStaleHoverCover();
			return;
		}
		if (this.penCursorHoldTimeout !== null || !this.penCursorHoldActive) {
			return;
		}
		this.penCursorHoldTimeout = window.setTimeout(() => {
			this.penCursorHoldTimeout = null;
			this.penCursorHoldActive = false;
			this.penPatchCover?.hide();
		}, SketchpadView.PEN_CURSOR_HOLD_MS);
	}

	private clearPenCursorHold(): void {
		if (this.penCursorHoldTimeout !== null) {
			window.clearTimeout(this.penCursorHoldTimeout);
			this.penCursorHoldTimeout = null;
		}
		if (this.penCursorHoldActive) {
			this.penCursorHoldActive = false;
		}
		// Never leave outside UI covered: a close mid-stroke must drop the
		// patches even though the hold timer is gone.
		this.penPatchCover?.hide();
	}

	// Record candidate stale hover points (mouse park + pen hover outside)
	private trackStaleHoverPoint(event: PointerEvent): void {
		if (event.pointerType === 'mouse') {
			// Skip Chromium's synthetic mouse re-dispatch after pen interaction
			if (
				(event.buttons & 1) === 0 &&
				this.lastMouseHover !== null &&
				event.clientX === this.lastMouseHover.x &&
				event.clientY === this.lastMouseHover.y &&
				event.buttons === this.lastMouseButtons
			) {
				return;
			}
			this.lastMouseButtons = event.buttons;
			this.lastMouseHover = { x: event.clientX, y: event.clientY };
			return;
		}
		if (event.pointerType === 'pen') {
			if (event.buttons !== 0) {
				return;
			}
			if (this.containerEl?.contains(event.target as Node)) {
				return;
			}
			this.lastPenHoverOutside = { x: event.clientX, y: event.clientY };
		}
	}

	private showStaleHoverCover(): void {
		if (!this.penPatchCover) {
			return;
		}
		const points: StaleHoverPoint[] = [];
		if (this.lastMouseHover) {
			points.push(this.lastMouseHover);
		}
		// Avoid stacking two patches on the same spot when the pen hovered exactly where the mouse is parked.
		if (
			this.lastPenHoverOutside &&
			(!this.lastMouseHover ||
				this.lastPenHoverOutside.x !== this.lastMouseHover.x ||
				this.lastPenHoverOutside.y !== this.lastMouseHover.y)
		) {
			points.push(this.lastPenHoverOutside);
		}
		this.penPatchCover.show(points);
	}

	async onClose(): Promise<void> {
		this.clearPenCursorHold();
		this.filePath = '';
		this.hotkeyController?.clearTempToolHold();
		this.cursorOverlay?.destroy();
		this.engine?.destroy();

		this.leaf.detach = this.originalLeafDetach;
	}

	private renderView(): void {
		this.headerTitleEl.setText(`Sketchpad - ${this.fileName} (${this.documentState.width} x ${this.documentState.height}px)`);
		this.rebuildLayerSidebar();

		this.toolController?.syncToolbarLayerVisibility();
		this.toolController?.refreshToolSettingsUI();

		this.canvas.empty();
		this.canvas.removeClass('sketchpad-canvas-hidden');
		this.canvas.width = this.documentState.width;
		this.canvas.height = this.documentState.height;
		this.canvas.style.width = `${this.documentState.width}px`;
		this.canvas.style.height = `${this.documentState.height}px`;

		resizeSelectionOverlay(this.selectionCanvas, this.canvasPanel);

		this.gridCanvas.width = this.documentState.width;
		this.gridCanvas.height = this.documentState.height;
		this.gridCanvas.style.width = `${this.documentState.width}px`;
		this.gridCanvas.style.height = `${this.documentState.height}px`;

		this.canvasStack.style.width = `${this.documentState.width}px`;
		this.canvasStack.style.height = `${this.documentState.height}px`;

		this.viewport.view = this.viewport.fitDocumentToView();
		this.viewport.updateViewControlsUI();
		this.viewport.positionCanvasStack();
		this.viewport.applyViewTransform();
		this.viewport.updateCanvasPanelCursor();

		this.updateNoFileUI();
		this.render();
		window.requestAnimationFrame(() => {
			const nextView = this.viewport.fitDocumentToView();
			this.viewport.positionCanvasStack();
			if (nextView.zoom !== this.viewport.view.zoom) {
				this.viewport.view = nextView;
				this.viewport.applyViewTransform();
				this.render();
			}
		});
	}


	private updateNoFileUI(): void {
		const noFile = !this.hasOpenFile;
		this.leftSidebar.querySelectorAll<HTMLElement>('.sketchpad-layer-card, .sketchpad-layer-actions').forEach((card) => {
			card.style.display = noFile ? 'none' : '';
		});

		const viewControls = this.leftSidebar.querySelector('.sketchpad-view-controls');
		for (const child of Array.from(viewControls?.children ?? [])) {
			if (child.instanceOf(HTMLElement) && !child.classList.contains('sketchpad-expand-collapse-button')
				&& !child.classList.contains('sketchpad-panel-move-button')) {
				if (child.instanceOf(HTMLButtonElement) || child.instanceOf(HTMLInputElement)) {
					child.disabled = noFile;
				}
				child.style.opacity = noFile ? '0.4' : '';
			}
		}

		const gridToggleButton = this.leftSidebar.querySelector('.sketchpad-grid-toggle-button');
		if (gridToggleButton instanceof HTMLButtonElement) {
			gridToggleButton.disabled = noFile;
		}
		// The reorder toggle behaves the same way.
		const reorderToggleButton = this.leftSidebar.querySelector('.sketchpad-reorder-toggle-button');
		if (reorderToggleButton instanceof HTMLButtonElement) {
			reorderToggleButton.disabled = noFile;
		}

		this.updateGridOverlay();
	}

	private updateToolSettingsUI(): void {
		const tool = this.toolController?.getCurrentTool() ?? 'pencil';
		const isDrawingTool = tool === 'pencil' || tool === 'pen' || tool === 'brush' || tool === 'eraser' || tool === 'marker';
		const isEyedropper = tool === 'eyedropper';
		const isEraser = tool === 'eraser';

		const disabled = !this.toolSelected || !isDrawingTool;

		const keepColorPicker = isEyedropper && this.toolSelected;

		const disableColor = isEraser;
		const isColorControl = (el: Element): boolean =>
			el.classList.contains('sketchpad-color-picker') ||
			el.classList.contains('sketchpad-okhsl-slider') ||
			el.classList.contains('sketchpad-okhsl-swatch') ||
			el.classList.contains('sketchpad-okhsl-sliders');
		const isDimmed = (el: Element): boolean => {
			const isColor = isColorControl(el);
			// keeps color picker usable when eyedropper is active
			if (keepColorPicker && isColor) {
				return false;
			}
			// disables color controls when eraser is active
			return disabled || (disableColor && isColor);
		};

		this.rightSidebar
			.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
				'input, select, button:not(.sketchpad-expand-collapse-button):not(.sketchpad-panel-move-button)',
			)
			.forEach((el) => {
				el.disabled = isDimmed(el);
			});

		// blocks pressure curves' pointer events
		this.rightSidebar.querySelectorAll<HTMLCanvasElement>('.sketchpad-pressure-curve').forEach((canvas) => {
			canvas.style.pointerEvents = disabled ? 'none' : '';
		});

		// grey out everything in the vertical toolbar except the collapse button and the panel move button 
		const toolbar = this.rightSidebar.querySelector('.sketchpad-vertical-toolbar');
		for (const child of Array.from(toolbar?.children ?? [])) {
			if (child.instanceOf(HTMLElement) && !child.classList.contains('sketchpad-expand-collapse-button')
				&& !child.classList.contains('sketchpad-panel-move-button')) {
				child.style.opacity = isDimmed(child) ? '0.4' : '';
			}
		}

		// grey out everything in the settings panel except the title
		const settings = this.rightSidebar.querySelector('.sketchpad-tool-settings');
		for (const child of Array.from(settings?.children ?? [])) {
			if (child.instanceOf(HTMLElement) && !child.classList.contains('sketchpad-tool-sidebar-title')) {
				child.style.opacity = isDimmed(child) ? '0.4' : '';
			}
		}

		// grey out everything in the OKHSL color picker panel except the title
		const okhslPanel = this.rightSidebar.querySelector('.sketchpad-okhsl-color-picker');
		for (const child of Array.from(okhslPanel?.children ?? [])) {
			if (child.instanceOf(HTMLElement) && !child.classList.contains('sketchpad-tool-sidebar-title')) {
				child.style.opacity = isDimmed(child) ? '0.4' : '';
			}
		}
	}

	private applySidebarPositions(): void {
		if (!this.plugin.minimalUI) {
			return;
		}
		const shellWidth = this.sketchpadShell.offsetWidth;
		const shellHeight = this.sketchpadShell.offsetHeight;
		const MARGIN = 10; 
		const apply = (sidebar: HTMLElement, pos: { x: number; y: number } | null, anchor: 'left' | 'right'): void => {
			if (!pos) {
				return;
			}
			// Measure the panel's natural size with size constraints cleared
			// first. Clamping the position (sliding the panel inward) is
			// preferred over shrinking it, so the size limit must be computed
			// from the clamped position - not from the saved one.
			sidebar.style.removeProperty('max-width');
			sidebar.style.removeProperty('max-height');
			const naturalWidth = sidebar.offsetWidth;
			const naturalHeight = sidebar.offsetHeight;
			// Both anchors store the distance from their anchored edge and the
			// panel extends inward from it, so the fit bound is identical.
			const maxXPos = Math.max(0, shellWidth - MARGIN - naturalWidth);
			const maxYPos = Math.max(0, shellHeight - MARGIN - naturalHeight);
			const x = Math.max(0, Math.min(pos.x, maxXPos));
			const y = Math.max(0, Math.min(pos.y, maxYPos));
			// Constrain size to the space remaining from the clamped position.
			// The panel only shrinks when the shell itself is too small.
			sidebar.style.setProperty('max-height', `${Math.max(0, shellHeight - y - MARGIN)}px`);
			sidebar.style.setProperty('max-width', `${Math.max(0, shellWidth - x - MARGIN)}px`);
			sidebar.classList.add('sketchpad-panel-positioned');
			sidebar.style.setProperty(anchor === 'right' ? 'right' : 'left', `${x}px`);
			sidebar.style.setProperty('top', `${y}px`);
		};
		apply(this.leftSidebar, this.plugin.leftSidebarPos, 'left');
		apply(this.rightSidebar, this.plugin.rightSidebarPos, 'right');
	}

	resetSidebarPositions(): void {
		for (const sidebar of [this.leftSidebar, this.rightSidebar]) {
			sidebar.classList.remove('sketchpad-panel-positioned');
			sidebar.style.removeProperty('left');
			sidebar.style.removeProperty('right');
			sidebar.style.removeProperty('top');
			sidebar.style.removeProperty('max-width');
			sidebar.style.removeProperty('max-height');
		}
	}

	private switchTool(tool: ViewTool): void {
		this.hotkeyController?.clearTempToolHold();
		this.toolController?.setTool(tool);
	}

	// grows/shrinks the current draw tool's tip size by a perceptual slider step
	private adjustToolSize(delta: number): void {
		const tool = this.toolController?.getLastDrawTool() ?? 'pencil';
		const settings = this.plugin.toolSettings[tool];
		const slider = sizeToSlider(settings.size) + delta;
		const clamped = Math.max(0, Math.min(100, slider));
		let next = sliderToSize(clamped);
		//guarantee at least a 1px change when changing tool size
		if (next === settings.size) {
			next = Math.max(1, Math.min(TOOL_TIP_MAX_SIZE, settings.size + Math.sign(delta)));
		}
		settings.size = next;
		this.cursorOverlay?.refresh();
		this.toolController?.refreshToolSettingsUI();
		void this.plugin.saveToolSettings();
	}

	// marks the open file as changed since its last save/open
	private markDocumentDirty(): void {
		this.documentDirty = true;
	}

	private handleLayerChange(): void {
		this.toolController?.syncToolbarLayerVisibility();
		this.markDocumentDirty();
		this.render();
	}

	private handlePaperColorChange(color: string): void {
		this.documentState.paperColor = color;
		this.engine.setPaperColor(color);
		this.markDocumentDirty();
		this.render();
	}

	private syncLayerSidebarActive(): void {
		syncLayerSidebar(this.layerControls, this.toolController?.getActiveLayer() ?? 'Sketch');
	}

	private constructLayerSidebar(firstOpen: boolean): LayerControls {
		return buildLayerSidebar(
			this.leftSidebar,
			this.documentState.layers,
			() => this.handleLayerChange(),
			firstOpen,
			() => this.toolController?.getActiveLayer() ?? 'Sketch',
			(layer) => this.toolController?.activateLayer(layer),
			() => this.documentState.paperColor,
			(color) => this.handlePaperColorChange(color),
			() => this.plugin.gridEnabled,
			(enabled) => this.handleGridToggle(enabled),
			() => this.plugin.layerReorderEnabled,
			(enabled) => this.handleReorderToggle(enabled),
			(layer, direction) => this.handleMoveLayer(layer, direction),
			() => this.addExtraLayer(),
			() => this.openDeleteLayerModal(),
			() => this.canAddExtraLayer(),
		);
	}

	private canAddExtraLayer(): boolean {
		if (!this.hasOpenFile) {
			return false;
		}
		return !this.engine.isDrawing()
			&& countExtraLayers(this.documentState.layers) < MAX_EXTRA_LAYERS;
	}

	// adds a new extra layer on top of the layer stack and activates it with
	// the marker tool (the only drawing tool that targets the active layer)
	private addExtraLayer(): void {
		if (!this.hasOpenFile) {
			return;
		}
		if (this.engine.isDrawing()) {
			return;
		}
		if (!this.canAddExtraLayer()) {
			new Notice(`Extra layer limit reached (${MAX_EXTRA_LAYERS}).`);
			return;
		}
		const layer: OraLayer = {
			name: nextExtraLayerName(this.documentState.layers),
			opacity: 100,
			blendMode: 'normal',
			visible: true,
			x: 0,
			y: 0,
		};
		// layers are stored bottom-first: pushing appends to the top of the stack
		this.documentState.layers.push(layer);
		this.engine.addLayer(layer);
		this.refreshPreviewCaches();
		this.refreshUndoRedoUI();
		this.toolController.activateLayer(layer.name);
		this.handleLayerChange();
		this.rebuildLayerSidebar();
	}

	// opens the delete-layer modal listing the document's extra layers
	private openDeleteLayerModal(): void {
		if (!this.hasOpenFile) {
			return;
		}
		if (this.engine.isDrawing()) {
			return;
		}
		const extraLayers = this.documentState.layers
			.filter((layer) => !isFixedLayerName(layer.name))
			.map((layer) => layer.name);
		if (extraLayers.length == 0) {
			new Notice('There are no extra layers to delete')
			return;
		}
		new DeleteLayerModal(this.app, extraLayers, (name) => this.deleteExtraLayer(name)).open();
	}

	private deleteExtraLayer(layerName: string): void {
		if (this.engine.isDrawing() || isFixedLayerName(layerName)) {
			return;
		}
		const index = this.documentState.layers.findIndex((layer) => layer.name === layerName);
		if (index === -1) {
			return;
		}
		// discard any active selection (it may have lived on the deleted layer)
		this.selectionController?.cancelSelection();
		// discard any image placement gizmo may target the deleted layer
		this.imagePlacementController?.cancel();
		this.engine.removeLayer(layerName);
		this.refreshPreviewCaches();
		this.refreshUndoRedoUI();
		this.documentState.layers.splice(index, 1);
		// re-target the active layer if it pointed at the deleted layer
		if (this.toolController.getActiveLayer() === layerName) {
			const fallback = [...this.documentState.layers].reverse().find((layer) => layer.name !== 'Paper');
			this.toolController.activateLayer(fallback?.name ?? 'Sketch');
		}
		this.handleLayerChange();
		this.rebuildLayerSidebar();
	}


	private rebuildLayerSidebar(): void {
		this.layerControls = this.constructLayerSidebar(false);
		this.syncLayerSidebarActive();
		this.updateNoFileUI();
	}

	private render(): void {
		if (this.selectionController?.selectionActive) {
			this.selectionController.updateSelectionPreview();
			return;
		}
		if (this.imagePlacementController?.isActive()) {
			this.imagePlacementController.refreshPreview();
			return;
		}
		this.engine.renderBase();
	}

	// opens the import modal; on choose, starts the transform gizmo for the image on the chosen layer
	private openImportImageModal(): void {
		if (!this.hasOpenFile || this.engine.isDrawing()) {
			new Notice('No sketch file currently open');
			return;
		}
		if (this.selectionController?.selectionActive) {
			this.selectionController.commitSelection();
		}
		const layers = this.documentState.layers.filter((layer) => layer.name !== 'Paper');
		new ImportImageModal(this.app, layers, this.toolController?.getActiveLayer() ?? 'Sketch', (choice) => {
			if (choice) {
				void this.beginImagePlacement(choice.file, choice.layerName);
			}
		}).open();
	}

	// loads the image, starts the placement gizmo, and switches to the target layer (applying the gizmo bakes the transformed image into it)
	private async beginImagePlacement(file: TFile, layerName: LayerName): Promise<void> {
		if (!this.hasOpenFile || this.engine.isDrawing()) {
			new Notice('Open a sketch file before importing an image.');
			return;
		}
		if (this.selectionController?.selectionActive) {
			this.selectionController.commitSelection();
		}
		const layer = this.documentState.layers.find((entry) => entry.name === layerName);
		if (!layer || !this.imagePlacementController) {
			return;
		}
		this.toolController.activateLayer(layerName);
		this.canvasPanel.classList.remove(...toolCursorClasses);
		this.cursorOverlay?.setSuppressed(true);
		const resourcePath = this.app.vault.getResourcePath(file);
		const bounds = await this.imagePlacementController.begin(layer, resourcePath);
		if (!bounds) {
			this.viewport.updateCanvasPanelCursor();
			this.cursorOverlay?.setSuppressed(false);
			new Notice('Could not read the image file.');
			return;
		}
		// placement is represented by the lasso tool, the same way an active selection is
		this.switchTool('lasso');
	}

	performUndo(): void {
		if (this.engine.canUndo()) {
			const before = this.layerFingerprint();
			this.engine.undo();
			this.resyncLayerStructure(before);
			this.markDocumentDirty();
		}
		this.refreshUndoRedoUI();
		this.render();
	}

	performRedo(): void {
		if (this.engine.canRedo()) {
			const before = this.layerFingerprint();
			this.engine.redo();
			this.resyncLayerStructure(before);
			this.markDocumentDirty();
		}
		this.refreshUndoRedoUI();
		this.render();
	}

	// fingerprint of the document's layer list for undo/redo
	private layerFingerprint(): string {
		return this.documentState.layers.map((layer) => layer.name).join('|');
	}

	// resyncs the layer panel, the active layer, and any active selection
	// after a structural (layer add/delete) undo/redo
	private resyncLayerStructure(before: string): void {
		if (this.layerFingerprint() === before) {
			return;
		}
		// cancel a placement whose target layer no longer exists BEFORE any
		// activateLayer fallback below, which bakes an active placement
		if (this.imagePlacementController?.isActive() && !this.documentState.layers.some((layer) => layer.name === this.imagePlacementController?.getLayerName())) {
			this.imagePlacementController.cancel();
		}
		if (this.toolController && !this.documentState.layers.some((layer) => layer.name === this.toolController.getActiveLayer())) {
			const fallback = [...this.documentState.layers].reverse().find((layer) => layer.name !== 'Paper');
			this.toolController.activateLayer(fallback?.name ?? 'Sketch');
		}
		if (this.selectionController?.selectionLayerName && !this.documentState.layers.some((layer) => layer.name === this.selectionController?.selectionLayerName)) {
			this.selectionController.cancelSelection();
		}
		this.refreshPreviewCaches();
		this.toolController?.syncToolbarLayerVisibility();
		this.rebuildLayerSidebar();
	}

	private refreshPreviewCaches(): void {
		const activeLayer = this.toolController?.getActiveLayer();
		const layer = this.documentState.layers.find((entry) => entry.name === activeLayer);
		if (layer) {
			this.engine.refreshPreviewCaches(layer);
		}
	}

	flipCanvasHorizontal(): void {
		this.viewport.toggleFlip('flipX');
	}

	flipCanvasVertical(): void {
		this.viewport.toggleFlip('flipY');
	}

	fitToView(): void {
		this.viewport.fitDocumentToViewAndApply();
	}

	private refreshUndoRedoUI(): void {
		if (this.undoButton) {
			this.undoButton.disabled = !this.engine?.canUndo();
		}
		if (this.redoButton) {
			this.redoButton.disabled = !this.engine?.canRedo();
		}
	}

	// saves the current document back to its .ora file
	// autosave disables the saving notice by setting silent = true
	async saveDocument(silent = false): Promise<void> {
		try {
			if (!this.hasOpenFile) {
				return;
			}
			if (!this.documentState) {
				return;
			}

			const layerCanvases = await this.engine.snapshotLayerCanvases();
			const archive = buildOraArchive(this.documentState, layerCanvases);
			const file = this.app.vault.getAbstractFileByPath(this.filePath);
			if (file instanceof TFile) {
				await this.app.vault.modifyBinary(file, archive);
			} else {
				await this.app.vault.createBinary(this.filePath, archive);
			}
			this.documentDirty = false;
			if (!silent) {
				new Notice(`Saved ${this.fileName}`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Unable to save sketch: ${message}`);
		}
	}

	private openExportModal(): void {
		if (!this.hasOpenFile) {
			new Notice('No sketch file currently open');
			return;
		}
		const baseName = this.fileName.replace(/\.ora$/i, '') || 'sketch';
		const slash = this.filePath.lastIndexOf('/');
		const defaultFolder = slash === -1 ? undefined : this.filePath.slice(0, slash);
		new ExportFileModal(
			this.app,
			baseName,
			(choice) => {
				if (!choice) {
					return;
				}
				void this.exportMergedImage(choice.options.name, choice.options.folder);
			},
			defaultFolder,
		).open();
	}

	// flattens every visible layer into one PNG and writes it to the vault.
	private async exportMergedImage(name: string, folder: string): Promise<void> {
		try {
			if (!this.hasOpenFile || !this.documentState) {
				return;
			}
			const folderPath = normalizePath(folder?.trim() ?? '').replace(/^\/+|\/+$/g, '');
			const folderPrefix = folderPath ? `${folderPath}/` : '';
			let fileName = name.trim();
			if (!/\.png$/i.test(fileName)) {
				fileName += '.png';
			}
			const filePath = normalizePath(`${folderPrefix}${fileName}`);
			if (this.app.vault.getAbstractFileByPath(filePath)) {
				new Notice(`A file named ${fileName} already exists in that folder.`);
				return;
			}
			const layerCanvases = await this.engine.snapshotLayerCanvases();
			const bytes = buildMergedPngBytes(this.documentState, layerCanvases);
			await this.app.vault.createBinary(filePath, bytes);
			new Notice(`Exported ${fileName}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Unable to export sketch: ${message}`);
		}
	}

	public updateGridOverlay(): void {
		if (!this.gridCanvas) {
			return;
		}
		const visible = this.hasOpenFile && this.plugin.gridEnabled;
		this.gridCanvas.classList.toggle('sketchpad-grid-overlay-hidden', !visible);
		if (!visible) {
			clearGrid(this.gridCanvas);
			return;
		}
		drawGrid(
			this.gridCanvas,
			this.documentState.width,
			this.documentState.height,
			this.plugin.gridSize,
			this.plugin.gridColor,
			this.plugin.gridOpacity,
		);
	}

	public updatePredictionConfig(): void {
		this.drawingController?.updatePredictionConfig();
	}

	public updateCursorConfig(): void {
		this.cursorOverlay?.refresh();
	}

	private handleGridToggle(enabled: boolean): void {
		this.plugin.gridEnabled = enabled;
		void this.plugin.saveToolSettings();
		this.updateGridOverlay();
	}

	private handleReorderToggle(enabled: boolean): void {
		this.plugin.layerReorderEnabled = enabled;
		void this.plugin.saveToolSettings();
		this.rebuildLayerSidebar();
	}

	private handleMoveLayer(layerName: LayerName, direction: -1 | 1): void {
		if (this.selectionController?.selectionActive) {
			this.selectionController.commitSelection();
		}
		if (!reorderLayer(this.documentState.layers, layerName, direction)) {
			return;
		}
		this.refreshPreviewCaches();
		this.handleLayerChange();
		this.rebuildLayerSidebar();
	}
}
