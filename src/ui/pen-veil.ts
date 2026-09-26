// Minimal hack for the Windows Ink + Chromium pen-up cursor flash
//
// when a mouse is parked on (or a stylus hovers) Obsidian chrome
// (tab headers, sidebar) and then draws on the canvas, Chromium can repaint
// the OS cursor on pen-up with that stale hover shape.
// fix is a hit-target swap: while the pen is in contact with the drawing area and shortly after pen-up,
// the stale hover point must hit-test as `cursor: none`.
//
// this module parks one small fixed patch over each known stale hover point 
// (the last mouse position, and the last pen hover outside the leaf)

export interface StaleHoverPoint {
	x: number;
	y: number;
}

export interface PenPatchCover {
	show(points: readonly StaleHoverPoint[]): void; //enable the patches over the stale hover points
	hide(): void; //hide to let pointer pass through
	isActive(): boolean; //if any patch is showing
	destroy(): void;
}

const PATCH_PX = 64; //Patch size in CSS px: covers the OS cursor hotspot plus HiDPI slop
export const PEN_PATCH_SLOT_COUNT = 2; //Maximum stale points covered at once (mouse slot + pen slot)

// Only one sketchpad view can hold pen contact at a time; if a second view
// shows its cover, the first one steps aside so patches don't stack.
let activeCover: PenPatchCover | null = null;

function releaseActiveCover(cover: PenPatchCover): void {
	if (activeCover === cover) {
		activeCover = null;
	}
}

function takeActiveCover(next: PenPatchCover): void {
	if (activeCover !== null && activeCover !== next && activeCover.isActive()) {
		activeCover.hide();
	}
	activeCover = next;
}

class PenPatchCoverImpl implements PenPatchCover {
	private readonly layer: HTMLDivElement;
	private readonly mousePatch: HTMLDivElement;
	private readonly penPatch: HTMLDivElement;
	private active = false;
	private destroyed = false;

	constructor() {
		this.layer = createDiv({ cls: 'sketchpad-pen-patch-layer' });
		this.layer.setAttribute('aria-hidden', 'true');
		this.mousePatch = this.layer.createDiv({ cls: 'sketchpad-pen-patch' });
		this.mousePatch.dataset.slot = 'mouse';
		this.penPatch = this.layer.createDiv({ cls: 'sketchpad-pen-patch' });
		this.penPatch.dataset.slot = 'pen';
		document.body.appendChild(this.layer);
	}

	show(points: readonly StaleHoverPoint[]): void {
		if (this.destroyed) {
			return;
		}
		takeActiveCover(this);
		// No known hover point means no stale shape exists to flash; stay
		// hidden rather than covering the window for no reason.
		const mousePoint = points.length > 0 ? points[0] : undefined;
		const penPoint = points.length > 1 ? points[1] : undefined;
		this.active = mousePoint !== undefined || penPoint !== undefined;
		this.layer.classList.toggle('is-blocking', this.active);
		if (mousePoint !== undefined) {
			positionPatch(this.mousePatch, mousePoint);
		}
		if (penPoint !== undefined) {
			positionPatch(this.penPatch, penPoint);
		}
		// Slots without a point stay parked on the shared class hook; the
		// per-slot visibility class decides which patches hit-test.
		this.mousePatch.classList.toggle('is-shown', mousePoint !== undefined);
		this.penPatch.classList.toggle('is-shown', penPoint !== undefined);
	}

	hide(): void {
		if (this.destroyed || !this.active) {
			return;
		}
		this.active = false;
		this.layer.classList.remove('is-blocking');
		this.mousePatch.classList.remove('is-shown');
		this.penPatch.classList.remove('is-shown');
		releaseActiveCover(this);
	}

	isActive(): boolean {
		return this.active;
	}

	destroy(): void {
		if (this.destroyed) {
			return;
		}
		this.destroyed = true;
		releaseActiveCover(this);
		this.layer.remove();
	}
}

function positionPatch(patch: HTMLElement, point: StaleHoverPoint): void {
	// Center on the parked point, clamped so the patch never leaves the viewport 
	const half = PATCH_PX / 2;
	const x = Math.round(
		Math.min(Math.max(point.x - half, 0), Math.max(0, window.innerWidth - PATCH_PX)),
	);
	const y = Math.round(
		Math.min(Math.max(point.y - half, 0), Math.max(0, window.innerHeight - PATCH_PX)),
	);
	patch.style.left = `${x}px`;
	patch.style.top = `${y}px`;
	patch.style.width = `${PATCH_PX}px`;
	patch.style.height = `${PATCH_PX}px`;
}

export function createPenPatchCover(): PenPatchCover {
	return new PenPatchCoverImpl();
}

