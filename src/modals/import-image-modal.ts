import { App, Modal, TFile } from 'obsidian';
import { FolderTreeBrowser } from '../ui/folder-tree-browser';
import { createThumbnailObserver } from '../ui/thumbnail-queue';
import { blurControlFocusHandler } from '../utilities/utils';
import { IMAGE_IMPORT_EXTENSIONS } from '../utilities/constants';
import type { LayerName, OraLayer } from '../utilities/types';
import {IMPORT_THUMBNAIL_PRELOAD_MARGIN} from '../utilities/constants'
export interface ImportImageChoice {
    file: TFile;
    layerName: LayerName;
}

//pick an image file from the vault and the layer to import it into (except Paper layer)
export class ImportImageModal extends Modal {
    private readonly folderBrowser: FolderTreeBrowser;
    private readonly thumbnailGrid: HTMLElement;
    private readonly importButton: HTMLButtonElement;
    private selectedFile: TFile | null = null;
    private selectedLayer: LayerName | null = null;
    private thumbnailObserver: IntersectionObserver | null = null;

    constructor(
        app: App,
        private readonly layers: OraLayer[],
        private readonly activeLayerName: LayerName,
        private readonly onChoose: (choice: ImportImageChoice | null) => void,
    ) {
        super(app);
        this.folderBrowser = new FolderTreeBrowser(app, { onChange: () => this.renderFiles() });
        this.thumbnailGrid = createDiv({ cls: 'sketchpad-file-thumbnail-grid' });
        this.importButton = createEl('button', { text: 'Import'});
        this.importButton.disabled = true;
        this.importButton.addEventListener('click', () => this.choose());
    }

    onOpen(): void {
        this.contentEl.empty();
        this.contentEl.addClass('sketchpad-export-file-modal');
        this.modalEl.addEventListener('click', blurControlFocusHandler(), true);
        this.contentEl.createEl('h2', { text: 'Import image to document' });

        const body = this.contentEl.createDiv({ cls: 'sketchpad-export-file-body' });

        const treeColumn = body.createDiv({ cls: 'sketchpad-open-file-tree' });
        treeColumn.createSpan({text: 'Folder'});
        treeColumn.appendChild(this.folderBrowser.getElement());
        body.appendChild(this.thumbnailGrid);

        const layerRow = body.createDiv({ cls: 'sketchpad-import-layer-row' });
        layerRow.createEl('label', { text: 'Import to layer' });
        const select = layerRow.createEl('select');

        const importable = this.layers.filter((layer) => layer.name !== 'Paper').reverse();
        for (const layer of importable) {
            const option = select.createEl('option', { text: layer.name });
            option.value = layer.name;
        }
        select.value = importable.some((layer) => layer.name === this.activeLayerName)
            ? this.activeLayerName
            : (importable[importable.length - 1]?.name ?? '');
        this.selectedLayer = (select.value || null);
        select.addEventListener('change', () => { this.selectedLayer = (select.value || null);});

        const buttonRow = body.createDiv({ cls: 'sketchpad-export-file-button-row' });
        buttonRow.appendChild(this.importButton);
        buttonRow.createEl('button', {text: 'Cancel'}).addEventListener('click', () => this.close());

        this.renderFiles();
    }

    private renderFiles(): void {
        this.selectedFile = null;
        this.importButton.disabled = true;
        this.teardownThumbnailObserver();
        this.thumbnailGrid.empty();

        const folder = this.folderBrowser.getSelectedFolder();
        const imageFiles = folder.children
            .filter((child): child is TFile => child instanceof TFile && IMAGE_IMPORT_EXTENSIONS.includes(child.extension.toLowerCase()))
            .sort((a, b) => a.basename.localeCompare(b.basename));

        if (imageFiles.length === 0) {
            this.thumbnailGrid.createEl('p', {text: 'No image files in current folder.', cls: 'sketchpad-file-thumbnail-empty',});
            return;
        }

        const pendingLoads = new Map<Element, { file: TFile; img: HTMLImageElement }>();
        this.thumbnailObserver = createThumbnailObserver(
            this.thumbnailGrid,
            (target) => {
                const pending = pendingLoads.get(target);
                pendingLoads.delete(target);
                if (pending && pending.img.isConnected) {
                    this.assignThumbnailSrc(pending.img, pending.file);
                }
            },
            IMPORT_THUMBNAIL_PRELOAD_MARGIN,
        );

        for (const file of imageFiles) {
            const card = this.thumbnailGrid.createDiv({ cls: 'sketchpad-file-thumbnail-card' });
            const img = card.createEl('img', {cls: 'sketchpad-file-thumbnail-img'});
            this.watchThumbnailLoad(img);
            card.createDiv({ cls: 'sketchpad-file-thumbnail-name', text: file.name });
            card.addEventListener('click', () => {
                this.selectedFile = file;
                for (const other of Array.from(this.thumbnailGrid.children)) {
                    other.classList.toggle('is-selected', other === card);
                }
                if (this.selectedLayer) {
                    this.importButton.disabled = false;
                }
            });
            card.addEventListener('dblclick', () => this.choose());
            pendingLoads.set(card, { file, img });
            this.thumbnailObserver.observe(card);
        }
    }

    private choose(): void {
        if (!this.selectedFile || !this.selectedLayer) {
            return;
        }
        const choice: ImportImageChoice = { file: this.selectedFile, layerName: this.selectedLayer };
        this.close();
        this.onChoose(choice);
    }

    private assignThumbnailSrc(img: HTMLImageElement, file: TFile): void {
        img.src = this.app.vault.getResourcePath(file);
        // `load` may already have fired for a synchronously served resource,
        // so check for a completed image as well. Either way, the `is-loaded`
        // class flip forces a repaint on exactly this image.
        if (img.complete && img.naturalWidth > 0) {
            img.addClass('is-loaded');
        }
    }

    private watchThumbnailLoad(img: HTMLImageElement): void {
        img.addEventListener('load', () => {
            void img.decode()
                .catch(() => {
                    // Decoding stays async nonetheless; fall back to the
                    // loaded bitmap so the repaint still happens.
                })
                .finally(() => {
                    img.addClass('is-loaded');
                });
        }, { once: true });
        img.addEventListener('error', () => {
            img.addClass('is-empty');
        }, { once: true });
    }

    onClose(): void {
        this.teardownThumbnailObserver();
        this.contentEl.empty();
    }

    private teardownThumbnailObserver(): void {
        this.thumbnailObserver?.disconnect();
        this.thumbnailObserver = null;
    }
}
