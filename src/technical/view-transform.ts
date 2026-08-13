import { MIN_ZOOM,MAX_ZOOM, MIN_ROTATION, MAX_ROTATION} from '../utilities/constants'

// describes how the canvas is currently displayed
// non-destructive view transform: zoom, rotation, pan, and flip
export interface ViewTransform {
	zoom: number; // scale factor; 1 = 100%
	rotation: number; // degrees
	panX: number; // CSS pixels
	panY: number; // CSS pixels
	flipX: boolean; // mirrored left-right
	flipY: boolean; // mirrored top-bottom
}

interface Size {
	width: number;
	height: number;
}


export const DEFAULT_VIEW_TRANSFORM: ViewTransform = { zoom: 1, rotation: 0, panX: 0, panY: 0, flipX: false, flipY: false };

export function clampZoom(zoom: number): number {
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function clampRotation(rotation: number): number {
	return Math.min(MAX_ROTATION, Math.max(MIN_ROTATION, rotation));
}

// scale factor applied to each axis, preserving flip
function axisScale(zoom: number, flip: boolean): number {
	return flip ? -zoom : zoom;
}

// CSS transform applied to the canvas element itself. Order matters.
// scale/flip and rotate are applied first around the element's own center
// then the result is translated (panned) in screen pixels
export function cssTransformFor(view: ViewTransform): string {
	const scaleX = axisScale(view.zoom, view.flipX);
	const scaleY = axisScale(view.zoom, view.flipY);
	return `translate(${view.panX}px, ${view.panY}px) rotate(${view.rotation}deg) scale(${scaleX}, ${scaleY})`;
}

export function fitToView(availableSize: Size, documentSize: Size): ViewTransform {
	const scaleX = availableSize.width / documentSize.width;
	const scaleY = availableSize.height / documentSize.height;

	let zoom = 1;
	if (scaleX < 1 || scaleY < 1) {
		zoom = Math.min(scaleX, scaleY);
	}

	return { ...DEFAULT_VIEW_TRANSFORM, zoom };
}

