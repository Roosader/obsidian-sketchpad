import type SketchpadPlugin from '../main';
import { hexToOkhsl, okhslToHex } from '../technical/okhsl';
import type { ToolName } from '../utilities/types';

export interface OkhslColorPickerElements {
	panelEl: HTMLElement;
	swatchEl: HTMLElement;
	lightnessInput: HTMLInputElement;
	saturationInput: HTMLInputElement;
	hueInput: HTMLInputElement;
	lightnessValueEl: HTMLElement;
	saturationValueEl: HTMLElement;
	hueValueEl: HTMLElement;

	setColor(hex: string): void;
}

interface SliderDef {
	input: HTMLInputElement;
	valueEl: HTMLElement;
	label: string;
}

const RAMP_STOPS = 20; // Number of gradient stops per ramp, maybe put in constants later

export function buildOkhslColorPicker(
	container: HTMLElement,
	plugin: SketchpadPlugin,
	getCurrentTool: () => ToolName,
	syncNativeColorInput: (hex: string) => void,
): OkhslColorPickerElements {
	const panelEl = container.createDiv({ cls: 'sketchpad-okhsl-color-picker' });
	panelEl.createDiv({ text: 'Color picker', cls: 'sketchpad-tool-sidebar-title' });

	const swatchEl = panelEl.createDiv({ cls: 'sketchpad-okhsl-swatch' });
	setSwatch(swatchEl, '#000000');

	const slidersRow = panelEl.createDiv({ cls: 'sketchpad-okhsl-sliders' });

	// internal OKHSL state (h 0-360, s 0-1, l 0-1).
	let current = { h: 0, s: 0, l: 0 };

	const makeSlider = (label: string, min: number, max: number, step: number): SliderDef => {
		const group = slidersRow.createDiv({ cls: 'sketchpad-okhsl-slider-group' });
		const labelEl = group.createEl('label', { text: label, cls: 'sketchpad-okhsl-slider-label' });
		const input = group.createEl('input', { type: 'range', cls: 'sketchpad-okhsl-slider' });
		input.setAttribute('min', String(min));
		input.setAttribute('max', String(max));
		input.setAttribute('step', String(step));
		const valueEl = group.createSpan({ cls: 'sketchpad-okhsl-value' });
		labelEl.title = label;
		return { input, valueEl, label };
	};

	const lightness = makeSlider('L', 0, 1, 0.01);
	const saturation = makeSlider('S', 0, 1, 0.01);
	const hue = makeSlider('H', 0, 360, 1);

	const readCurrent = (): void => {
		current.l = Number(lightness.input.value);
		current.s = Number(saturation.input.value);
		current.h = Number(hue.input.value);
	};

	const render = (): void => {
		const hex = okhslToHex(current.h, current.s, current.l);
		setSwatch(swatchEl, hex);
		lightness.valueEl.setText(current.l.toFixed(2));
		saturation.valueEl.setText(current.s.toFixed(2));
		hue.valueEl.setText(`${Math.round(current.h)}°`);
		setRamp(lightness.input, rampStops((t) => okhslToHex(current.h, current.s, t)));
		setRamp(saturation.input, rampStops((t) => okhslToHex(current.h, t, current.l)));
		setRamp(hue.input, rampStops((t) => okhslToHex(t * 360, current.s, current.l)));
	};

	const pushToPlugin = (): void => {
		const hex = okhslToHex(current.h, current.s, current.l);
		plugin.toolSettings[getCurrentTool()].color = hex;
		syncNativeColorInput(hex);
	};

	for (const def of [lightness, saturation, hue]) {
		def.input.addEventListener('input', () => {
			readCurrent();
			pushToPlugin();
			render();
		});
		def.input.addEventListener('change', () => void plugin.saveToolSettings());
	}

	const setColor = (hex: string): void => {
		const parsed = hexToOkhsl(hex);
		current = parsed;
		lightness.input.value = String(parsed.l);
		saturation.input.value = String(parsed.s);
		hue.input.value = String(parsed.h);
		render();
	};

	setColor(plugin.toolSettings[getCurrentTool()].color);

	return {
		panelEl,
		swatchEl,
		lightnessInput: lightness.input,
		saturationInput: saturation.input,
		hueInput: hue.input,
		lightnessValueEl: lightness.valueEl,
		saturationValueEl: saturation.valueEl,
		hueValueEl: hue.valueEl,
		setColor,
	};
}

function setSwatch(swatchEl: HTMLElement, hex: string): void {
	swatchEl.style.setProperty('background-color', hex);
}

function rampStops(sample: (t: number) => string): string {
	const stops: string[] = [];
	for (let i = 0; i < RAMP_STOPS; i++) {
		stops.push(sample(i / (RAMP_STOPS - 1)));
	}
	return `linear-gradient(to top, ${stops.join(', ')})`;
}

function setRamp(input: HTMLInputElement, gradient: string): void {
	input.style.setProperty('--okhsl-track-gradient', gradient);
}

export function syncOkhslColorPicker(elements: OkhslColorPickerElements, hex: string, displayTool: ToolName): void {
	const disabled = displayTool === 'eraser';
	for (const input of [elements.lightnessInput, elements.saturationInput, elements.hueInput]) {
		input.disabled = disabled;
		input.title = disabled ? 'Not used by the eraser' : '';
	}

	if (!disabled) {
		elements.setColor(hex);
	}
}
