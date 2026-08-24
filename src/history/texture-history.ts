import type { LayerName } from '../utilities/types';
import { copyTextureRegion, createLayerTexture, destroyTexture, type GpuTexture } from '../rendering/gpu-texture-layer';
import { MAX_UNDO_COUNT } from '../utilities/constants';

// undo/redo for the GPU renderer, memory usage scales with stroke size
interface Region {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface HistoryEntry {
	layerName: LayerName;
	texture: GpuTexture; // region-sized
	region: Region;
}

interface PendingEntry {
	layerName: LayerName;
	// null until committed; a full snapshot is taken immediately for selection
	texture: GpuTexture | null;
	region: Region | null;
}

export class TextureHistoryStack {
	private undoStack: HistoryEntry[] = [];
	private redoStack: HistoryEntry[] = [];
	private pending: PendingEntry | null = null;

	constructor(
		private gl: WebGL2RenderingContext,
		private width: number,
		private height: number,
		private readonly maxEntries = MAX_UNDO_COUNT,
	) {}

	resize(width: number, height: number): void {
		this.width = width;
		this.height = height;
		this.clear();
	}

	// strokes defer the snapshot until commit, when the stroke bounds are known
	beginStroke(layerName: LayerName): void {
		this.discardPending();
		this.pending = { layerName, texture: null, region: null };
	}

	// snapshots the region that is about to change, then queues the entry.
	// Must be called before the live texture is modified.
	commitStroke(layerName: LayerName, liveTexture: GpuTexture, region: Region): void {
		if (!this.pending || this.pending.layerName !== layerName || this.pending.texture !== null) {
			this.discardPending();
			return;
		}
		const texture = this.snapshotRegion(liveTexture, region);
		this.undoStack.push({ layerName, texture, region });
		this.pending = null;
		this.clearRedo();
		this.trim(this.undoStack);
	}

	// call if a stroke changes nothing
	cancelStroke(): void {
		this.discardPending();
	}

	// selections take a full snapshot at begin, because the live texture is
	// mutated immediately (the selection hole is cut before commit/cancel)
	beginSelectionSnapshot(layerName: LayerName, liveTexture: GpuTexture): void {
		this.discardPending();
		const region: Region = { x: 0, y: 0, width: this.width, height: this.height };
		this.pending = { layerName, texture: this.snapshotRegion(liveTexture, region), region };
	}

	commitSelectionSnapshot(): void {
		if (!this.pending || !this.pending.texture || !this.pending.region) {
			this.discardPending();
			return;
		}
		this.undoStack.push({
			layerName: this.pending.layerName,
			texture: this.pending.texture,
			region: this.pending.region,
		});
		this.pending = null;
		this.clearRedo();
		this.trim(this.undoStack);
	}

	// for actions that mutated the live texture before the user backed out
	// e.g. cancelling while dragging a lasso
	cancelSelectionAndRestore(liveTextures: Map<LayerName, GpuTexture>): void {
		if (!this.pending || !this.pending.texture || !this.pending.region) {
			return;
		}
		const live = liveTextures.get(this.pending.layerName);
		const region = this.pending.region;
		if (live) {
			copyTextureRegion(this.gl, this.pending.texture, live, 0, 0, region.x, region.y, region.width, region.height);
		}
		this.discardPending();
	}

	get canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	get canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	undo(liveTextures: Map<LayerName, GpuTexture>): LayerName | null {
		const entry = this.undoStack.pop();
		if (!entry) {
			return null;
		}
		const live = liveTextures.get(entry.layerName);
		if (!live) {
			destroyTexture(this.gl, entry.texture);
			return null;
		}
		const redoTexture = this.snapshotRegion(live, entry.region);
		this.restoreRegion(entry.texture, live, entry.region);
		destroyTexture(this.gl, entry.texture);
		this.redoStack.push({ layerName: entry.layerName, texture: redoTexture, region: entry.region });
		return entry.layerName;
	}

	redo(liveTextures: Map<LayerName, GpuTexture>): LayerName | null {
		const entry = this.redoStack.pop();
		if (!entry) {
			return null;
		}
		const live = liveTextures.get(entry.layerName);
		if (!live) {
			destroyTexture(this.gl, entry.texture);
			return null;
		}
		const undoTexture = this.snapshotRegion(live, entry.region);
		this.restoreRegion(entry.texture, live, entry.region);
		destroyTexture(this.gl, entry.texture);
		this.undoStack.push({ layerName: entry.layerName, texture: undoTexture, region: entry.region });
		return entry.layerName;
	}

	clear(): void {
		this.discardPending();
		this.clearRedo();
		for (const entry of this.undoStack) {
			destroyTexture(this.gl, entry.texture);
		}
		this.undoStack = [];
	}

	private discardPending(): void {
		if (this.pending?.texture) {
			destroyTexture(this.gl, this.pending.texture);
		}
		this.pending = null;
	}

	private clearRedo(): void {
		for (const entry of this.redoStack) {
			destroyTexture(this.gl, entry.texture);
		}
		this.redoStack = [];
	}

	private trim(stack: HistoryEntry[]): void {
		while (stack.length > this.maxEntries) {
			const entry = stack.shift();
			if (entry) {
				destroyTexture(this.gl, entry.texture);
			}
		}
	}

	private snapshotRegion(source: GpuTexture, region: Region): GpuTexture {
		const texture = createLayerTexture(this.gl, region.width, region.height);
		copyTextureRegion(this.gl, source, texture, region.x, region.y, 0, 0, region.width, region.height);
		return texture;
	}

	private restoreRegion(source: GpuTexture, destination: GpuTexture, region: Region): void {
		copyTextureRegion(this.gl, source, destination, 0, 0, region.x, region.y, region.width, region.height);
	}
}
