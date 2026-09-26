import type { LayerName, OraDocument, OraLayer } from '../utilities/types';
import { copyTextureRegion, createLayerTexture, destroyTexture, type GpuTexture } from '../rendering/gpu-texture-layer';
import { MAX_UNDO_COUNT } from '../utilities/constants';

// undo/redo for the GPU renderer, memory usage scales with stroke size
interface Region {
    x: number;
    y: number;
    width: number;
    height: number;
}

// region snapshot of a stroke/selection (texture is region-sized)
interface RegionEntry {
    kind: 'region';
    layerName: LayerName;
    texture: GpuTexture;
    region: Region;
}

// layer add/remove. Owns `texture` only while the layer is absent from the
// engine's texture map: an undone add, or an applied remove. Restoring the
// layer returns the texture to the map, so the same texture object survives
// the whole add/remove cycle and region entries keep working across it.
interface StructureEntry {
    kind: 'structure';
    op: 'add' | 'remove';
    layerName: LayerName;
    layer: OraLayer;
    index: number;
    texture: GpuTexture | null;
}

type HistoryEntry = RegionEntry | StructureEntry;

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
        this.undoStack.push({ kind: 'region', layerName, texture, region });
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
            kind: 'region',
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

    // registers a layer addition as an undoable structural change. The layer's
    // texture stays registered in the engine's map while the layer exists; the
    // entry only holds it while an undo has removed the layer again.
    pushAddLayer(layer: OraLayer, index: number): void {
        this.discardPending();
        this.undoStack.push({ kind: 'structure', op: 'add', layerName: layer.name, layer, index, texture: null });
        this.clearRedo();
        this.trim(this.undoStack);
    }

    // registers a layer removal as an undoable structural change, transferring
    // ownership of the layer's texture into the entry. The texture returns to
    // the engine's map when the removal is undone.
    pushRemoveLayer(layer: OraLayer, index: number, texture: GpuTexture): void {
        this.discardPending();
        this.undoStack.push({ kind: 'structure', op: 'remove', layerName: layer.name, layer, index, texture });
        this.clearRedo();
        this.trim(this.undoStack);
    }

    get canUndo(): boolean {
        return this.undoStack.length > 0;
    }

    get canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    undo(liveTextures: Map<LayerName, GpuTexture>, document: OraDocument): LayerName | null {
        const entry = this.undoStack.pop();
        if (!entry) {
            return null;
        }
        if (entry.kind === 'structure') {
            // a structural change must not interleave with an in-flight
            // stroke/selection snapshot
            this.cancelStroke();
            if (entry.op === 'add') {
                // remove the layer again, keeping its current content in the entry
                entry.texture = liveTextures.get(entry.layerName) ?? null;
                liveTextures.delete(entry.layerName);
                this.spliceLayer(document, entry.layerName);
            } else {
                // restore the removed layer and hand its texture back to the map
                this.registerLayer(entry, liveTextures);
                this.insertLayer(document, entry.layer, entry.index);
            }
            this.redoStack.push(entry);
            return entry.layerName;
        }
        const live = liveTextures.get(entry.layerName);
        if (!live) {
            destroyTexture(this.gl, entry.texture);
            return null;
        }
        const redoTexture = this.snapshotRegion(live, entry.region);
        this.restoreRegion(entry.texture, live, entry.region);
        destroyTexture(this.gl, entry.texture);
        this.redoStack.push({ kind: 'region', layerName: entry.layerName, texture: redoTexture, region: entry.region });
        return entry.layerName;
    }

    redo(liveTextures: Map<LayerName, GpuTexture>, document: OraDocument): LayerName | null {
        const entry = this.redoStack.pop();
        if (!entry) {
            return null;
        }
        if (entry.kind === 'structure') {
            this.cancelStroke();
            if (entry.op === 'add') {
                // re-add the layer and its texture
                this.registerLayer(entry, liveTextures);
                this.insertLayer(document, entry.layer, entry.index);
            } else {
                // remove it again, transferring its texture back into the entry
                entry.texture = liveTextures.get(entry.layerName) ?? null;
                liveTextures.delete(entry.layerName);
                this.spliceLayer(document, entry.layerName);
            }
            this.undoStack.push(entry);
            return entry.layerName;
        }
        const live = liveTextures.get(entry.layerName);
        if (!live) {
            destroyTexture(this.gl, entry.texture);
            return null;
        }
        const undoTexture = this.snapshotRegion(live, entry.region);
        this.restoreRegion(entry.texture, live, entry.region);
        destroyTexture(this.gl, entry.texture);
        this.undoStack.push({ kind: 'region', layerName: entry.layerName, texture: undoTexture, region: entry.region });
        return entry.layerName;
    }

    clear(): void {
        this.discardPending();
        this.clearRedo();
        for (const entry of this.undoStack) {
            this.destroyEntryTexture(entry);
        }
        this.undoStack = [];
    }

    // hands the entry's layer texture back to the engine's map. Defensive
    // recreation covers the (unreachable) case of a missing texture.
    private registerLayer(entry: StructureEntry, liveTextures: Map<LayerName, GpuTexture>): void {
        let texture = entry.texture;
        entry.texture = null;
        if (!texture) {
            texture = createLayerTexture(this.gl, this.width, this.height);
        }
        liveTextures.set(entry.layerName, texture);
    }

    private spliceLayer(document: OraDocument, layerName: LayerName): void {
        const index = document.layers.findIndex((layer) => layer.name === layerName);
        if (index >= 0) {
            document.layers.splice(index, 1);
        }
    }

    // inserts a layer at its recorded position, clamped so it never lands on
    // or below Paper and never past the top of the stack
    private insertLayer(document: OraDocument, layer: OraLayer, index: number): void {
        const clamped = Math.min(Math.max(1, index), document.layers.length);
        document.layers.splice(clamped, 0, layer);
    }

    private discardPending(): void {
        if (this.pending?.texture) {
            destroyTexture(this.gl, this.pending.texture);
        }
        this.pending = null;
    }

    private clearRedo(): void {
        for (const entry of this.redoStack) {
            this.destroyEntryTexture(entry);
        }
        this.redoStack = [];
    }

    private trim(stack: HistoryEntry[]): void {
        while (stack.length > this.maxEntries) {
            const entry = stack.shift();
            if (entry) {
                this.destroyEntryTexture(entry);
            }
        }
        }

    private destroyEntryTexture(entry: HistoryEntry): void {
        if (entry.kind === 'structure') {
            // only owns a texture while the layer is unregistered
            if (entry.texture) {
                destroyTexture(this.gl, entry.texture);
                entry.texture = null;
            }
            return;
        }
        destroyTexture(this.gl, entry.texture);
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
