import { App, Modal } from 'obsidian';
import { blurControlFocusHandler } from '../utilities/utils';

// lets the user pick one extra layer to delete. Paper/Sketch/Ink/Paint layers are protected and never listed.
export class DeleteLayerModal extends Modal {
    private selected: string | null = null;
    private confirmButton: HTMLButtonElement | null = null;

    constructor(
        app: App,
        private readonly extraLayers: string[],
        private readonly onConfirm: (layerName: string) => void,
    ) {
        super(app);
    }

    onOpen(): void {
        this.contentEl.empty();
        this.contentEl.addClass('sketchpad-export-file-modal');
        this.modalEl.addEventListener('click', blurControlFocusHandler(), true);
        this.contentEl.createEl('h2', { text: 'Delete layer' });

        const deleteText = this.contentEl.createEl('p', {cls:'sketchpad-delete-layer-text'});
        if (this.extraLayers.length === 0) {
            deleteText.textContent = 'There are no extra layers to delete.'
            this.contentEl.createEl('button', { text: 'Close', cls: 'sketchpad-delete-layer-button' })
                .addEventListener('click', () => this.close());
            return;
        }
        else {
            deleteText.textContent = 'Only extra layers can be deleted.';
        }

        const list = this.contentEl.createDiv({ cls: 'sketchpad-delete-layer-list' });
        for (const name of this.extraLayers.reverse()) {
            const row = list.createDiv({ cls: 'sketchpad-delete-layer-row', text: name });
            row.addEventListener('click', () => {
                this.selected = name;
                for (const other of Array.from(list.children)) {
                    other.classList.toggle('is-selected', other === row);
                }
                if (this.confirmButton) {
                    this.confirmButton.disabled = false;
                }
            });
        }

        const buttonRow = this.contentEl.createDiv({ cls: 'sketchpad-delete-layer-button-row' });
        this.confirmButton = buttonRow.createEl('button', { text: 'Delete', cls: 'mod-warning' });
        this.confirmButton.disabled = true;
        this.confirmButton.addEventListener('click', () => {
            if (!this.selected) {
                return;
            }
            const target = this.selected;
            this.close();
            this.onConfirm(target);
        });
        buttonRow.createEl('button', { text: 'Cancel'})
            .addEventListener('click', () => this.close());
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
