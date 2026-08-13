export interface PanelDragPosition {
	x: number;
	y: number;
}

export type PanelAnchor = 'left' | 'right';

export function wirePanelDrag(
	button: HTMLElement,
	panel: HTMLElement,
	referenceEl: HTMLElement,
	onCommit: (position: PanelDragPosition) => void,
	anchor: PanelAnchor = 'left',
): void {
	let offsetX = 0;
	let offsetY = 0;
	let x = 0;
	let y = 0;
	let dragging = false;

	const onPointerDown = (event: PointerEvent): void => {
		event.preventDefault();
		const refRect = referenceEl.getBoundingClientRect();
		const panelRect = panel.getBoundingClientRect();

		offsetX = anchor === 'right' ? panelRect.right - event.clientX : event.clientX - panelRect.left;
		offsetY = event.clientY - panelRect.top;
		x = anchor === 'right' ? refRect.right - panelRect.right : panelRect.left - refRect.left;
		y = panelRect.top - refRect.top;
		dragging = true;
		button.setPointerCapture(event.pointerId);

		panel.classList.add('sketchpad-panel-positioned');
	};

	const onPointerMove = (event: PointerEvent): void => {
		if (!dragging) {
			return;
		}
		const refRect = referenceEl.getBoundingClientRect();
		const panelRect = panel.getBoundingClientRect();

		const maxX = Math.max(0, refRect.width - panelRect.width);
		const maxY = Math.max(0, refRect.height - panelRect.height);
		if (anchor === 'right') {
			x = Math.min(Math.max(0, refRect.right - event.clientX - offsetX), maxX);
		} else {
			x = Math.min(Math.max(0, event.clientX - refRect.left - offsetX), maxX);
		}
		y = Math.min(Math.max(0, event.clientY - refRect.top - offsetY), maxY);
		panel.style.setProperty(anchor === 'right' ? 'right' : 'left', `${x}px`);
		panel.style.setProperty('top', `${y}px`);
	};

	const finishDrag = (event: PointerEvent): void => {
		if (!dragging) {
			return;
		}
		dragging = false;
		if (button.hasPointerCapture(event.pointerId)) {
			button.releasePointerCapture(event.pointerId);
		}
		onCommit({ x, y });
	};

	button.addEventListener('pointerdown', onPointerDown);
	button.addEventListener('pointermove', onPointerMove);
	button.addEventListener('pointerup', finishDrag);
	button.addEventListener('pointercancel', finishDrag);
}
