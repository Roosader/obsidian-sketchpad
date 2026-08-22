import { ItemView, Notice, TFile, WorkspaceLeaf, normalizePath, setIcon, type ViewStateResult } from 'obsidian';
import { cloneDocument, DEFAULT_DOCUMENT, normalizeDocument, reorderLayer, applyDefaultLayerOrder } from '../technical/sketchpad-document';
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
import type SketchpadPlugin from '../main';
import type { LayerName, OraDocument, ViewTool } from '../utilities/types';
import { DEFAULT_FILE_NAME, TOOL_TIP_MAX_SIZE } from '../utilities/constants';
import { sampleDataUrlColor } from '../utilities/layer-colors';
import { blurControlFocusHandler } from '../utilities/utils';
import { parseOraArchive } from '../ora/ora-parser';
import { CanvasViewport } from '../technical/viewport';
import { ToolController } from './tool-controller';
import { SelectionController } from './selection-controller';
import { HotkeyController } from './hotkey-controller';
import { DrawingController } from './drawing-controller';

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
	private canvasPanel!: HTMLElement;

	private leftSidebar!: HTMLDivElement;
	private rightSidebar!: HTMLDivElement;

	private canvasStack!: HTMLDivElement;

	private selectionCanvas!: HTMLCanvasElement;

	private gridCanvas!: HTMLCanvasElement;

	private cursorOverlay?: CursorOverlay;

	private headerEl: HTMLElement;
	private headerTitleEl: HTMLElement;

	// feature controllers
	private viewport!: CanvasViewport;
	private selectionController!: SelectionController;
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

		const saveButton = this.headerEl.createEl('button', { text: 'Save' });
		saveButton.addClass('sketchpad-header-button');
		this.registerDomEvent(saveButton, 'click', () => void this.saveDocument());
		this.headerEl.insertAfter(saveButton, exportButton);

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
		this.documentState = cloneDocument(DEFAULT_DOCUMENT);
		this.filePath = '';
		this.fileName = DEFAULT_FILE_NAME;
		this.headerTitleEl.setText('Sketchpad');
		this.viewport.resetView();
		this.canvas.addClass('sketchpad-canvas-hidden');
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
		this.engine.setDocument(this.documentState, () => this.render());
		this.refreshUndoRedoUI();

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
		this.canvasPanel = this.sketchpadShell.createDiv({ cls: 'sketchpad-canvas-panel' });
		this.rightSidebar = this.sketchpadShell.createDiv({ cls: 'sketchpad-right-sidebar' });

		if (this.plugin.minimalUI) { 
			this.leftSidebar.classList.add('sketchpad-minimal');
			this.rightSidebar.classList.add('sketchpad-minimal');
		}

		this.canvasStack = this.canvasPanel.createDiv({ cls: 'sketchpad-canvas-stack' });
		this.canvasStack.appendChild(this.canvas);

		this.gridCanvas = createGridOverlay(this.canvasStack);
		
		this.selectionCanvas = createSelectionOverlay(this.canvasPanel);

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
		);
		const cursorResizeObserver = new ResizeObserver(() => this.cursorOverlay?.resize());
		cursorResizeObserver.observe(this.canvasPanel);
		this.register(() => cursorResizeObserver.disconnect());

		const selectionResizeObserver = new ResizeObserver(() => {
			this.viewport.positionCanvasStack();
			resizeSelectionOverlay(this.selectionCanvas, this.canvasPanel);
			this.selectionController?.refreshOverlay();
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

			onViewTransformChange: () => this.selectionController?.refreshOverlay(),

			onMultiTouchGestureStart: (wasTap) => {
				// hide the custom cursor while pan/zoom/rotate is active
				this.cursorOverlay?.handlePointerLeave();
				this.drawingController?.commitActiveStroke(wasTap);
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
			this.canvasPanel,
			this.plugin,
			null,
			() => this.toolController?.getCurrentTool() ?? 'pencil',
			(tool) => this.switchTool(tool),
		);

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

		this.toolController = new ToolController({
			plugin: this.plugin,
			getLayers: () => this.documentState.layers,
			engine: this.engine,
			viewport: this.viewport,
			getToolbar: () => this.toolbar,
			getToolSettingsSidebar: () => this.toolSettingsSidebar,
			commitSelection: () => this.selectionController?.commitSelection(),
			syncLayerSidebar: () => this.syncLayerSidebarActive(),
			hasOpenFile: () => this.hasOpenFile,
			onToolChange: () => {
				this.toolSelected = true;
				this.updateToolSettingsUI();
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
			getToolSettingsSidebar: () => this.toolSettingsSidebar,
		});

		// when available, raw pointer updates drive the custom cursor at native rate
		const supportsRawPointerUpdate = typeof window !== 'undefined' && 'onpointerrawupdate' in window;

		// panel-level pointer routing (handles pen drawing that starts off-canvas).
		this.registerDomEvent(this.canvasPanel, 'pointerdown', (event) => {
			this.cursorOverlay?.handlePointerDown(event.pointerType);
			this.drawingController?.pointerDown(event);
		});
		this.registerDomEvent(this.canvasPanel, 'pointerup', (event) => {
			this.drawingController?.pointerUp(event);
		});
		this.registerDomEvent(this.canvasPanel, 'pointermove', (event) => {
			if (!supportsRawPointerUpdate) {
				const overToolbar = (event.target as HTMLElement | null)?.closest('.sketchpad-toolbar') != null;
				if (overToolbar) {
					this.cursorOverlay?.handlePointerLeave();
				} else {
					this.cursorOverlay?.handlePointerMove(event.clientX, event.clientY, event.pointerType, event.buttons);
				}
			}
			this.drawingController?.pointerMove(event);
		});
		this.registerDomEvent(this.canvasPanel, 'pointercancel', (event) => {
			this.drawingController?.pointerUp(event);
		});
		this.registerDomEvent(this.canvasPanel, 'pointerleave', () => {
			this.cursorOverlay?.handlePointerLeave();
		});

		// Release focus from any button clicked inside this view (header +
		// content) so a later Space — used as a tool hotkey — doesn't natively
		// re-activate the last-clicked button. Capture phase so it also covers
		// buttons whose handlers stop propagation.
		this.registerDomEvent(this.containerEl, 'click', blurControlFocusHandler(), true);

		if (supportsRawPointerUpdate) {
		const onPanelRawUpdate = (event: Event): void => {
				const pe = event as PointerEvent;
				// move cursor first (cheap CSS transform) so it positions
				// immediately, before the heavy GPU work in handleRawPointerUpdate
				const overToolbar = (pe.target as HTMLElement | null)?.closest('.sketchpad-toolbar') != null;
				if (overToolbar) {
					this.cursorOverlay?.handlePointerLeave();
				} else {
					this.cursorOverlay?.handlePointerMove(pe.clientX, pe.clientY, pe.pointerType, pe.buttons);
				}
				// feed the active stroke at native device rate, ahead of the
				// rAF-aligned pointermove dispatch
				this.drawingController?.handleRawPointerUpdate(pe);
				// after the prediction engine has computed its offset, forward
				// it to the cursor overlay so the tool cursor stays aligned
				// with the predicted ink tip
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
			this.cursorOverlay?.handlePointerDown(event.pointerType);
			this.drawingController.handlePointerDown(event);
		});
		this.registerDomEvent(this.canvas, 'pointerenter', this.drawingController.handlePointerEnter);
		this.registerDomEvent(this.canvas, 'pointermove', (event) => {
			if (!supportsRawPointerUpdate) {
				this.cursorOverlay?.handlePointerMove(event.clientX, event.clientY, event.pointerType, event.buttons);
			}
			this.drawingController?.handlePointerMove(event);
		});
		this.registerDomEvent(this.canvas, 'pointerup', this.drawingController.handlePointerUp);
		this.registerDomEvent(this.canvas, 'pointerleave', this.drawingController.handlePointerUp);
		this.registerDomEvent(this.canvas, 'pointercancel', this.drawingController.handlePointerUp);
		this.registerDomEvent(window, 'keydown', this.hotkeyController.handleKeyDown);
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

	async onClose(): Promise<void> {
		this.filePath = '';
		this.hotkeyController?.clearTempToolHold();
		this.cursorOverlay?.destroy();
		this.engine?.destroy();
		// undo the tab-close interception installed in the constructor so this
		// view isn't retained through the leaf's detach closure.
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
		this.leftSidebar.querySelectorAll<HTMLElement>('.sketchpad-layer-card').forEach((card) => {
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

		const gridToggleRow = this.leftSidebar.querySelector('.sketchpad-grid-toggle-row');
		if (gridToggleRow instanceof HTMLElement) {
			gridToggleRow.style.opacity = noFile ? '0.4' : '';
			const gridCheckbox = gridToggleRow.querySelector('input[type="checkbox"]');
			if (gridCheckbox instanceof HTMLInputElement) {
				gridCheckbox.disabled = noFile;
			}
		}
		// The reorder toggle behaves the same way.
		const reorderToggleRow = this.leftSidebar.querySelector('.sketchpad-layer-toggle-row');
		if (reorderToggleRow instanceof HTMLElement) {
			reorderToggleRow.style.opacity = noFile ? '0.4' : '';
			const reorderCheckbox = reorderToggleRow.querySelector('input[type="checkbox"]');
			if (reorderCheckbox instanceof HTMLInputElement) {
				reorderCheckbox.disabled = noFile;
			}
		}

		this.updateGridOverlay();
	}

	private updateToolSettingsUI(): void {
		const tool = this.toolController?.getCurrentTool() ?? 'pencil';
		const isDrawingTool = tool === 'pencil' || tool === 'pen' || tool === 'brush' || tool === 'eraser';
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
			// constrain height: available = shell height − top position − bottom margin
			const availableHeight = Math.max(0, shellHeight - pos.y - MARGIN);
			sidebar.style.setProperty('max-height', `${availableHeight}px`);
			// constrain width: available = shell width − margin − distance from anchored edge
			const availableWidth = Math.max(0, shellWidth - MARGIN - pos.x);
			sidebar.style.setProperty('max-width', `${availableWidth}px`);
			// clamp position (uses updated offsetWidth/Height after max-width/max-height applied)
			const maxX = Math.max(0, shellWidth - sidebar.offsetWidth);
			const maxY = Math.max(0, shellHeight - sidebar.offsetHeight);
			const x = Math.min(Math.max(0, pos.x), maxX);
			const y = Math.min(Math.max(0, pos.y), maxY);
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
		// Rounding in the quadratic slider can collapse a small step back to the
		// same pixel size at the extremes (e.g. 1px -> 1px when increasing), which
		// makes the hotkey feel stuck. Guarantee at least a 1px change in the
		// intended direction so it always responds.
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
		);
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
		this.engine.renderBase();
	}

	performUndo(): void {
		if (this.engine.canUndo()) {
			this.engine.undo();
			this.markDocumentDirty();
		}
		this.refreshUndoRedoUI();
		this.render();
	}

	performRedo(): void {
		if (this.engine.canRedo()) {
			this.engine.redo();
			this.markDocumentDirty();
		}
		this.refreshUndoRedoUI();
		this.render();
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
		this.handleLayerChange();
		this.rebuildLayerSidebar();
	}
}
