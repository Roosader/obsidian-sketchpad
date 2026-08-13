import type { LayerName } from '../utilities/types';
import { copyTexture, createLayerTexture, destroyTexture, type GpuTexture } from '../rendering/gpu-texture-layer';
import { MAX_UNDO_COUNT } from '../utilities/constants';

// undo/redo for the GPU renderer
// history restores whole layer textures for each stroke 
interface HistoryEntry {
	layerName: LayerName;
	texture: GpuTexture;
}

export class TextureHistoryStack {
	private undoStack: HistoryEntry[] = [];
	private redoStack: HistoryEntry[] = [];
	private pendingBefore: HistoryEntry | null = null;

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

	beginStroke(layerName: LayerName, liveTexture: GpuTexture): void {
		this.discardPending();
		this.pendingBefore = { layerName, texture: this.snapshot(liveTexture) };
	}

	// call once the stroke has been baked into the live layer texture
	commitStroke(): void {
		if (!this.pendingBefore) {
			return;
		}
		this.undoStack.push(this.pendingBefore);
		this.pendingBefore = null;
		this.clearRedo();
		this.trim(this.undoStack);
	}

	// call if a stroke changes nothing
	cancelStroke(): void {
		this.discardPending();
	}

	// for actions that mutated the live texture before the user backed out 
	// e.g. cancelling while dragging a lasso
	cancelStrokeAndRestore(liveTextures: Map<LayerName, GpuTexture>): void {
		if (!this.pendingBefore) {
			return;
		}
		const live = liveTextures.get(this.pendingBefore.layerName);
		if (live) {
			copyTexture(this.gl, this.pendingBefore.texture, live, this.width, this.height);
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
		const redoSnapshot = this.snapshot(live);
		copyTexture(this.gl, entry.texture, live, this.width, this.height);
		destroyTexture(this.gl, entry.texture);
		this.redoStack.push({ layerName: entry.layerName, texture: redoSnapshot });
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
		const undoSnapshot = this.snapshot(live);
		copyTexture(this.gl, entry.texture, live, this.width, this.height);
		destroyTexture(this.gl, entry.texture);
		this.undoStack.push({ layerName: entry.layerName, texture: undoSnapshot });
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
		if (this.pendingBefore) {
			destroyTexture(this.gl, this.pendingBefore.texture);
		}
		this.pendingBefore = null;
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

	private snapshot(source: GpuTexture): GpuTexture {
		const texture = createLayerTexture(this.gl, this.width, this.height);
		copyTexture(this.gl, source, texture, this.width, this.height);
		return texture;
	}
}
