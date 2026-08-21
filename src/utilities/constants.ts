import type { LayerName, ViewTool, RotateAction, SizeAction } from './types';

export const DEFAULT_FILE_NAME = 'Untitled sketch';

export const IMAGE_DPI = 300;

export const DEFAULT_IMAGE_WIDTH = 1000;
export const DEFAULT_IMAGE_HEIGHT = 1000;
export const DEFAULT_PAPER_COLOR = '#ffffff';

export const MAX_IMAGE_DIMENSION = 4096;
export const THUMBNAIL_MAX_DIMENSION = 256;

export const DEFAULT_GRID_SIZE = 20;
export const DEFAULT_GRID_COLOR = '#42bef8';
export const DEFAULT_GRID_OPACITY = 40; // percent, 0-100
export const MAX_GRID_SIZE = 512;

export const DEFAULT_LAYER_ORDER: LayerName[] = ['Paper', 'Sketch', 'Ink', 'Paint'];

export const DEFAULT_AUTOSAVE_INTERVAL_MINUTES = 15;
export const AUTOSAVE_INTERVAL_OPTIONS: number[] = [5, 10, 15, 20, 25, 30];

export const DEFAULT_TOOL_SPACING = 0.15;

export const TOOL_TIP_MAX_SIZE = 200;

export const TINY_CROSS_CURSOR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAQAAAAnZu5uAAAACXBIWXMAAFxGAABcRgEUlENBAAAAG3RFWHRTb2Z0d2FyZQBDZWxzeXMgU3R1ZGlvIFRvb2zBp+F8AAAAIklEQVQI103KsQ0AIADDMOf/o8uCEGucBhONZdSWC3997wF7Jg0A+U7EygAAAABJRU5ErkJggg==';
export const SMALL_CIRCLE_CURSOR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABkAAAAZCAQAAABu4E3oAAAACXBIWXMAAFxGAABcRgEUlENBAAAAG3RFWHRTb2Z0d2FyZQBDZWxzeXMgU3R1ZGlvIFRvb2zBp+F8AAAAcklEQVQ4y+3UOxLAIAgEULj/oUkBGn4xZOukceLw2EKRhdJXNojTr6RyprYH90TYL6HA91rE9qSGWNGNNnkGGVnuGUTEMgIeGXkHipQMM3aOkhlYOT+ByNdzAU4fumOjnHiTB6jOCzSVwOyDL0z/jpUeF7q5cvrQDnudAAAAAElFTkSuQmCC';

export const PRESSURE_POINT_SIZE = 10; 

export const MAX_UNDO_COUNT = 50;

export const toolCursorClasses = [
	'sketchpad-pencil-active',
	'sketchpad-pen-active',
	'sketchpad-brush-active',
	'sketchpad-eraser-active',
	'sketchpad-eyedropper-active',
	'sketchpad-hand-active',
	'sketchpad-lasso-active',
	'sketchpad-zoom-in-active',
	'sketchpad-zoom-out-active',
	'sketchpad-rotate-active',
];

export const MIN_ZOOM = 0.1; // 10%
export const MAX_ZOOM = 10;	// 1000%
export const MIN_ROTATION = -180;
export const MAX_ROTATION = 180;

export const ROTATE_TOOL_SENSITIVITY = 1; // degrees of rotation per press of the rotate hotkey
export const ZOOM_TOOL_SENSITIVITY = 0.01; // exponential zoom speed per pixel of horizontal drag
export const ZOOM_TOOL_CLICK_FACTOR = 1.2; // zoom factor for a single click of the zoom tool
export const ROTATE_HANDLE_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADMAAAAzCAQAAACQqPihAAAACXBIWXMAAFxGAABcRgEUlENBAAAAG3RFWHRTb2Z0d2FyZQBDZWxzeXMgU3R1ZGlvIFRvb2zBp+F8AAABKElEQVRYw+3Y3Q7CIAwFYM77P3S92NQCbTn8pEajFyYO3LcOxloghfnA7SbY+z/bgcLCs9SNfU/QlMvohjggEJTDPA9zI6cxGzKYeWJMdcw6EkENs4f4UMVcP9aJmtKQYkZIP7ZCQxQTP3syw3CIDI560M14CAY3CMM14oIUE1wTN7fMFsXszzD7ct7xvBg5M4mdeCBHnxYvnsNMe56G2UciSIByKJZExhof3N9yDvHj+U7Gu21/5vPMb800b/nMXAUS1rTTK7T9Yst936wx6BKq4O25mgvoE3vZDdqUYxbSGVqEKGY+HlBJLqx0kIe4pN3IOmegeWSq8IiqAzlReDAliLDMSiFVgqLEqdbSas+0SjptXyBtlyNxzyZtBypxP23ckdsbLOUBxibYAewkHIAAAAAASUVORK5CYII='

export const TAP_THRESHOLD_MS = 150; // max duration of a key press to count as a tap (vs hold) for tool hotkeys

export const ROTATE_HOLD_DELAY_MS = 200; // delay before a held rotate hotkey starts repeating
export const ROTATE_REPEAT_INTERVAL_MS = 50; //how often a held rotate hotkey keeps rotating the canvas (ms per step)

export const MODIFIER_HOTKEY_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

export const DEFAULT_TOOL_HOTKEYS: Partial<Record<ViewTool, string>> = {
	pencil: 'p',
	pen: 'n',
	brush: 'b',
	eraser: 'e',
	hand: ' ',
	lasso: 'c',
	rotate: 'r',
	'zoom-in': 'Shift',
	'zoom-out': 'Control',
	eyedropper: 'Alt',
};

export const DEFAULT_ROTATE_HOTKEYS: Partial<Record<RotateAction, string>> = {
	'rotate-ccw': 'a',
	'rotate-cw': 's',
};

export const DEFAULT_SIZE_HOTKEYS: Partial<Record<SizeAction, string>> = {
	'size-increase': 'f',
	'size-decrease': 'd',
};

// size step per press, in perceptual slider units (0-100)
export const SIZE_STEP = 5;

export const DEFAULT_ROTATE_SENSITIVITY = 3; // degrees per press
export const MIN_ROTATE_SENSITIVITY = 1;
export const MAX_ROTATE_SENSITIVITY = 90;

export const WHEEL_ZOOM_FACTOR = 1.1; // Zoom factor applied per mouse-wheel notch when zooming with the wheel

export const WINDOWS_RESERVED_BASENAMES = new Set([
    'CON','PRN','AUX','NUL','COM1',
    'COM2','COM3','COM4','COM5','COM6',
    'COM7','COM8','COM9','LPT1','LPT2',
    'LPT3','LPT4','LPT5','LPT6','LPT7',
    'LPT8','LPT9',
]);