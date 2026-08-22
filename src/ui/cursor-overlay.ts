import type { ViewTool } from '../utilities/types';
import { TINY_CROSS_CURSOR, SMALL_CIRCLE_CURSOR } from '../utilities/constants';

const CURSOR_PX = 12;   // minimum display size of the cursor canvas (CSS px)
const RENDER_SCALE = 2; // render at 2x so the ring stays crisp after downscale
const TIP_LINE_PX = 0.5; // hairline width of the tip circle + outline (CSS px)
const TIP_PADDING_PX = 1; // canvas padding beyond the tip circle (CSS px)

const DRAWN_TOOLS: ReadonlySet<ViewTool> = new Set(['pencil', 'pen', 'brush', 'eraser']);

let cursorBitmap: HTMLCanvasElement | null = null;
let cursorBitmapPromise: Promise<HTMLCanvasElement> | null = null;
let circleCursorBitmap: HTMLCanvasElement | null = null;
let circleCursorBitmapPromise: Promise<HTMLCanvasElement> | null = null;

function loadImage(url: string): Promise<HTMLImageElement> {
	return new Promise<HTMLImageElement>((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error(`Failed to load cursor icon for ${url.slice(0, 32)}`));
		image.src = url;
	});
}

async function renderBitmap(url: string): Promise<HTMLCanvasElement> {
	const bitmap = createEl('canvas');
	try {
		const image = await loadImage(url);
		bitmap.width = image.naturalWidth;
		bitmap.height = image.naturalHeight;
		const ctx = bitmap.getContext('2d');
		if (!ctx) {
			return bitmap;
		}
		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(image, 0, 0);
	} catch {
		// leave the bitmap empty.
	}
	return bitmap;
}

function ensureCursorBitmap(): Promise<HTMLCanvasElement> {
	if (cursorBitmap) {
		return Promise.resolve(cursorBitmap);
	}
	if (!cursorBitmapPromise) {
		cursorBitmapPromise = renderBitmap(TINY_CROSS_CURSOR).then((bitmap) => {
			cursorBitmap = bitmap;
			cursorBitmapPromise = null;
			return bitmap;
		});
	}
	return cursorBitmapPromise;
}

function ensureCircleCursorBitmap(): Promise<HTMLCanvasElement> {
	if (circleCursorBitmap) {
		return Promise.resolve(circleCursorBitmap);
	}
	if (!circleCursorBitmapPromise) {
		circleCursorBitmapPromise = renderBitmap(SMALL_CIRCLE_CURSOR).then((bitmap) => {
			circleCursorBitmap = bitmap;
			circleCursorBitmapPromise = null;
			return bitmap;
		});
	}
	return circleCursorBitmapPromise;
}

// tracks the pointer over the canvas panel
export class CursorOverlay {
	private readonly canvas: HTMLCanvasElement;
	private readonly ctx: CanvasRenderingContext2D;
	private readonly getCurrentTool: () => ViewTool;
	private readonly getToolSize: (tool: ViewTool) => number;
	private readonly getZoom: () => number;
	private readonly getToolSelected: () => boolean;
	private readonly getIsTouchDrawing: () => boolean;

	private rectLeft = 0;
	private rectTop = 0;
	private hasPosition = false;
	private lastClientX = 0;
	private lastClientY = 0;

	private lastPointerType = 'mouse';
	private lastButtons = 0;

	private cssSize = -1; // current canvas display size (CSS px)

	private predictionOffsetX = 0; // pointer-prediction offset (client px), applied on top of lastClientX/Y
	private predictionOffsetY = 0;

	private iconBitmap: HTMLCanvasElement | null = null; //cursor for marking tools
	private circleBitmap: HTMLCanvasElement | null = null; //cursor for non-marking tools on pen input

	constructor(
		panel: HTMLElement,
		getCurrentTool: () => ViewTool,
		getToolSize: (tool: ViewTool) => number,
		getZoom: () => number,
		getToolSelected: () => boolean,
		getIsTouchDrawing: () => boolean,
	) {
		this.getCurrentTool = getCurrentTool;
		this.getToolSize = getToolSize;
		this.getZoom = getZoom;
		this.getToolSelected = getToolSelected;
		this.getIsTouchDrawing = getIsTouchDrawing;

		this.canvas = panel.createEl('canvas', { cls: 'sketchpad-cursor-overlay' });
		this.ctx = this.canvas.getContext('2d')!;
		this.updateTipSize();
		this.updateRect();
		this.hide();

		void ensureCursorBitmap().then((bitmap) => {
			this.iconBitmap = bitmap;
			this.drawCanvas();
		});

		void ensureCircleCursorBitmap().then((bitmap) => {
			this.circleBitmap = bitmap;
			this.refresh();
		});
	}

	resize(): void {
		this.updateRect();
		this.refresh();
	}

	/** Set an additional offset (client-space px) from pointer prediction. */
	setPredictionOffset(dx: number, dy: number): void {
		this.predictionOffsetX = dx;
		this.predictionOffsetY = dy;
	}

	// moves the cursor canvas to the latest pointer position 
	handlePointerMove(clientX: number, clientY: number, pointerType: string, buttons: number): void {
		this.lastClientX = clientX;
		this.lastClientY = clientY;
		this.lastPointerType = pointerType;
		this.lastButtons = buttons;
		this.hasPosition = true;
		if (!this.isDrawnTool()) {
			this.hide();
			return;
		}

		this.updateTipSize();
		this.place();
	}

	handlePointerLeave(): void {
		this.hasPosition = false;
		this.predictionOffsetX = 0;
		this.predictionOffsetY = 0;
		this.hide();
	}

	// records the pointer type; visibility is decided by isDrawnTool(), which
	// shows the cursor while touch-drawing and hides it for pan/zoom/rotate
	handlePointerDown(pointerType: string): void {
		this.lastPointerType = pointerType;
	}

	destroy(): void {
	}

	refresh(): void {
		this.updateTipSize();
		if (!this.hasPosition || !this.isDrawnTool()) {
			this.hide();
			return;
		}
		this.place();
	}

	private isDrawnTool(): boolean {
		if (!this.getToolSelected()) {
			return false;
		}

		if (this.lastPointerType === 'touch') {
			// only show the custom cursor while actively touch-drawing (one
			// finger with touch-to-draw enabled); hide during touch gestures
			return this.isMarkingTool() && this.getIsTouchDrawing();
		}
		// true for marking tools, or when using other tools with a pen
		return this.isMarkingTool() || (this.lastPointerType === 'pen' && (this.lastButtons & 1) !== 0);
	}

	// true while the Wacom stylus eraser end is in contact (buttons bit 5)
	private isStylusEraserActive(): boolean {
		return this.lastPointerType === 'pen' && (this.lastButtons & 32) !== 0;
	}

	// the eraser is always active when using the wacom stylus eraser end
	private effectiveTool(): ViewTool {
		return this.isStylusEraserActive() ? 'eraser' : this.getCurrentTool();
	}

	private isMarkingTool(): boolean {
		return DRAWN_TOOLS.has(this.effectiveTool());
	}

	private updateTipSize(): void {
		let cssSize: number;
		if (this.isMarkingTool()) {
			const tipDiameterCss = this.getToolSize(this.effectiveTool()) * this.getZoom();
			cssSize = Math.max(
				CURSOR_PX,
				Math.ceil(tipDiameterCss) + 2 * TIP_PADDING_PX,
			);
		} else if (this.isDrawnTool() && this.circleBitmap) {
			// non-marking tool with a pen
			cssSize = Math.max(
				CURSOR_PX,
				this.circleBitmap.width + 2 * TIP_PADDING_PX,
				this.circleBitmap.height + 2 * TIP_PADDING_PX,
			);
		} else {
			cssSize = CURSOR_PX;
		}
		if (cssSize === this.cssSize) {
			return;
		}
		this.cssSize = cssSize;
		
		this.canvas.width = Math.max(1, Math.round(cssSize * RENDER_SCALE));
		this.canvas.height = Math.max(1, Math.round(cssSize * RENDER_SCALE));
		this.canvas.style.width = `${cssSize}px`;
		this.canvas.style.height = `${cssSize}px`;
		this.drawCanvas();
	}

	// draws the canvas that contains the cursor
	private drawCanvas(): void {
		const marking = this.isMarkingTool();
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		if (marking) {

			const scale = RENDER_SCALE;
			const radius = ((this.getToolSize(this.effectiveTool()) * this.getZoom()) / 2) * scale;
			const cx = this.canvas.width / 2;
			const cy = this.canvas.height / 2;
			const hairline = TIP_LINE_PX * scale;
			this.ctx.lineWidth = hairline;
			// thin white outline outside the black circle
			this.ctx.beginPath();
			this.ctx.arc(cx, cy, radius + hairline, 0, Math.PI * 2);
			this.ctx.strokeStyle = 'white';
			this.ctx.stroke();
			this.ctx.beginPath();
			this.ctx.arc(cx, cy, radius, 0, Math.PI * 2);
			this.ctx.strokeStyle = 'black';
			this.ctx.stroke();
		}
		if (marking && this.iconBitmap) {
			// tiny cross for marking tools
			this.drawCenteredBitmap(this.iconBitmap);
		} else if (this.isDrawnTool() && this.circleBitmap) {
			// circle cursor for non-marking tools during pen input
			this.drawCenteredBitmap(this.circleBitmap);
		}
	}

	private drawCenteredBitmap(bitmap: HTMLCanvasElement): void {
		const w = bitmap.width * RENDER_SCALE;
		const h = bitmap.height * RENDER_SCALE;
		let x = (this.canvas.width - w) / 2;
		let y = (this.canvas.height - h) / 2;
		x -= x % RENDER_SCALE;
		y -= y % RENDER_SCALE;
		this.ctx.imageSmoothingEnabled = false;
		this.ctx.drawImage(bitmap, x, y, w, h);
	}

	private place(): void {
		// round to whole pixels to prevent aliasing
		const x = Math.round(this.lastClientX + this.predictionOffsetX - this.rectLeft - this.cssSize / 2);
		const y = Math.round(this.lastClientY + this.predictionOffsetY - this.rectTop - this.cssSize / 2);
		this.canvas.style.transform = `translate3d(${x}px, ${y}px, 0)`;
	}

	private hide(): void {
		// hide the cursor canvas offscreen
		const offscreen = -9999;
		this.canvas.style.transform = `translate3d(${offscreen}px, ${offscreen}px, 0)`;
	}

	private updateRect(): void {
		const panel = this.canvas.parentElement;
		if (!panel) {
			return;
		}
		const rect = panel.getBoundingClientRect();
		this.rectLeft = rect.left;
		this.rectTop = rect.top;
	}
}
