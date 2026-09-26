import type { GpuContext } from '../rendering/gpu-context';
import {
	MASK_TEXTURE_FORMAT,
	clearTexture,
	copyTexture,
	copyTextureRegion,
	createLayerTexture,
	destroyTexture,
	fillSolidColor,
	loadImageIntoTexture,
	readTextureToCanvas,
	type GpuTexture,
	writeCanvasToTexture,
} from '../rendering/gpu-texture-layer';
import { BLIT_SHADER, LAYER_COMPOSITE_SHADER, SELECTION_EXTRACT_SHADER, SELECTION_QUAD_SHADER, STAMP_SHADER, STROKE_BUILD_SHADER, STROKE_COMPOSITE_SHADER, STROKE_PREVIEW_SHADER, type ShaderSource } from '../rendering/shaders';
import { TextureHistoryStack } from '../history/texture-history';
import { getLayerFallbackColor } from '../utilities/layer-colors';
import { buildPressureCurveSampler, type PressureCurveSampler } from './pressure-curve';
import type { DrawingEngine } from './drawing-engine';
import { DEFAULT_SELECTION_TRANSFORM, getTransformedCorners } from './selection-geometry';
import type { LayerName, OraDocument, OraLayer, Point, SelectionBounds, SelectionTransform, Stroke, StrokeParams, ToolName } from '../utilities/types';

type Bounds = { left: number; top: number; right: number; bottom: number };
const EMPTY_BOUNDS: Bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };

interface ScissorRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface ProgramInfo {
	program: WebGLProgram;
	uniforms: Record<string, WebGLUniformLocation>;
}

export class GpuStrokeEngine implements DrawingEngine {
	private readonly gl: WebGL2RenderingContext;
	private readonly canvas: HTMLCanvasElement;
	private readonly maxBlendEquation: number;
	private readonly nearestSampler: WebGLSampler;
	private readonly mipmapSampler: WebGLSampler;
	private readonly linearSampler: WebGLSampler;
	private readonly emptyVao: WebGLVertexArrayObject;
	private readonly stampVao: WebGLVertexArrayObject;

	private readonly stampProgram: ProgramInfo;
	private readonly strokeBuildProgram: ProgramInfo;
	private readonly strokeCompositeProgram: ProgramInfo;
	private readonly layerCompositeProgram: ProgramInfo;
	private readonly strokePreviewProgram: ProgramInfo;
	private readonly blitProgram: ProgramInfo;
	private readonly selectionExtractProgram: ProgramInfo;
	private readonly selectionQuadProgram: ProgramInfo;

	private documentState: OraDocument;
	private width = 0;
	private height = 0;
	private destroyed = false;

	private layerTextures: Map<LayerName, GpuTexture> = new Map();
	private history: TextureHistoryStack;

	private scratchA!: GpuTexture;
	private scratchB!: GpuTexture;
	private belowCacheTex!: GpuTexture;
	private aboveCacheTex!: GpuTexture;
	private baselineTex!: GpuTexture;
	private maskTex!: GpuTexture;
	private strokeColorTex!: GpuTexture;
	private previewComposeTex!: GpuTexture;
	private selectionMaskTex!: GpuTexture;
	private selectionColorTex!: GpuTexture;
	// snapshot of the layer's pixels taken right before selection
	private selectionOriginalTex!: GpuTexture;
	private selectionBounds: SelectionBounds | null = null;
	private selectionLayerName: LayerName | null = null;

	private instanceBuffer: WebGLBuffer | null = null;
	private instanceCapacityBytes = 0;
	// growable scratch buffer for stamp instance data — avoids allocating a
	// new Float32Array (or number[]) on every pointermove while drawing.
	private stampData = new Float32Array(0);
	private stampWriteIndex = 0; // next free slot in stampData (floats)

	private currentStroke: Stroke | null = null;
	private sizeSampler: PressureCurveSampler | null = null;
	private opacitySampler: PressureCurveSampler | null = null;
	private lastRenderedPoint = 0;
	private strokeBounds: Bounds = { ...EMPTY_BOUNDS };
	private dirtyBounds: Bounds = { ...EMPTY_BOUNDS };
	// pointer prediction: trailing points appended from the browser's
	// getPredictedEvents() that render into the live preview but are rolled
	// back before the stroke commits. The backup texture snapshots the mask
	// region the predicted stamps touch so they can be erased again.
	private predictedBackupTex!: GpuTexture;
	private predictedBackupRect: ScissorRect | null = null;
	private predictedCount = 0;
	private rgbColor = { r: 0, g: 0, b: 0 };
	private lastStackResult!: GpuTexture;
	// persistent full-canvas framebuffer holding the last composited frame
	private displayTex!: GpuTexture;

	private activeLayerHasMultiplyAbove = false;

	// active image placement (import): the full-canvas texture holding the
	// image being transformed, and its placement bounds
	private imagePlacement: { layerName: LayerName; imageTexture: GpuTexture; bounds: SelectionBounds } | null = null;
	
	// used to check if the file has changed since last save
	private onChange?: () => void;

	constructor(documentState: OraDocument, canvas: HTMLCanvasElement, gpu: GpuContext, onChange?: () => void) {
		this.canvas = canvas;
		this.documentState = documentState;
		this.maxBlendEquation = gpu.maxBlendEquation;
		this.onChange = onChange;

		const context = canvas.getContext('webgl2', { alpha: false, antialias: false, desynchronized: false });
		if (!context) {
			throw new Error('WebGL2 context unavailable on this canvas');
		}
		this.gl = context;
		this.gl.disable(this.gl.DEPTH_TEST);
		this.gl.disable(this.gl.CULL_FACE);

		this.nearestSampler = this.createSampler(this.gl.NEAREST);
		this.linearSampler = this.createSampler(this.gl.LINEAR);
		this.mipmapSampler = this.createSampler(this.gl.LINEAR_MIPMAP_LINEAR, this.gl.LINEAR);
		this.emptyVao = this.requireVertexArray();
		this.stampVao = this.requireVertexArray();

		this.stampProgram = this.createProgram(STAMP_SHADER, ['uCanvasSize']);
		this.strokeBuildProgram = this.createProgram(STROKE_BUILD_SHADER, ['uColor', 'uMode', 'uMaskTex', 'uBaselineTex']);
		this.strokeCompositeProgram = this.createProgram(STROKE_COMPOSITE_SHADER, ['uMode', 'uStrokeTex', 'uBaseTex']);
		this.layerCompositeProgram = this.createProgram(LAYER_COMPOSITE_SHADER, ['uOpacity', 'uBlendMode', 'uSrcTex', 'uDstTex']);
		this.strokePreviewProgram = this.createProgram(STROKE_PREVIEW_SHADER, ['uOpacity', 'uBlendMode', 'uBelowTex', 'uStrokeTex', 'uAboveTex']);
		this.blitProgram = this.createProgram(BLIT_SHADER, ['uSourceTex']);
		this.selectionExtractProgram = this.createProgram(SELECTION_EXTRACT_SHADER, ['uSourceTex', 'uMaskTex']);
		this.selectionQuadProgram = this.createProgram(SELECTION_QUAD_SHADER, ['uCanvasSize', 'uSelectionCenter', 'uTranslate', 'uRotation', 'uScale', 'uSelectionTex', 'uDstTex', 'uImageOrigin', 'uImageSize', 'uImagePlacement']);

		this.history = new TextureHistoryStack(this.gl, documentState.width, documentState.height);
		this.allocateForDocument(documentState, () => {});
	}

	isDrawing(): boolean {
		return this.currentStroke !== null;
	}

	setDocument(documentState: OraDocument, onLayerReady: () => void): void {
		this.documentState = documentState;
		this.allocateForDocument(documentState, onLayerReady);
	}

	setPaperColor(color: string): void {
		this.documentState.paperColor = color;
		const paperTex = this.layerTextures.get('Paper');
		if (paperTex) {
			const [r, g, b] = this.hexToRgb255(color || getLayerFallbackColor('Paper'));
			fillSolidColor(this.gl, paperTex, this.width, this.height, [r, g, b, 255]);
		}
	}

	appendPoint(point: Point): void {
		this.currentStroke?.points.push(point);
	}

	// appends browser-predicted points that extend the live preview ahead of the latest real sample
	appendPredictedTail(points: Point[]): void {
		if (this.destroyed || !this.currentStroke || points.length === 0) {
			return;
		}
		const savedDirty = { ...this.dirtyBounds };
		this.updateStrokeTextures();
		if (savedDirty.left !== Infinity) {
			this.dirtyBounds.left = Math.min(this.dirtyBounds.left, savedDirty.left);
			this.dirtyBounds.top = Math.min(this.dirtyBounds.top, savedDirty.top);
			this.dirtyBounds.right = Math.max(this.dirtyBounds.right, savedDirty.right);
			this.dirtyBounds.bottom = Math.max(this.dirtyBounds.bottom, savedDirty.bottom);
		}

		const strokePoints = this.currentStroke.points;
		const anchor = strokePoints[strokePoints.length - 1];
		if (!anchor) {
			return;
		}

		// predicted stamps lie on segments from the anchor through the predicted
		// points; expand by a couple of stamp diameters so the snapshot covers
		// every stamp the tail can produce
		const margin = this.currentStroke.size * 2;
		let left = anchor.x;
		let top = anchor.y;
		let right = anchor.x;
		let bottom = anchor.y;
		for (const point of points) {
			left = Math.min(left, point.x);
			top = Math.min(top, point.y);
			right = Math.max(right, point.x);
			bottom = Math.max(bottom, point.y);
		}
		const x = Math.max(0, Math.floor(left - margin));
		const y = Math.max(0, Math.floor(top - margin));
		const width = Math.min(this.width, Math.ceil(right + margin)) - x;
		const height = Math.min(this.height, Math.ceil(bottom + margin)) - y;
		if (width <= 0 || height <= 0) {
			return;
		}

		copyTextureRegion(this.gl, this.maskTex, this.predictedBackupTex, x, y, x, y, width, height);
		this.predictedBackupRect = { x, y, width, height };
		for (const point of points) {
			strokePoints.push(point);
		}
		this.predictedCount = points.length;
	}

	// removes predicted points and restores the mask + composited-preview regions they stamped
	rollbackPredictedTail(): void {
		if (!this.currentStroke || this.predictedCount === 0) {
			return;
		}
		const rect = this.predictedBackupRect;
		if (rect) {
			copyTextureRegion(this.gl, this.predictedBackupTex, this.maskTex, rect.x, rect.y, rect.x, rect.y, rect.width, rect.height);

			copyTextureRegion(this.gl, this.baselineTex, this.previewComposeTex, rect.x, rect.y, rect.x, rect.y, rect.width, rect.height);
			this.dirtyBounds.left = Math.min(this.dirtyBounds.left, rect.x);
			this.dirtyBounds.top = Math.min(this.dirtyBounds.top, rect.y);
			this.dirtyBounds.right = Math.max(this.dirtyBounds.right, rect.x + rect.width);
			this.dirtyBounds.bottom = Math.max(this.dirtyBounds.bottom, rect.y + rect.height);
		}
		const realCount = this.currentStroke.points.length - this.predictedCount;
		this.currentStroke.points.length = realCount;
		this.lastRenderedPoint = Math.min(this.lastRenderedPoint, realCount);
		this.predictedBackupRect = null;
		this.predictedCount = 0;
	}

	beginStroke(layer: OraLayer, point: Point, stroke: StrokeParams & { tool: ToolName }): void {
		this.currentStroke = { ...stroke, points: [point] };
		this.sizeSampler = stroke.pressureSize ? buildPressureCurveSampler(stroke.pressureSizeCurve) : null;
		this.opacitySampler = stroke.pressureOpacity ? buildPressureCurveSampler(stroke.pressureOpacityCurve) : null;
		this.rgbColor = this.parseColor(stroke.color);
		this.lastRenderedPoint = 0;
		this.strokeBounds = { ...EMPTY_BOUNDS };
		this.dirtyBounds = { ...EMPTY_BOUNDS };
		this.predictedBackupRect = null;
		this.predictedCount = 0;

		clearTexture(this.gl, this.maskTex);
		clearTexture(this.gl, this.strokeColorTex);
		this.prepareStrokeCaches(layer);
	}

	finishStroke(layer: OraLayer): void {
		if (!this.currentStroke || this.currentStroke.points.length === 0) {
			this.history.cancelStroke();
			this.currentStroke = null;
			this.sizeSampler = null;
			this.opacitySampler = null;
			return;
		}

		// predicted points are preview-only; strip them before the stroke is baked into the layer texture
		this.rollbackPredictedTail();
		this.updateStrokeTextures();

		const liveTex = this.layerTextures.get(layer.name);
		const scissor = this.toScissorRect(this.strokeBounds);
		if (liveTex && scissor) {
			// snapshot the region that is about to change before compositing, so undo only stores (and restores) the pixels the stroke touched
			this.history.commitStroke(layer.name, liveTex, scissor);
			this.runStrokeCompositePass(liveTex, this.strokeColorTex, this.baselineTex, this.strokeCompositeMode(), scissor);
		} else {
			this.history.cancelStroke();
		}

		this.onChange?.();
		this.currentStroke = null;
		this.sizeSampler = null;
		this.opacitySampler = null;
	}

	cancelStroke(): void {
		if (!this.currentStroke) {
			return;
		}
		this.history.cancelStroke();
		this.currentStroke = null;
		this.sizeSampler = null;
		this.opacitySampler = null;
		this.predictedBackupRect = null;
		this.predictedCount = 0;
	}

	renderBase(): void {
		if (this.destroyed) {
			return;
		}
		this.compositeLayerStack(this.documentState.layers, this.scratchA, this.scratchB, { r: 1, g: 1, b: 1, a: 1 });
		this.presentComposite();
	}

	// copies the just-composited stack into the persistent display texture and presents it to the canvas
	private presentComposite(): void {
		copyTexture(this.gl, this.lastStackResult, this.displayTex, this.width, this.height);
		this.blit(this.displayTex);
	}

	drawPreview(layer: OraLayer, fallbackColor: string): void {
		void fallbackColor;
		if (this.destroyed || !this.currentStroke || this.currentStroke.points.length === 0) {
			return;
		}

		const scissor = this.updateStrokeTextures();
		if (!scissor) {
			return;
		}

		if (this.activeLayerHasMultiplyAbove) {
			// a multiply layer above the active layer can't be pre-composited into the above-cache,so composite the full stack live
			this.compositeLayerStackWithSubstitution(this.documentState.layers, layer.name, this.previewComposeTex, this.scratchA, this.scratchB);
			this.presentComposite();
		} else {
			const opacity = layer.opacity / 100;
			const blendMode = layer.blendMode === 'multiply' ? 1 : 0;
			// single pass composites below + stroke + above into the persistent
			// display texture, scissored to the newly-dirtied region so fragment
			// work scales with the stroke instead of the whole document.
			this.runStrokePreviewPass(this.belowCacheTex, this.previewComposeTex, this.aboveCacheTex, opacity, blendMode, scissor);
			this.blit(this.displayTex);
		}
	}

	hasSelection(): boolean {
		return this.selectionBounds !== null;
	}

	getSelectionBounds(): SelectionBounds | null {
		return this.selectionBounds;
	}

	drawSelectionPreview(layer: OraLayer, transform: SelectionTransform): void {
		if (!this.selectionBounds || this.selectionLayerName !== layer.name) {
			return;
		}

		// keep the layer exactly as it was if selection is untouched
		if (this.isIdentitySelectionTransform(transform)) {
			copyTexture(this.gl, this.selectionOriginalTex, this.previewComposeTex, this.width, this.height);
		} else {
			copyTexture(this.gl, this.baselineTex, this.previewComposeTex, this.width, this.height);
			this.runSelectionQuadPass(this.previewComposeTex, transform);
		}

		if (this.activeLayerHasMultiplyAbove) {
			this.compositeLayerStackWithSubstitution(this.documentState.layers, layer.name, this.previewComposeTex, this.scratchA, this.scratchB);
			this.presentComposite();
		} else {
			const opacity = layer.opacity / 100;
			const blendMode = layer.blendMode === 'multiply' ? 1 : 0;
			this.runStrokePreviewPass(this.belowCacheTex, this.previewComposeTex, this.aboveCacheTex, opacity, blendMode);
			this.blit(this.displayTex);
		}
	}

	beginSelection(layer: OraLayer, polygon: Point[]): void {
		const liveTex = this.layerTextures.get(layer.name);
		if (!liveTex || polygon.length < 3) {
			return;
		}

		let left = Infinity;
		let top = Infinity;
		let right = -Infinity;
		let bottom = -Infinity;
		for (const point of polygon) {
			left = Math.min(left, point.x);
			top = Math.min(top, point.y);
			right = Math.max(right, point.x);
			bottom = Math.max(bottom, point.y);
		}
		left = Math.max(0, Math.floor(left));
		top = Math.max(0, Math.floor(top));
		right = Math.min(this.width, Math.ceil(right));
		bottom = Math.min(this.height, Math.ceil(bottom));
		if (right <= left || bottom <= top) {
			return;
		}

		// mask only needs to cover the selection's own bounding box
		clearTexture(this.gl, this.selectionMaskTex);
		const maskWidth = right - left;
		const maskHeight = bottom - top;
		const maskCanvas = createEl('canvas');
		maskCanvas.width = maskWidth;
		maskCanvas.height = maskHeight;
		const ctx = maskCanvas.getContext('2d');
		if (!ctx) {
			return;
		}
		ctx.fillStyle = '#ffffff';
		ctx.beginPath();
		ctx.moveTo(polygon[0]!.x - left, polygon[0]!.y - top);
		for (const point of polygon.slice(1)) {
			ctx.lineTo(point.x - left, point.y - top);
		}
		ctx.closePath();
		ctx.fill();
		writeCanvasToTexture(this.gl, this.selectionMaskTex, maskCanvas, maskWidth, maskHeight, left, top);

		this.selectionLayerName = layer.name;
		this.selectionBounds = { left, top, width: right - left, height: bottom - top };

		this.history.beginSelectionSnapshot(layer.name, liveTex);
		// copy layer before the selection hole is cut 
		copyTexture(this.gl, liveTex, this.selectionOriginalTex, this.width, this.height);
		this.runSelectionExtractPass(liveTex);

		const scissor = this.toScissorRect({ left, top, right, bottom });
		if (scissor) {
			copyTexture(this.gl, liveTex, this.baselineTex, this.width, this.height);
			this.runStrokeCompositePass(liveTex, this.selectionMaskTex, this.baselineTex, 1, scissor);
		}

		copyTexture(this.gl, liveTex, this.baselineTex, this.width, this.height);
		this.computeLayerCaches(layer);
	}

	commitSelection(layer: OraLayer, transform: SelectionTransform): void {
		if (!this.selectionBounds || this.selectionLayerName !== layer.name) {
			return;
		}
		const liveTex = this.layerTextures.get(layer.name);
		if (liveTex) {
			if (this.isIdentitySelectionTransform(transform)) {
				copyTexture(this.gl, this.selectionOriginalTex, liveTex, this.width, this.height);
				this.history.cancelStroke();
			} else {
				this.runSelectionQuadPass(liveTex, transform);
				this.history.commitSelectionSnapshot();
				this.onChange?.();
			}
		}
		this.selectionBounds = null;
		this.selectionLayerName = null;
	}

	cancelSelection(layer: OraLayer): void {
		if (!this.selectionBounds || this.selectionLayerName !== layer.name) {
			return;
		}
		this.history.cancelSelectionAndRestore(this.layerTextures);
		this.selectionBounds = null;
		this.selectionLayerName = null;
	}
	// adds a texture for a layer already appended to documentState.layers
	// (extra layers). Incremental: existing layer content is untouched.
	// Registers the addition as an undoable structural history entry.
	addLayer(layer: OraLayer): void {
		if (this.destroyed || this.layerTextures.has(layer.name)) {
			return;
		}
		this.layerTextures.set(layer.name, createLayerTexture(this.gl, this.width, this.height));
		const index = this.documentState.layers.findIndex((entry) => entry.name === layer.name);
		this.history.pushAddLayer(layer, index === -1 ? this.documentState.layers.length - 1 : index);
		this.renderBase();
	}

	// removes a layer's texture after the layer was removed from
	// documentState.layers (extra layers), registering the removal as an
	// undoable structural history entry. The texture's ownership transfers
	// to the history entry so the removal can be undone. Note the map entry
	// is deleted before the history entry takes ownership: a failure between
	// those two steps would lose the texture, so keep them adjacent and
	// side-effect free.
	removeLayer(name: string): void {
		if (this.destroyed) {
			return;
		}
		const texture = this.layerTextures.get(name);
		if (!texture) {
			return;
		}
		const layer = this.documentState.layers.find((entry) => entry.name === name);
		const index = this.documentState.layers.findIndex((entry) => entry.name === name);
		if (this.selectionLayerName === name) {
			this.selectionBounds = null;
			this.selectionLayerName = null;
		}
		this.layerTextures.delete(name);
		if (layer) {
			this.history.pushRemoveLayer(layer, index === -1 ? 0 : index, texture);
		} else {
			// no metadata to record: the removal cannot be undone
			destroyTexture(this.gl, texture);
		}
		this.renderBase();
	}

	// --- image placement (import) ------------------------------------------

	// loads an image into a temporary full-canvas texture and starts the
	// placement preview on the given layer
	async beginImagePlacement(layer: OraLayer, imageDataUrl: string): Promise<SelectionBounds | null> {
		if (this.destroyed || this.currentStroke || this.imagePlacement) {
			return null;
		}
		const image = new Image();
		image.src = imageDataUrl;
		try {
			await image.decode();
		} catch {
			// corrupt or unreadable file: let the caller show its notice
			return null;
		}
		// rasterize at natural resolution (clamped to the texture size limit)
		// so transforms sample the original pixels rather than a doc-bounded copy
		const maxSide = Math.min(4096, Number(this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE)) || 4096);
		const naturalWidth = image.naturalWidth || maxSide;
		const naturalHeight = image.naturalHeight || maxSide;
		const fit = Math.min(1, maxSide / naturalWidth, maxSide / naturalHeight);
		const width = Math.max(1, Math.round(naturalWidth * fit));
		const height = Math.max(1, Math.round(naturalHeight * fit));
		const texture = createLayerTexture(this.gl, width, height);
		const raster = createEl('canvas');
		raster.width = width;
		raster.height = height;
		const context = raster.getContext('2d');
		if (!context) {
			destroyTexture(this.gl, texture);
			return null;
		}
		context.imageSmoothingQuality = 'high';
		context.drawImage(image, 0, 0, width, height);
		writeCanvasToTexture(this.gl, texture, raster, width, height);
		// mipmaps so shrinking the image during placement stays clean
		this.gl.bindTexture(this.gl.TEXTURE_2D, texture.texture);
		this.gl.generateMipmap(this.gl.TEXTURE_2D);
		this.gl.bindTexture(this.gl.TEXTURE_2D, null);
		const liveTex = this.layerTextures.get(layer.name);
		if (liveTex) {
			copyTexture(this.gl, liveTex, this.baselineTex, this.width, this.height);
		}
		this.computeLayerCaches(layer);
		const docWidth = Math.max(1, this.width);
		const docHeight = Math.max(1, this.height);
		const placedFit = Math.min(1, docWidth / width, docHeight / height);
		const placedWidth = Math.max(1, Math.round(width * placedFit));
		const placedHeight = Math.max(1, Math.round(height * placedFit));
		const bounds: SelectionBounds = {
			left: Math.round((docWidth - placedWidth) / 2),
			top: Math.round((docHeight - placedHeight) / 2),
			width: placedWidth,
			height: placedHeight,
		};
		this.imagePlacement = { layerName: layer.name, imageTexture: texture, bounds };
		this.drawImagePlacementPreview(layer, { ...DEFAULT_SELECTION_TRANSFORM });
		return bounds;
	}

	hasImagePlacement(): boolean {
		return this.imagePlacement !== null;
	}

	// renders the layer with the transformed image over it (same present
	// plumbing as the stroke preview, including the multiply-above path)
	drawImagePlacementPreview(layer: OraLayer, transform: SelectionTransform): void {
		if (this.destroyed || !this.imagePlacement || this.imagePlacement.layerName !== layer.name) {
			return;
		}
		copyTexture(this.gl, this.baselineTex, this.previewComposeTex, this.width, this.height);
		this.runImageQuadPass(this.previewComposeTex, transform);
		if (this.activeLayerHasMultiplyAbove) {
			this.compositeLayerStackWithSubstitution(this.documentState.layers, layer.name, this.previewComposeTex, this.scratchA, this.scratchB);
			this.presentComposite();
		} else {
			const opacity = layer.opacity / 100;
			const blendMode = layer.blendMode === 'multiply' ? 1 : 0;
			this.runStrokePreviewPass(this.belowCacheTex, this.previewComposeTex, this.aboveCacheTex, opacity, blendMode);
			this.blit(this.displayTex);
		}
	}

	// bakes the transformed image into the live layer texture, snapshotting
	// the affected region first so the apply is undoable
	commitImagePlacement(layer: OraLayer, transform: SelectionTransform): void {
		if (this.destroyed || !this.imagePlacement || this.imagePlacement.layerName !== layer.name) {
			return;
		}
		const liveTex = this.layerTextures.get(layer.name);
		if (!liveTex) {
			this.cancelImagePlacement();
			return;
		}
		let left = Infinity;
		let top = Infinity;
		let right = -Infinity;
		let bottom = -Infinity;
		for (const corner of getTransformedCorners(this.imagePlacement.bounds, transform)) {
			left = Math.min(left, corner.x);
			top = Math.min(top, corner.y);
			right = Math.max(right, corner.x);
			bottom = Math.max(bottom, corner.y);
		}
		left = Math.max(0, Math.floor(left));
		top = Math.max(0, Math.floor(top));
		right = Math.min(this.width, Math.ceil(right));
		bottom = Math.min(this.height, Math.ceil(bottom));
		if (right > left && bottom > top) {
			this.history.beginStroke(layer.name);
			this.history.commitStroke(layer.name, liveTex, { x: left, y: top, width: right - left, height: bottom - top });
			this.runImageQuadPass(liveTex, transform);
			this.onChange?.();
		}
		this.cancelImagePlacement();
	}

	// discards the placement without touching the layer
	cancelImagePlacement(): void {
		if (!this.imagePlacement) {
			return;
		}
		destroyTexture(this.gl, this.imagePlacement.imageTexture);
		this.imagePlacement = null;
		this.renderBase();
	}

	// renders the placement image transformed (translate/rotate/scale about
	// the placement center) onto the target, compositing over its contents
	private runImageQuadPass(target: GpuTexture, transform: SelectionTransform): void {
		if (!this.imagePlacement) {
			return;
		}
		const bounds = this.imagePlacement.bounds;
		const centerX = bounds.left + bounds.width / 2;
		const centerY = bounds.top + bounds.height / 2;
		copyTexture(this.gl, target, this.scratchA, this.width, this.height);
		copyTexture(this.gl, target, this.scratchB, this.width, this.height);
		this.bindTarget(this.scratchB, null, null);
		this.gl.useProgram(this.selectionQuadProgram.program);
		this.gl.uniform2f(this.uniform(this.selectionQuadProgram, 'uCanvasSize'), this.width, this.height);
		this.gl.uniform2f(this.uniform(this.selectionQuadProgram, 'uSelectionCenter'), centerX, centerY);
		this.gl.uniform1f(this.uniform(this.selectionQuadProgram, 'uImagePlacement'), 1.0);
		this.gl.uniform2f(this.uniform(this.selectionQuadProgram, 'uImageOrigin'), bounds.left, bounds.top);
		this.gl.uniform2f(this.uniform(this.selectionQuadProgram, 'uImageSize'), bounds.width, bounds.height);
		
		const translationOnly = this.isTranslationOnlySelectionTransform(transform);
		const translateX = translationOnly ? Math.round(transform.translateX) : transform.translateX;
		const translateY = translationOnly ? Math.round(transform.translateY) : transform.translateY;
		this.gl.uniform2f(this.uniform(this.selectionQuadProgram, 'uTranslate'), translateX, translateY);
		this.gl.uniform1f(this.uniform(this.selectionQuadProgram, 'uRotation'), transform.rotation);
		this.gl.uniform2f(this.uniform(this.selectionQuadProgram, 'uScale'), transform.scaleX, transform.scaleY);
		this.bindTexture(0, this.imagePlacement.imageTexture, this.isPixelExactImagePlacement(transform) ? this.nearestSampler : this.mipmapSampler);
		this.bindTexture(1, this.scratchA, this.nearestSampler);
		this.gl.uniform1i(this.uniform(this.selectionQuadProgram, 'uSelectionTex'), 0);
		this.gl.uniform1i(this.uniform(this.selectionQuadProgram, 'uDstTex'), 1);
		this.gl.bindVertexArray(this.emptyVao);
		this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
		this.cleanupDrawState();
		copyTexture(this.gl, this.scratchB, target, this.width, this.height);
	}

	// true when the selection hasn't been moved, rotated, or scaled 
	private isIdentitySelectionTransform(transform: SelectionTransform): boolean {
		const EPS = 1e-6;
		return (
			Math.abs(transform.translateX) <= EPS &&
			Math.abs(transform.translateY) <= EPS &&
			Math.abs(transform.rotation) <= EPS &&
			Math.abs(transform.scaleX - 1) <= EPS &&
			Math.abs(transform.scaleY - 1) <= EPS
		);
	}

	// true when the selection has only been moved (no rotation or scale)
	private isTranslationOnlySelectionTransform(transform: SelectionTransform): boolean {
		const EPS = 1e-6;
		return (
			Math.abs(transform.rotation) <= EPS &&
			Math.abs(transform.scaleX - 1) <= EPS &&
			Math.abs(transform.scaleY - 1) <= EPS
		);
	}

	// true when the placement draws the image texture 1:1 onto the canvas
	// so nearest sampling is exact (pixel art stays crisp)
	private isPixelExactImagePlacement(transform: SelectionTransform): boolean {
		const placement = this.imagePlacement;
		if (!placement || !this.isTranslationOnlySelectionTransform(transform)) {
			return false;
		}
		const destWidth = placement.bounds.width * transform.scaleX;
		const destHeight = placement.bounds.height * transform.scaleY;
		return (
			Math.abs(destWidth - placement.imageTexture.width) < 0.5 &&
			Math.abs(destHeight - placement.imageTexture.height) < 0.5
		);
	}


	async snapshotLayerCanvases(): Promise<Map<LayerName, HTMLCanvasElement>> {
		const result = new Map<LayerName, HTMLCanvasElement>();
		for (const [name, texture] of this.layerTextures) {
			result.set(name, await readTextureToCanvas(this.gl, texture, this.width, this.height));
		}
		return result;
	}

	sampleFlattenedPixel(x: number, y: number): { r: number; g: number; b: number; a: number } | null {
		if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
			return null;
		}

		this.compositeLayerStack(this.documentState.layers, this.scratchA, this.scratchB, { r: 1, g: 1, b: 1, a: 1 });
		const pixel = new Uint8Array(4);
		this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.lastStackResult.framebuffer);
		this.gl.readPixels(x, this.height - 1 - y, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixel);
		this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);

		return {
			r: pixel[0] ?? 0,
			g: pixel[1] ?? 0,
			b: pixel[2] ?? 0,
			a: pixel[3] ?? 0,
		};
	}

	canUndo(): boolean {
		return this.history.canUndo;
	}

	canRedo(): boolean {
		return this.history.canRedo;
	}

	undo(): void {
		this.history.undo(this.layerTextures, this.documentState);
		this.pruneMissingSelection();
	}

	redo(): void {
		this.history.redo(this.layerTextures, this.documentState);
		this.pruneMissingSelection();
	}

	private pruneMissingSelection(): void {
		if (this.selectionLayerName && !this.documentState.layers.some((entry) => entry.name === this.selectionLayerName)) {
			this.selectionBounds = null;
			this.selectionLayerName = null;
		}
	}

	destroy(): void {
		this.destroyed = true;
		for (const texture of this.layerTextures.values()) {
			destroyTexture(this.gl, texture);
		}
		this.layerTextures.clear();
		this.destroyOwnedTexture(this.scratchA);
		this.destroyOwnedTexture(this.scratchB);
		this.destroyOwnedTexture(this.belowCacheTex);
		this.destroyOwnedTexture(this.aboveCacheTex);
		this.destroyOwnedTexture(this.baselineTex);
		this.destroyOwnedTexture(this.maskTex);
		this.destroyOwnedTexture(this.strokeColorTex);
		this.destroyOwnedTexture(this.previewComposeTex);
		this.destroyOwnedTexture(this.selectionMaskTex);
		this.destroyOwnedTexture(this.selectionColorTex);
		this.destroyOwnedTexture(this.selectionOriginalTex);
		this.destroyOwnedTexture(this.displayTex);
		this.destroyOwnedTexture(this.predictedBackupTex);
		if (this.instanceBuffer) {
			this.gl.deleteBuffer(this.instanceBuffer);
			this.instanceBuffer = null;
		}
		if (this.imagePlacement) {
			destroyTexture(this.gl, this.imagePlacement.imageTexture);
			this.imagePlacement = null;
		}
		this.history.clear();
		this.deleteProgram(this.stampProgram);
		this.deleteProgram(this.strokeBuildProgram);
		this.deleteProgram(this.strokeCompositeProgram);
		this.deleteProgram(this.layerCompositeProgram);
		this.deleteProgram(this.strokePreviewProgram);
		this.deleteProgram(this.blitProgram);
		this.deleteProgram(this.selectionExtractProgram);
		this.deleteProgram(this.selectionQuadProgram);
		this.gl.deleteSampler(this.nearestSampler);
		this.gl.deleteSampler(this.linearSampler);
		this.gl.deleteVertexArray(this.stampVao);
		this.gl.deleteVertexArray(this.emptyVao);

		this.gl.getExtension('WEBGL_lose_context')?.loseContext();
	}

	private allocateForDocument(documentState: OraDocument, onLayerReady: () => void): void {
		this.width = documentState.width;
		this.height = documentState.height;

		for (const texture of this.layerTextures.values()) {
			destroyTexture(this.gl, texture);
		}
		this.layerTextures.clear();
		this.destroyOwnedTexture(this.scratchA);
		this.destroyOwnedTexture(this.scratchB);
		this.destroyOwnedTexture(this.belowCacheTex);
		this.destroyOwnedTexture(this.aboveCacheTex);
		this.destroyOwnedTexture(this.baselineTex);
		this.destroyOwnedTexture(this.maskTex);
		this.destroyOwnedTexture(this.strokeColorTex);
		this.destroyOwnedTexture(this.previewComposeTex);
		this.destroyOwnedTexture(this.selectionMaskTex);
		this.destroyOwnedTexture(this.selectionColorTex);
		this.destroyOwnedTexture(this.selectionOriginalTex);
		this.destroyOwnedTexture(this.displayTex);
		this.destroyOwnedTexture(this.predictedBackupTex);
		this.selectionBounds = null;
		this.selectionLayerName = null;
		if (this.imagePlacement) {
			destroyTexture(this.gl, this.imagePlacement.imageTexture);
			this.imagePlacement = null;
		}

		this.scratchA = createLayerTexture(this.gl, this.width, this.height);
		this.scratchB = createLayerTexture(this.gl, this.width, this.height);
		this.belowCacheTex = createLayerTexture(this.gl, this.width, this.height);
		this.aboveCacheTex = createLayerTexture(this.gl, this.width, this.height);
		this.baselineTex = createLayerTexture(this.gl, this.width, this.height);
		this.maskTex = createLayerTexture(this.gl, this.width, this.height, MASK_TEXTURE_FORMAT);
		this.strokeColorTex = createLayerTexture(this.gl, this.width, this.height);
		this.previewComposeTex = createLayerTexture(this.gl, this.width, this.height);
		this.selectionMaskTex = createLayerTexture(this.gl, this.width, this.height);
		this.selectionColorTex = createLayerTexture(this.gl, this.width, this.height);
		this.selectionOriginalTex = createLayerTexture(this.gl, this.width, this.height);
		this.displayTex = createLayerTexture(this.gl, this.width, this.height);
		this.predictedBackupTex = createLayerTexture(this.gl, this.width, this.height, MASK_TEXTURE_FORMAT);

		for (const layer of documentState.layers) {
			const texture = createLayerTexture(this.gl, this.width, this.height);
			this.layerTextures.set(layer.name, texture);

			if (layer.baseImageDataUrl) {
				void loadImageIntoTexture(this.gl, texture, layer.baseImageDataUrl, this.width, this.height, layer.x, layer.y).then(onLayerReady);
			} else if (layer.name === 'Paper') {
				const [r, g, b] = this.hexToRgb255(documentState.paperColor || getLayerFallbackColor('Paper'));
				fillSolidColor(this.gl, texture, this.width, this.height, [r, g, b, 255]);
			}
		}

		this.history.resize(this.width, this.height);
	}

	private createSampler(filter: number, magFilter = filter): WebGLSampler {
		const sampler = this.gl.createSampler();
		if (!sampler) {
			throw new Error('Unable to create WebGL sampler');
		}
		this.gl.samplerParameteri(sampler, this.gl.TEXTURE_MIN_FILTER, filter);
		this.gl.samplerParameteri(sampler, this.gl.TEXTURE_MAG_FILTER, magFilter);
		this.gl.samplerParameteri(sampler, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
		this.gl.samplerParameteri(sampler, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
		return sampler;
	}

	private requireVertexArray(): WebGLVertexArrayObject {
		const vao = this.gl.createVertexArray();
		if (!vao) {
			throw new Error('Unable to create WebGL vertex array');
		}
		return vao;
	}

	private createProgram(source: ShaderSource, uniformNames: string[]): ProgramInfo {
		const vertexShader = this.compileShader(this.gl.VERTEX_SHADER, source.vertex);
		const fragmentShader = this.compileShader(this.gl.FRAGMENT_SHADER, source.fragment);
		const program = this.gl.createProgram();
		if (!program) {
			throw new Error('Unable to create WebGL program');
		}
		this.gl.attachShader(program, vertexShader);
		this.gl.attachShader(program, fragmentShader);
		this.gl.linkProgram(program);
		this.gl.deleteShader(vertexShader);
		this.gl.deleteShader(fragmentShader);
		if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
			throw new Error(this.gl.getProgramInfoLog(program) || 'WebGL program link failed');
		}

		const uniforms: Record<string, WebGLUniformLocation> = {};
		for (const name of uniformNames) {
			const location = this.gl.getUniformLocation(program, name);
			if (!location) {
				throw new Error(`Missing uniform location: ${name}`);
			}
			uniforms[name] = location;
		}
		return { program, uniforms };
	}

	private compileShader(type: number, source: string): WebGLShader {
		const shader = this.gl.createShader(type);
		if (!shader) {
			throw new Error('Unable to create WebGL shader');
		}
		this.gl.shaderSource(shader, source);
		this.gl.compileShader(shader);
		if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
			throw new Error(this.gl.getShaderInfoLog(shader) || 'WebGL shader compile failed');
		}
		return shader;
	}

	private uniform(program: ProgramInfo, name: string): WebGLUniformLocation {
		return program.uniforms[name]!;
	}

	private deleteProgram(program: ProgramInfo): void {
		this.gl.deleteProgram(program.program);
	}

	private destroyOwnedTexture(texture: GpuTexture | undefined): void {
		if (texture) {
			destroyTexture(this.gl, texture);
		}
	}

	// recomputes the stroke preview caches (below/above composites) for the given layer after a structural layer change
	refreshPreviewCaches(layer: OraLayer): void {
		if (this.destroyed || this.currentStroke) {
			return;
		}
		if (!this.documentState.layers.some((entry) => entry.name === layer.name)) {
			return;
		}
		this.computeLayerCaches(layer);
	}

	private computeLayerCaches(layer: OraLayer): void {
		const index = this.documentState.layers.findIndex((entry) => entry.name === layer.name);
		this.compositeLayerRangeInto(this.belowCacheTex, this.documentState.layers.slice(0, index));
		this.compositeLayerRangeInto(this.aboveCacheTex, this.documentState.layers.slice(index + 1));
		this.activeLayerHasMultiplyAbove = this.documentState.layers
			.slice(index + 1)
			.some((l) => l.visible && l.blendMode === 'multiply');
	}

	private prepareStrokeCaches(layer: OraLayer): void {
		this.computeLayerCaches(layer);

		const liveTex = this.layerTextures.get(layer.name);
		if (liveTex) {
			copyTexture(this.gl, liveTex, this.baselineTex, this.width, this.height);
			copyTexture(this.gl, liveTex, this.previewComposeTex, this.width, this.height);
			this.history.beginStroke(layer.name);
		}
	}

	private updateStrokeTextures(): ScissorRect | null {
		if (!this.currentStroke) {
			return null;
		}

		const stampCount = this.collectNewStamps();
		if (stampCount > 0) {
			this.runStampPass(stampCount);
		}

		const scissor = this.toScissorRect(this.dirtyBounds);
		this.dirtyBounds = { ...EMPTY_BOUNDS };
		if (!scissor) {
			return null;
		}

		this.runStrokeBuildPass(scissor);
		this.runStrokeComposePreviewPass(scissor);
		return scissor;
	}

	/** Write new stamp instances directly into this.stampData (no intermediate
	 *  number[] allocation), then return the instance count. */
	private collectNewStamps(): number {
		if (!this.currentStroke) {
			return 0;
		}
		const points = this.currentStroke.points;
		if (points.length === 0) {
			return 0;
		}

		this.stampWriteIndex = 0;
		if (this.lastRenderedPoint === 0) {
			this.pushStampInstance(points[0]!);
			this.lastRenderedPoint = 1;
		}
		while (this.lastRenderedPoint < points.length) {
			this.pushSegmentInstances(points[this.lastRenderedPoint - 1]!, points[this.lastRenderedPoint]!);
			this.lastRenderedPoint += 1;
		}
		return this.stampWriteIndex / 5;
	}

	private pushSegmentInstances(a: Point, b: Point): void {
		if (!this.currentStroke) {
			return;
		}
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const distance = Math.sqrt(dx * dx + dy * dy);
		if (distance === 0) {
			return;
		}

		const pressure = ((a.pressure ?? 1) + (b.pressure ?? 1)) * 0.5;
		const pressureSizeFactor = this.sizeSampler?.evaluate(pressure) ?? 1;
		let currentSize = this.currentStroke.size * pressureSizeFactor;
		if (this.currentStroke.minimumSize && currentSize < 1) {
			currentSize = 1;
		}
		const spacing = Math.max(1, currentSize * 0.15);
		const steps = Math.ceil(distance / spacing);

		for (let i = 1; i <= steps; i += 1) {
			const t = i / steps;
			this.pushStampInstance({
				x: a.x + dx * t,
				y: a.y + dy * t,
				pressure: (a.pressure ?? 1) + ((b.pressure ?? 1) - (a.pressure ?? 1)) * t,
			});
		}
	}

	private pushStampInstance(point: Point): void {
		if (!this.currentStroke) {
			return;
		}
		const pressure = point.pressure ?? 1;
		const sizeFactor = this.sizeSampler?.evaluate(pressure) ?? 1;
		const opacityFactor = this.opacitySampler?.evaluate(pressure) ?? 1;
		let size = this.currentStroke.size * sizeFactor;
		if (this.currentStroke.minimumSize && size < 1) {
			size = 1;
		}
		const opacity = (this.currentStroke.opacity / 100) * opacityFactor;
		const radius = size / 2;

		const left = point.x - radius;
		const top = point.y - radius;
		const right = point.x + radius;
		const bottom = point.y + radius;

		this.strokeBounds.left = Math.min(this.strokeBounds.left, left);
		this.strokeBounds.top = Math.min(this.strokeBounds.top, top);
		this.strokeBounds.right = Math.max(this.strokeBounds.right, right);
		this.strokeBounds.bottom = Math.max(this.strokeBounds.bottom, bottom);

		this.dirtyBounds.left = Math.min(this.dirtyBounds.left, left);
		this.dirtyBounds.top = Math.min(this.dirtyBounds.top, top);
		this.dirtyBounds.right = Math.max(this.dirtyBounds.right, right);
		this.dirtyBounds.bottom = Math.max(this.dirtyBounds.bottom, bottom);

		// Grow stampData if needed (5 floats per instance)
		const needed = this.stampWriteIndex + 5;
		if (this.stampData.length < needed) {
			const bigger = new Float32Array(Math.max(needed, this.stampData.length * 2));
			bigger.set(this.stampData);
			this.stampData = bigger;
		}
		this.stampData[this.stampWriteIndex] = point.x;
		this.stampData[this.stampWriteIndex + 1] = point.y;
		this.stampData[this.stampWriteIndex + 2] = radius;
		this.stampData[this.stampWriteIndex + 3] = opacity;
		this.stampData[this.stampWriteIndex + 4] = this.currentStroke.hardness / 100;
		this.stampWriteIndex = needed;
	}

	private runStampPass(instanceCount: number): void {
		const bytes = instanceCount * 5 * 4; // 5 floats × 4 bytes each
		this.ensureInstanceCapacity(bytes);
		if (!this.instanceBuffer) {
			return;
		}

		this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instanceBuffer);
		this.gl.bufferSubData(this.gl.ARRAY_BUFFER, 0, this.stampData.subarray(0, instanceCount * 5));

		this.bindTarget(this.maskTex, null, null);
		this.gl.enable(this.gl.BLEND);
		this.gl.blendEquationSeparate(this.maxBlendEquation, this.maxBlendEquation);
		this.gl.blendFuncSeparate(this.gl.ONE, this.gl.ONE, this.gl.ONE, this.gl.ONE);
		this.gl.useProgram(this.stampProgram.program);
		this.gl.uniform2f(this.uniform(this.stampProgram, 'uCanvasSize'), this.width, this.height);
		this.gl.bindVertexArray(this.stampVao);
		this.gl.drawArraysInstanced(this.gl.TRIANGLES, 0, 6, instanceCount);
		this.cleanupDrawState();
	}

	private ensureInstanceCapacity(bytes: number): void {
		if (this.instanceBuffer && this.instanceCapacityBytes >= bytes) {
			return;
		}
		if (this.instanceBuffer) {
			this.gl.deleteBuffer(this.instanceBuffer);
		}
		const capacity = Math.max(bytes, 1024);
		const buffer = this.gl.createBuffer();
		if (!buffer) {
			throw new Error('Unable to allocate instance buffer');
		}
		this.instanceBuffer = buffer;
		this.instanceCapacityBytes = capacity;

		this.gl.bindVertexArray(this.stampVao);
		this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
		this.gl.bufferData(this.gl.ARRAY_BUFFER, capacity, this.gl.DYNAMIC_DRAW);
		this.gl.enableVertexAttribArray(0);
		this.gl.vertexAttribPointer(0, 2, this.gl.FLOAT, false, 20, 0);
		this.gl.vertexAttribDivisor(0, 1);
		this.gl.enableVertexAttribArray(1);
		this.gl.vertexAttribPointer(1, 1, this.gl.FLOAT, false, 20, 8);
		this.gl.vertexAttribDivisor(1, 1);
		this.gl.enableVertexAttribArray(2);
		this.gl.vertexAttribPointer(2, 1, this.gl.FLOAT, false, 20, 12);
		this.gl.vertexAttribDivisor(2, 1);
		this.gl.enableVertexAttribArray(3);
		this.gl.vertexAttribPointer(3, 1, this.gl.FLOAT, false, 20, 16);
		this.gl.vertexAttribDivisor(3, 1);
		this.gl.bindVertexArray(null);
		this.gl.bindBuffer(this.gl.ARRAY_BUFFER, null);
	}

	private runStrokeBuildPass(scissor: ScissorRect): void {
		if (!this.currentStroke) {
			return;
		}
		const mode = this.currentStroke.blendMode === 'compare-density' ? 1 : 0;

		this.bindTarget(this.strokeColorTex, null, scissor);
		this.gl.useProgram(this.strokeBuildProgram.program);
		this.gl.uniform3f(this.uniform(this.strokeBuildProgram, 'uColor'), this.rgbColor.r, this.rgbColor.g, this.rgbColor.b);
		this.gl.uniform1i(this.uniform(this.strokeBuildProgram, 'uMode'), mode);
		this.bindTexture(0, this.maskTex, this.nearestSampler);
		this.bindTexture(1, this.baselineTex, this.nearestSampler);
		this.gl.uniform1i(this.uniform(this.strokeBuildProgram, 'uMaskTex'), 0);
		this.gl.uniform1i(this.uniform(this.strokeBuildProgram, 'uBaselineTex'), 1);
		this.drawFullscreen();
	}

	private runStrokeComposePreviewPass(scissor: ScissorRect): void {
		this.runStrokeCompositePass(this.previewComposeTex, this.strokeColorTex, this.baselineTex, this.strokeCompositeMode(), scissor);
	}

	private strokeCompositeMode(): number {
		if (!this.currentStroke) {
			return 0;
		}
		if (this.currentStroke.blendMode !== 'normal') {
			return 2;
		}
		return this.currentStroke.tool === 'eraser' ? 1 : 0;
	}

	private runStrokeCompositePass(target: GpuTexture, strokeTex: GpuTexture, baseTex: GpuTexture, mode: number, scissor: ScissorRect): void {
		this.bindTarget(target, null, scissor);
		this.gl.useProgram(this.strokeCompositeProgram.program);
		this.gl.uniform1i(this.uniform(this.strokeCompositeProgram, 'uMode'), mode);
		this.bindTexture(0, strokeTex, this.nearestSampler);
		this.bindTexture(1, baseTex, this.nearestSampler);
		this.gl.uniform1i(this.uniform(this.strokeCompositeProgram, 'uStrokeTex'), 0);
		this.gl.uniform1i(this.uniform(this.strokeCompositeProgram, 'uBaseTex'), 1);
		this.drawFullscreen();
	}

	private runSelectionExtractPass(sourceTex: GpuTexture): void {
		this.bindTarget(this.selectionColorTex, [0, 0, 0, 0], null);
		this.gl.useProgram(this.selectionExtractProgram.program);
		this.bindTexture(0, sourceTex, this.nearestSampler);
		this.bindTexture(1, this.selectionMaskTex, this.nearestSampler);
		this.gl.uniform1i(this.uniform(this.selectionExtractProgram, 'uSourceTex'), 0);
		this.gl.uniform1i(this.uniform(this.selectionExtractProgram, 'uMaskTex'), 1);
		this.drawFullscreen();
	}

	private runSelectionQuadPass(target: GpuTexture, transform: SelectionTransform): void {
		if (!this.selectionBounds) {
			return;
		}

		const centerX = this.selectionBounds.left + this.selectionBounds.width / 2;
		const centerY = this.selectionBounds.top + this.selectionBounds.height / 2;

		copyTexture(this.gl, target, this.scratchA, this.width, this.height);
		copyTexture(this.gl, target, this.scratchB, this.width, this.height);

		this.bindTarget(this.scratchB, null, null);
		this.gl.useProgram(this.selectionQuadProgram.program);
		this.gl.uniform2f(this.uniform(this.selectionQuadProgram, 'uCanvasSize'), this.width, this.height);
		this.gl.uniform2f(this.uniform(this.selectionQuadProgram, 'uSelectionCenter'), centerX, centerY);

		this.gl.uniform1f(this.uniform(this.selectionQuadProgram, 'uImagePlacement'), 0.0);
		// snap selection to nearest pixel if it's only being moved
		const translationOnly = this.isTranslationOnlySelectionTransform(transform);
		const translateX = translationOnly ? Math.round(transform.translateX) : transform.translateX;
		const translateY = translationOnly ? Math.round(transform.translateY) : transform.translateY;
		this.gl.uniform2f(this.uniform(this.selectionQuadProgram, 'uTranslate'), translateX, translateY);
		this.gl.uniform1f(this.uniform(this.selectionQuadProgram, 'uRotation'), transform.rotation);
		this.gl.uniform2f(this.uniform(this.selectionQuadProgram, 'uScale'), transform.scaleX, transform.scaleY);
		this.bindTexture(0, this.selectionColorTex, translationOnly ? this.nearestSampler : this.linearSampler);
		this.bindTexture(1, this.scratchA, this.nearestSampler);
		this.gl.uniform1i(this.uniform(this.selectionQuadProgram, 'uSelectionTex'), 0);
		this.gl.uniform1i(this.uniform(this.selectionQuadProgram, 'uDstTex'), 1);
		this.gl.bindVertexArray(this.emptyVao);
		this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
		this.cleanupDrawState();

		copyTexture(this.gl, this.scratchB, target, this.width, this.height);
	}

	private runLayerCompositePass(dst: GpuTexture, src: GpuTexture, opacity: number, blendMode: number, output: GpuTexture | null): void {
		this.bindTarget(output, [0, 0, 0, 0], null);
		this.gl.useProgram(this.layerCompositeProgram.program);
		this.gl.uniform1f(this.uniform(this.layerCompositeProgram, 'uOpacity'), opacity);
		this.gl.uniform1i(this.uniform(this.layerCompositeProgram, 'uBlendMode'), blendMode);
		this.bindTexture(0, src, this.nearestSampler);
		this.bindTexture(1, dst, this.nearestSampler);
		this.gl.uniform1i(this.uniform(this.layerCompositeProgram, 'uSrcTex'), 0);
		this.gl.uniform1i(this.uniform(this.layerCompositeProgram, 'uDstTex'), 1);
		this.drawFullscreen();
	}

	// composites below + stroke + above in a single full-canvas pass
	private runStrokePreviewPass(belowTex: GpuTexture, strokeTex: GpuTexture, aboveTex: GpuTexture, opacity: number, blendMode: number, scissor: ScissorRect | null = null): void {
		this.bindTarget(this.displayTex, [0, 0, 0, 0], scissor);
		this.gl.useProgram(this.strokePreviewProgram.program);
		this.gl.uniform1f(this.uniform(this.strokePreviewProgram, 'uOpacity'), opacity);
		this.gl.uniform1i(this.uniform(this.strokePreviewProgram, 'uBlendMode'), blendMode);
		this.bindTexture(0, belowTex, this.nearestSampler);
		this.bindTexture(1, strokeTex, this.nearestSampler);
		this.bindTexture(2, aboveTex, this.nearestSampler);
		this.gl.uniform1i(this.uniform(this.strokePreviewProgram, 'uBelowTex'), 0);
		this.gl.uniform1i(this.uniform(this.strokePreviewProgram, 'uStrokeTex'), 1);
		this.gl.uniform1i(this.uniform(this.strokePreviewProgram, 'uAboveTex'), 2);
		this.drawFullscreen();
	}

	private compositeLayerStack(layers: OraLayer[], accumA: GpuTexture, accumB: GpuTexture, backdrop: { r: number; g: number; b: number; a: number } = { r: 0, g: 0, b: 0, a: 0 }): void {
		// transparent backdrop by default so partial stacks (the below/above
		// caches) keep true alpha for later "over" compositing; callers that
		// produce the final presented image pass opaque white, since the
		// canvas presents opaquely (alpha: false + desynchronized)
		clearTexture(this.gl, accumA, backdrop);
		let current = accumA;
		let other = accumB;
		for (const layer of layers) {
			if (!layer.visible) {
				continue;
			}
			const texture = this.layerTextures.get(layer.name);
			if (!texture) {
				continue;
			}
			this.runLayerCompositePass(current, texture, layer.opacity / 100, layer.blendMode === 'multiply' ? 1 : 0, other);
			const swap = current;
			current = other;
			other = swap;
		}
		this.lastStackResult = current;
	}

	private compositeLayerStackWithSubstitution(layers: OraLayer[], activeName: string, substituteTex: GpuTexture, accumA: GpuTexture, accumB: GpuTexture): void {
		// same opaque-white backdrop as compositeLayerStack
		clearTexture(this.gl, accumA, { r: 1, g: 1, b: 1, a: 1 });
		let current = accumA;
		let other = accumB;
		for (const layer of layers) {
			if (!layer.visible) {
				continue;
			}
			const isActive = layer.name === activeName;
			const texture = isActive ? substituteTex : this.layerTextures.get(layer.name);
			if (!texture) {
				continue;
			}
			this.runLayerCompositePass(current, texture, layer.opacity / 100, layer.blendMode === 'multiply' ? 1 : 0, other);
			const swap = current;
			current = other;
			other = swap;
		}
		this.lastStackResult = current;
	}

	private compositeLayerRangeInto(target: GpuTexture, layers: OraLayer[]): void {
		this.compositeLayerStack(layers, this.scratchA, this.scratchB);
		copyTexture(this.gl, this.lastStackResult, target, this.width, this.height);
	}

	private blit(source: GpuTexture): void {
		this.bindTarget(null, [1, 1, 1, 1], null);
		this.gl.useProgram(this.blitProgram.program);
		this.bindTexture(0, source, this.nearestSampler);
		this.gl.uniform1i(this.uniform(this.blitProgram, 'uSourceTex'), 0);
		this.drawFullscreen();
	}

	private bindTarget(target: GpuTexture | null, clearColor: [number, number, number, number] | null, scissor: ScissorRect | null): void {
		const framebuffer = target?.framebuffer ?? null;
		const viewportWidth = target?.width ?? this.canvas.width;
		const viewportHeight = target?.height ?? this.canvas.height;
		this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, framebuffer);
		this.gl.viewport(0, 0, viewportWidth, viewportHeight);
		if (scissor) {
			this.gl.enable(this.gl.SCISSOR_TEST);
			this.gl.scissor(scissor.x, viewportHeight - scissor.y - scissor.height, scissor.width, scissor.height);
		} else {
			this.gl.disable(this.gl.SCISSOR_TEST);
		}
		this.gl.disable(this.gl.BLEND);
		if (clearColor) {
			this.gl.clearColor(clearColor[0], clearColor[1], clearColor[2], clearColor[3]);
			this.gl.clear(this.gl.COLOR_BUFFER_BIT);
		}
	}

	private bindTexture(unit: number, texture: GpuTexture, sampler: WebGLSampler): void {
		this.gl.activeTexture(this.gl.TEXTURE0 + unit);
		this.gl.bindTexture(this.gl.TEXTURE_2D, texture.texture);
		this.gl.bindSampler(unit, sampler);
	}

	private drawFullscreen(): void {
		this.gl.bindVertexArray(this.emptyVao);
		this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
		this.cleanupDrawState();
	}

	private cleanupDrawState(): void {
		this.gl.bindVertexArray(null);
		for (let unit = 0; unit < 4; unit += 1) {
			this.gl.activeTexture(this.gl.TEXTURE0 + unit);
			this.gl.bindTexture(this.gl.TEXTURE_2D, null);
			this.gl.bindSampler(unit, null);
		}
		this.gl.disable(this.gl.BLEND);
		this.gl.disable(this.gl.SCISSOR_TEST);
		this.gl.useProgram(null);
		this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
	}

	private toScissorRect(bounds: Bounds): ScissorRect | null {
		if (bounds.left === Infinity) {
			return null;
		}
		const x = Math.max(0, Math.floor(bounds.left));
		const y = Math.max(0, Math.floor(bounds.top));
		const right = Math.min(this.width, Math.ceil(bounds.right));
		const bottom = Math.min(this.height, Math.ceil(bounds.bottom));
		const width = right - x;
		const height = bottom - y;
		if (width <= 0 || height <= 0) {
			return null;
		}
		return { x, y, width, height };
	}

	private parseColor(hexString: string): { r: number; g: number; b: number } {
		const [r, g, b] = this.hexToRgb255(hexString);
		return { r: r / 255, g: g / 255, b: b / 255 };
	}

	private hexToRgb255(hexString: string): [number, number, number] {
		const r = parseInt(hexString.slice(1, 3), 16);
		const g = parseInt(hexString.slice(3, 5), 16);
		const b = parseInt(hexString.slice(5, 7), 16);
		return [r, g, b];
	}
}