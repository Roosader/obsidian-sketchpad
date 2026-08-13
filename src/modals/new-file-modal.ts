import { App, Modal, Notice, TFile } from 'obsidian';
import { DEFAULT_IMAGE_HEIGHT, DEFAULT_IMAGE_WIDTH, DEFAULT_FILE_NAME, MAX_IMAGE_DIMENSION } from '../utilities/constants';
import { FolderTreeBrowser } from '../ui/folder-tree-browser';
import { validateCrossPlatformFileName, sanitizeDimension, sanitizePaperColor, blurButtonFocusHandler } from '../utilities/utils';

export interface NewFileChoice {
    file?: TFile;
    options?: {
        width: number;
        height: number;
        paperColor: string;
        name: string;
        folder?: string; //empty string = vault root
    };
}
export interface NewFileDefaults {
    defaultFileName?: string;
    defaultImageWidth?: number;
    defaultImageHeight?: number;
    defaultPaperColor?: string;
    defaultFolder?: string;
}

export default class NewFileModal extends Modal {
    private readonly onChoose: (choice: NewFileChoice | null) => void;
    private readonly widthInput: HTMLInputElement;
    private readonly heightInput: HTMLInputElement;
    private readonly colorInput: HTMLInputElement;
    private readonly nameInput: HTMLInputElement;
    private readonly folderSummaryEl: HTMLDivElement;
    private readonly folderBrowser: FolderTreeBrowser;
    private readonly defaultFileName: string;
    private readonly defaultImageWidth: number;
    private readonly defaultImageHeight: number;
    private readonly defaultPaperColor: string;
    private readonly defaultFolder: string;

    constructor(app: App, onChoose: (choice: NewFileChoice | null) => void, defaults?: NewFileDefaults) {
        super(app);
        this.onChoose = onChoose;
        this.defaultFileName = defaults?.defaultFileName?.trim() || DEFAULT_FILE_NAME;
        this.defaultImageWidth = sanitizeDimension(defaults?.defaultImageWidth, DEFAULT_IMAGE_WIDTH);
        this.defaultImageHeight = sanitizeDimension(defaults?.defaultImageHeight, DEFAULT_IMAGE_HEIGHT);
        this.defaultPaperColor = sanitizePaperColor(defaults?.defaultPaperColor);
        this.defaultFolder = defaults?.defaultFolder?.trim() ?? '';
        this.widthInput = createEl('input');
        this.heightInput = createEl('input');
        this.colorInput = createEl('input');
        this.nameInput = createEl('input');
        this.folderSummaryEl = createDiv('div');
        this.folderSummaryEl.addClass('sketchpad-folder-summary');
        this.folderBrowser = new FolderTreeBrowser(this.app, {
            defaultFolder: this.defaultFolder,
            onChange: () => this.updateFolderSummary(),
        });
    }

    onOpen(): void {
        this.contentEl.empty();
        this.contentEl.addClass('sketchpad-new-file-modal');
        // Release focus from clicked buttons so a later Space (tool hotkey)
        // doesn't natively re-activate the last-clicked button.
        this.modalEl.addEventListener('click', blurButtonFocusHandler(), true);
        this.contentEl.createEl('h2', { text: 'Create new sketch' });
        
        const createSection = this.contentEl.createDiv();
        createSection.addClass('sketchpad-new-file-body');

        const nameRow = createSection.createDiv();
        nameRow.addClass('sketchpad-new-file-row');
        nameRow.createEl('label', { text: 'File name' });
        this.nameInput.setAttribute('type', 'text');
        this.nameInput.setAttribute('placeholder', this.defaultFileName);
        nameRow.appendChild(this.nameInput);
        nameRow.createSpan({ text: '.ora' });

        const sizeRow = createSection.createDiv();
        sizeRow.addClass('sketchpad-new-file-row');
        sizeRow.createEl('label', { text: 'Width' });
        this.widthInput.setAttribute('type', 'number');
        this.widthInput.setAttribute('min', '1');
        this.widthInput.setAttribute('value', this.defaultImageWidth.toString());
        sizeRow.appendChild(this.widthInput);

        sizeRow.createEl('label', { text: 'Height' });
        this.heightInput.setAttribute('type', 'number');
        this.heightInput.setAttribute('min', '1');
        this.heightInput.setAttribute('value', this.defaultImageHeight.toString());
        sizeRow.appendChild(this.heightInput);

        const colorRow = createSection.createDiv();
        colorRow.addClass('sketchpad-new-file-row');
        colorRow.createEl('label', { text: 'Paper color' });
        this.colorInput.setAttribute('type', 'color');
        this.colorInput.addClass('sketchpad-paper-color-picker');
        this.colorInput.setAttribute('value', this.defaultPaperColor);
        colorRow.appendChild(this.colorInput);

        const folderRow = createSection.createDiv();
        folderRow.addClass('sketchpad-new-file-row');
        folderRow.createEl('label', { text: 'Folder' });
        const folderSelectSection = folderRow.createDiv();
        folderSelectSection.addClass('sketchpad-new-file-folder-section');
        folderSelectSection.appendChild(this.folderBrowser.getElement());
        folderSelectSection.appendChild(this.folderSummaryEl);
        this.updateFolderSummary();

        const buttonRow = createSection.createDiv();
        buttonRow.addClass('sketchpad-new-file-button-row');
        const createButton = buttonRow.createEl('button', { text: 'OK' });
        createButton.addEventListener('click', () => {
            const width = Number.parseInt(this.widthInput.value, 10);
            const height = Number.parseInt(this.heightInput.value, 10);
            if (!Number.isFinite(width) || width < 1 || width > MAX_IMAGE_DIMENSION || !Number.isFinite(height) || height < 1 || height > MAX_IMAGE_DIMENSION) {
				new Notice(`Width and height must be between 1 and ${MAX_IMAGE_DIMENSION}.`);
				return;
			}
            const paperColor = this.colorInput.value;
            const name = this.nameInput.value.trim() || this.defaultFileName;
            const nameError = validateCrossPlatformFileName(name);
            if (nameError) {
                new Notice(nameError);
                return;
            }

            const folder = this.folderBrowser.getSelectedFolder().isRoot() ? '' : this.folderBrowser.getSelectedFolder().path;
            this.onChoose({
                options: {
                    width,
                    height,
                    paperColor,
                    name,
                    folder,
                },
            });
            this.close();
        });

        const cancelButton = buttonRow.createEl('button', { text: 'Cancel' });
        cancelButton.addEventListener('click', () => {
            this.onChoose(null);
            this.close();
        });
    }

    private updateFolderSummary(): void {
        const folder = this.folderBrowser.getSelectedFolder();
        this.folderSummaryEl.setText(folder.isRoot() ? '/' : '/' + folder.path);
    }
}