import { App, Modal, Notice, TFile } from 'obsidian';
import { getThumbnailDataUrl } from '../ora/ora-parser';
import { FolderTreeBrowser } from '../ui/folder-tree-browser';
import { blurControlFocusHandler } from '../utilities/utils';

export interface OpenFileChoice {
    file?: TFile;
}

export default class OpenFileModal extends Modal {
    private readonly onChoose: (choice: OpenFileChoice | null) => void;
    private readonly defaultFolder?: string;
    private folderBrowser!: FolderTreeBrowser;
    private thumbnailGrid!: HTMLElement;
    private selectedFile: TFile | null = null;
    private readonly thumbnailCache = new Map<string, string>();
    private renderToken = 0;

    constructor(app: App, onChoose: (choice: OpenFileChoice | null) => void, defaultFolder?: string) {
        super(app);
        this.onChoose = onChoose;
        this.defaultFolder = defaultFolder;
    }

    onOpen(): void {
        this.contentEl.empty();
        this.contentEl.addClass('sketchpad-open-file-modal');
        // Release focus from clicked buttons so a later Space (tool hotkey)
        // doesn't natively re-activate the last-clicked button.
        this.modalEl.addEventListener('click', blurControlFocusHandler(), true);
        this.contentEl.createEl('h2', { text: 'Open sketch' });

        const body = this.contentEl.createDiv({ cls: 'sketchpad-open-file-body' });

        const treeColumn = body.createDiv({ cls: 'sketchpad-open-file-tree' });
        treeColumn.createSpan({ text: 'Folder' });
        this.folderBrowser = new FolderTreeBrowser(this.app, {
            defaultFolder: this.defaultFolder,
            onChange: () => this.renderFiles(),
        });
        treeColumn.appendChild(this.folderBrowser.getElement());

        this.thumbnailGrid = body.createDiv({ cls: 'sketchpad-file-thumbnail-grid' });

        const openButton = body.createEl('button', { text: 'Open' ,cls: 'sketchpad-open-file-button'});
        openButton.addEventListener('click', () => {
            if (this.selectedFile) {
                this.openFile(this.selectedFile);
            } else {
                new Notice('No sketch file selected.');
            }
        });

        this.renderFiles();
    }

    private renderFiles(): void {
        this.renderToken += 1;
        this.selectedFile = null;
        this.thumbnailGrid.empty();

        const folder = this.folderBrowser.getSelectedFolder();
        const oraFiles = folder.children
            .filter(
                (child): child is TFile => child instanceof TFile && child.extension === 'ora',
            )
            .sort((a, b) => a.basename.localeCompare(b.basename));

        if (oraFiles.length === 0) {
            this.thumbnailGrid.createEl('p', {
                text: 'No sketch files in current folder.',
                cls: 'sketchpad-file-thumbnail-empty',
            });
            return;
        }

        for (const file of oraFiles) {
            const card = this.thumbnailGrid.createDiv({ cls: 'sketchpad-file-thumbnail-card' });
            const img = card.createEl('img', { cls: 'sketchpad-file-thumbnail-img' });
            card.createDiv({ cls: 'sketchpad-file-thumbnail-name', text: file.basename });
            card.addEventListener('click', () => this.selectFile(card, file));
            card.addEventListener('dblclick', () => this.openFile(file));
            void this.loadThumbnail(file, img);
        }
    }

    private selectFile(card: HTMLElement, file: TFile): void {
        this.thumbnailGrid
            .querySelectorAll<HTMLElement>('.sketchpad-file-thumbnail-card.is-selected')
            .forEach((el) => {
                el.removeClass('is-selected');
            });
        card.addClass('is-selected');
        this.selectedFile = file;
    }

    private openFile(file: TFile): void {
        this.onChoose({ file });
        this.close();
    }

    private async loadThumbnail(file: TFile, img: HTMLImageElement): Promise<void> {
        const cached = this.thumbnailCache.get(file.path);
        if (cached) {
            img.setAttribute('src', cached);
            return;
        }
        const token = this.renderToken;
        try {
            const binary = await this.app.vault.readBinary(file);
            const src = getThumbnailDataUrl(binary);
            if (src) {
                this.thumbnailCache.set(file.path, src);
                if (img.isConnected && token === this.renderToken) {
                    img.setAttribute('src', src);
                }
            } else {
                img.addClass('is-empty');
            }
        } catch {
            img.addClass('is-empty');
        }
    }
}