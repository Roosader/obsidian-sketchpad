import { App, Modal } from "obsidian";
import { blurControlFocusHandler } from '../utilities/utils';

export type ConfirmChoice = 'yes' | 'no' | 'cancel';

export class ConfirmModal extends Modal {
	private settled = false;

	constructor(
        app: App, 
        private message: string,
        private onConfirm: (choice: ConfirmChoice) => void) 
    {
		super(app);
        this.modalEl.addClass("sketchpad-confirm-modal");
		this.modalEl.querySelector(".modal-header")?.remove();
	}

	private resolve(choice: ConfirmChoice): void {
		if (this.settled) {
			return;
		}
		this.settled = true;
		this.onConfirm(choice);
	}

	onOpen(): void {
		// Release focus from clicked buttons so a later Space (tool hotkey)
		// doesn't natively re-activate the last-clicked button.
		this.modalEl.addEventListener('click', blurControlFocusHandler(), true);

		const { contentEl } = this;
		contentEl.createEl("p", { text: this.message });

		const buttonContainer = contentEl.createDiv();

		buttonContainer.createEl("button", {
			text: "Yes",
		}).addEventListener("click", () => {
			this.resolve('yes');
			this.close();
		});

		buttonContainer.createEl("button", {
			text: "No",
		}).addEventListener("click", () => {
			this.resolve('no');
			this.close();
		});
	}

	onClose() {
		this.resolve('cancel');
		this.contentEl.empty();
	}
}