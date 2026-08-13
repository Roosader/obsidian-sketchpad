import { App, Modal, Notice } from 'obsidian';
import { FolderTreeBrowser } from '../ui/folder-tree-browser';
import { validateCrossPlatformFileName, blurButtonFocusHandler } from '../utilities/utils';

export interface ExportFileChoice {
	options: {
		name: string; // includes the fixed .png extension
		folder: string; //empty = vault root
	};
}

export default class ExportFileModal extends Modal {
	private readonly onChoose: (choice: ExportFileChoice | null) => void;
	private readonly defaultName: string;
	private readonly folderBrowser: FolderTreeBrowser;
	private readonly nameInput: HTMLInputElement;
	private readonly folderSummaryEl: HTMLDivElement;

	constructor(app: App, defaultName: string, onChoose: (choice: ExportFileChoice | null) => void, defaultFolder?: string) {
		super(app);
		this.onChoose = onChoose;

		this.defaultName = defaultName; //name without fixed .png extension
		this.nameInput = createEl('input');
		this.nameInput.setAttribute('type', 'text');
		this.nameInput.setAttribute('value', this.defaultName);
		this.nameInput.addClass('sketchpad-export-file-name');
		this.folderSummaryEl = createDiv('div');
		this.folderSummaryEl.addClass('sketchpad-folder-summary');
		this.folderBrowser = new FolderTreeBrowser(this.app, {
			defaultFolder,
			onChange: () => this.updateFolderSummary(),
		});
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.addClass('sketchpad-export-file-modal');
		// Release focus from clicked buttons so a later Space (tool hotkey)
		// doesn't natively re-activate the last-clicked button.
		this.modalEl.addEventListener('click', blurButtonFocusHandler(), true);
		this.contentEl.createEl('h2', { text: 'Export merged image' });

		const body = this.contentEl.createDiv({ cls: 'sketchpad-export-file-body' });

		const nameRow = body.createDiv({ cls: 'sketchpad-export-file-row' });
		nameRow.createEl('label', { text: 'File name' });
		nameRow.appendChild(this.nameInput);
		this.nameInput.setSelectionRange(this.nameInput.value.length,this.nameInput.value.length);
        nameRow.createSpan({ text: '.png' });

		const folderRow = body.createDiv({ cls: 'sketchpad-export-file-row' });
		folderRow.createEl('label', { text: 'Folder' });
		const folderSection = folderRow.createDiv({ cls: 'sketchpad-export-file-folder-section' });
		folderSection.appendChild(this.folderBrowser.getElement());
		folderSection.appendChild(this.folderSummaryEl);
		this.updateFolderSummary();

		const buttonRow = body.createDiv({ cls: 'sketchpad-export-file-button-row' });
		const okButton = buttonRow.createEl('button', { text: 'OK'});
		okButton.addEventListener('click', () => this.confirm());
		const cancelButton = buttonRow.createEl('button', { text: 'Cancel' });
		cancelButton.addEventListener('click', () => {
			this.onChoose(null);
			this.close();
		});
	}

	private confirm(): void {
		const name = this.nameInput.value.trim() || this.defaultName;
		const nameError = validateCrossPlatformFileName(name);
		if (nameError) {
			new Notice(nameError);
			return;
		}
		const folder = this.folderBrowser.getSelectedFolder().isRoot() ? '' : this.folderBrowser.getSelectedFolder().path;

		this.onChoose({ options: { name: `${name}.png`, folder } });
		this.close();
	}

	private updateFolderSummary(): void {
		const folder = this.folderBrowser.getSelectedFolder();
		this.folderSummaryEl.setText(folder.isRoot() ? '/' : `/${folder.path}`);
	}
}
