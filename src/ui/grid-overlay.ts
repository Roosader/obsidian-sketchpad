export function createGridOverlay(container: HTMLElement): HTMLCanvasElement {
	return container.createEl('canvas', { cls: 'sketchpad-grid-overlay' });
}

export function drawGrid(
	canvas: HTMLCanvasElement,
	width: number,
	height: number,
	size: number,
	color: string,
	opacity: number,
): void {
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		return;
	}
	ctx.clearRect(0, 0, width, height);
	ctx.save();
	ctx.globalAlpha = Math.min(100, Math.max(0, opacity)) / 100;
	ctx.strokeStyle = color;
	ctx.lineWidth = 1;
	ctx.beginPath();
	for (let x = size + 0.5; x < width; x += size) {
		ctx.moveTo(x, 0);
		ctx.lineTo(x, height);
	}
	for (let y = size + 0.5; y < height; y += size) {
		ctx.moveTo(0, y);
		ctx.lineTo(width, y);
	}
	ctx.stroke();
	ctx.restore();
}

export function clearGrid(canvas: HTMLCanvasElement): void {
	canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
}
