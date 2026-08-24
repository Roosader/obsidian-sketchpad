import { AUTOSAVE_INTERVAL_OPTIONS, DEFAULT_AUTOSAVE_INTERVAL_MINUTES, DEFAULT_LAYER_ORDER, DEFAULT_PAPER_COLOR, MAX_GRID_SIZE, MAX_IMAGE_DIMENSION, MIN_PREDICTION_DISTANCE_MS, MAX_PREDICTION_DISTANCE_MS, MIN_PREDICTION_SENSITIVITY, MAX_PREDICTION_SENSITIVITY, PREDICTION_MIN_VEL_AT_ZERO, PREDICTION_MIN_VEL_AT_FULL, WINDOWS_RESERVED_BASENAMES } from './constants';
import type { LayerName } from './types';

export function validateCrossPlatformFileName(name: string): string | null {
    if (name === '.' || name === '..') {
        return 'File name cannot be . or ..';
    }

    if (name.length > 200) {
        return 'File name is too long. Please keep it under 200 characters.';
    }

    if ([...name].some((char) => char.charCodeAt(0) < 0x20 || '<>:"/\\|?*'.includes(char))) {
        return 'File name contains invalid characters.';
    }

    if (/[\s.]$/.test(name)) {
        return 'File name cannot end with a space or period.';
    }

    const windowsBase = name.split('.')[0]?.toUpperCase() ?? '';
    if (WINDOWS_RESERVED_BASENAMES.has(windowsBase)) {
        return `File name ${name} is reserved on Windows.`;
    }

    return null;
}

// single characters are stored lowercase so a Shift/CapsLock press still matches its binding
export function normalizeHotkeyKey(raw: string): string {
	return raw.length === 1 ? raw.toLowerCase() : raw;
}

export function sanitizeDimension(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(MAX_IMAGE_DIMENSION, Math.max(1, Math.round(value)));
}

export function sanitizePaperColor(value: string | undefined): string {
    if (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)) {
        return value;
    }
    return DEFAULT_PAPER_COLOR;
}

export function sanitizeGridSize(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(MAX_GRID_SIZE, Math.max(1, Math.round(value)));
}

export function sanitizeGridOpacity(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(100, Math.max(0, Math.round(value)));
}

export function sanitizePredictionDistance(value: number | undefined, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.min(MAX_PREDICTION_DISTANCE_MS, Math.max(MIN_PREDICTION_DISTANCE_MS, Math.round(value)));
}

export function sanitizePredictionSensitivity(value: number | undefined, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.min(MAX_PREDICTION_SENSITIVITY, Math.max(MIN_PREDICTION_SENSITIVITY, Math.round(value)));
}

/** Map a 0–100 sensitivity slider value to the internal MIN_VELOCITY (px/ms).
 *  Linear mapping: 0→2.0 (stable, only predicts on fast moves),
 *  50→1.05, 100→0.1 (responsive, predicts even on slow strokes).
 *  Linear (not quadratic) so every slider tick produces a visible change. */
export function sensitivityToMinVelocity(sliderValue: number): number {
	const t = sliderValue / 100; // 0..1
	return PREDICTION_MIN_VEL_AT_ZERO + (PREDICTION_MIN_VEL_AT_FULL - PREDICTION_MIN_VEL_AT_ZERO) * t;
}

const SENSITIVITY_LABELS = ['Low', 'Medium-low', 'Medium', 'Medium-high', 'High'];

// Return a qualitative label for a 0–100 sensitivity slider value
export function predictionSensitivityLabel(sliderValue: number): string {
	const idx = Math.min(4, Math.floor(sliderValue / 25));
	return SENSITIVITY_LABELS[idx]!;
}

const FIXED_LAYER_NAMES = DEFAULT_LAYER_ORDER;

export function sanitizeLayerOrder(value: unknown, fallback: LayerName[]): LayerName[] {
    if (!Array.isArray(value)) {
        return fallback;
    }
    const result: LayerName[] = [];
    const used = new Set<LayerName>();
    for (const entry of value) {
        if (typeof entry === 'string' && (FIXED_LAYER_NAMES as string[]).includes(entry) && !used.has(entry as LayerName)) {
            used.add(entry as LayerName);
            result.push(entry as LayerName);
        }
    }
    // Ensure Paper is first and every fixed layer is present.
    for (const name of FIXED_LAYER_NAMES) {
        if (!used.has(name)) {
            result.push(name);
        }
    }
    const paperIndex = result.indexOf('Paper');
    if (paperIndex > 0) {
        const [paper] = result.splice(paperIndex, 1);
        if (paper) {
            result.unshift(paper);
        }
    }
    return result;
}

export function sanitizeAutosaveInterval(value: number | undefined): number {
    if (typeof value === 'number' && AUTOSAVE_INTERVAL_OPTIONS.includes(value)) {
        return value;
    }
    return DEFAULT_AUTOSAVE_INTERVAL_MINUTES;
}

export function sanitizePanelPos(value: { x: number; y: number } | undefined): { x: number; y: number } | null {
    if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
        return null;
    }
    return { x: value.x, y: value.y };
}

// releases focus from any clicked interactive control 
export function blurControlFocusHandler(): (event: MouseEvent) => void {
    return (event: MouseEvent) => {
        const target = event.target as HTMLElement | null;
        const control = target?.closest<HTMLElement>(
            'button, input[type="range"], input[type="checkbox"], input[type="radio"], input[type="color"]',
        );
        control?.blur();
    };
}

// true when the Wacom stylus eraser end is in contact (button 5 / buttons bit 5).
// Only detectable while pressed; the pen tip reports button 0 / buttons bit 0.
export function isStylusEraser(event: PointerEvent): boolean {
    return event.pointerType === 'pen' && (event.button === 5 || (event.buttons & 32) !== 0);
}
