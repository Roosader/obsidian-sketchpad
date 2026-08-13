import { setTooltip, setIcon } from 'obsidian';
import type SketchpadPlugin from '../main';
import { clonePressureCurve, DEFAULT_PRESSURE_CURVE, type PressureCurve } from '../technical/pressure-curve';
import { TOOL_TIP_MAX_SIZE } from '../utilities/constants';
import type { ToolSettings } from '../utilities/tool-settings';
import type { ToolName } from '../utilities/types';
import { buildPressureCurveEditor, type PressureCurveEditor } from './pressure-curve-editor';
import { buildOkhslColorPicker, syncOkhslColorPicker, type OkhslColorPickerElements } from './okhsl-color-picker';
import { wirePanelDrag } from './panel-drag';

export interface ToolSettingsSidebarElements {
	sizeInput: HTMLInputElement;
	sizeValueEl: HTMLElement;
	opacityInput: HTMLInputElement;
	opacityValueEl: HTMLElement;
	hardnessInput: HTMLInputElement;
	hardnessValueEl: HTMLElement;
	colorInput: HTMLInputElement;
	blendModeInput: HTMLSelectElement;
	pressureSizeInput: HTMLInputElement;
	pressureOpacityInput: HTMLInputElement;
	minimumSizeInput: HTMLInputElement;
	pressureSizeCurveEditor: PressureCurveEditor;
	pressureOpacityCurveEditor: PressureCurveEditor;
	pressureSizeCurveResetButton: HTMLButtonElement;
	pressureOpacityCurveResetButton: HTMLButtonElement;
	pressureReadoutEl: HTMLElement;
	okhslPicker: OkhslColorPickerElements;
}

export function buildToolSettingsSidebar(
	container: HTMLElement,
	plugin: SketchpadPlugin,
	getCurrentTool: () => ToolName,
	onSizeChange?: () => void,
): ToolSettingsSidebarElements {
	container.empty();

	const verticalControls = container.createDiv({ cls: 'sketchpad-vertical-toolbar' });

	let okhslPicker: OkhslColorPickerElements | undefined;

	const colorInput = verticalControls.createEl('input', { cls: 'sketchpad-color-picker' });
	colorInput.setAttribute('type', 'color');
	setTooltip(colorInput, 'Tool color');
	colorInput.addEventListener('input', () => {
		plugin.toolSettings[getCurrentTool()].color = colorInput.value;
		okhslPicker?.setColor(colorInput.value);
	});
	colorInput.addEventListener('change', () => void plugin.saveToolSettings());

		const sizeValueEl = verticalControls.createSpan({ cls: 'sketchpad-tool-setting-value' });
	sizeValueEl.classList.add('sketchpad-vertical-toolbar-label');
	setTooltip(sizeValueEl, 'Tool size');
	const sizeInput = verticalControls.createEl('input');
	sizeInput.setAttribute('type', 'range');
	sizeInput.classList.add('sketchpad-vertical-slider');
	sizeInput.setAttribute('min', '0');
	sizeInput.setAttribute('max', '100');

	const initialSize = sliderToSize(Number(sizeInput.value));
	sizeValueEl.setText(`${Math.round(initialSize)}px`);
	sizeInput.addEventListener('input', () => {
		const size = sliderToSize(Number(sizeInput.value));
		plugin.toolSettings[getCurrentTool()].size = size;
		sizeValueEl.setText(`${Math.round(size)}px`);
		onSizeChange?.();
	});
	sizeInput.addEventListener('change', () => void plugin.saveToolSettings());

		const opacityValueEl = verticalControls.createSpan({ cls: 'sketchpad-tool-setting-value' });
	opacityValueEl.classList.add('sketchpad-vertical-toolbar-label');
	setTooltip(opacityValueEl, 'Tool opacity');
	const opacityInput = verticalControls.createEl('input');
	opacityInput.classList.add('sketchpad-vertical-slider');
	opacityInput.setAttribute('type', 'range');
	opacityInput.setAttribute('min', '1');
	opacityInput.setAttribute('max', '100');

	opacityValueEl.setText(`${opacityInput.value}%`);
	opacityInput.addEventListener('input', () => {
		plugin.toolSettings[getCurrentTool()].opacity = Number(opacityInput.value);
		opacityValueEl.setText(`${opacityInput.value}%`);
	});
	opacityInput.addEventListener('change', () => void plugin.saveToolSettings());

	// OKHSL color picker panel 
	okhslPicker = buildOkhslColorPicker(container, plugin, getCurrentTool, (hex) => {
		colorInput.value = hex;
	});

	// Tool settings panel
	const toolSettingsEl = container.createDiv({ cls: 'sketchpad-tool-settings' });

	toolSettingsEl.createDiv({ text: 'Tool settings', cls: 'sketchpad-tool-sidebar-title' });


	const sliderRow = (label: string): HTMLDivElement => {
		const row = toolSettingsEl.createDiv({ cls: 'sketchpad-setting-row' });
		row.createEl('label', { text: label });
		return row;
	};

	const hardnessRow = sliderRow('Hardness');
	const hardnessInput = hardnessRow.createEl('input');
	hardnessInput.setAttribute('type', 'range');
	hardnessInput.classList.add('sketchpad-horizontal-slider');
	hardnessInput.setAttribute('min', '0');
	hardnessInput.setAttribute('max', '100');
		const hardnessValueEl = hardnessRow.createSpan({ cls: 'sketchpad-tool-setting-value' });
	hardnessValueEl.setText(`${hardnessInput.value}%`);
	hardnessInput.addEventListener('input', () => {
		plugin.toolSettings[getCurrentTool()].hardness = Number(hardnessInput.value);
		const percent = Math.round(Number(hardnessInput.value));
		hardnessInput.style.setProperty('--percent', `${percent}%`);
		hardnessValueEl.setText(`${percent}%`);
	});
	hardnessInput.addEventListener('change', () => void plugin.saveToolSettings());


	const blendRow = sliderRow('Blend mode');
	const blendModeInput = blendRow.createEl('select');
	blendModeInput.classList.add('sketchpad-dropdown');
	const normalBlendOption = blendModeInput.createEl('option', { text: 'Normal' });
	normalBlendOption.setAttribute('value', 'normal');
	const replaceAlphaOption = blendModeInput.createEl('option', { text: 'Replace alpha' });
	replaceAlphaOption.setAttribute('value', 'replace-alpha');
	const compareDensityOption = blendModeInput.createEl('option', { text: ' Compare density ' });
	compareDensityOption.setAttribute('value', 'compare-density');
	blendModeInput.addEventListener('change', () => {
		switch (blendModeInput.value) {
			case 'normal':
				plugin.toolSettings[getCurrentTool()].blendMode = 'normal';
				break;
			case 'replace-alpha':
				plugin.toolSettings[getCurrentTool()].blendMode = 'replace-alpha';
				break;
			case 'compare-density':
				plugin.toolSettings[getCurrentTool()].blendMode = 'compare-density';
				break;
		}
		void plugin.saveToolSettings();
	});

	const pressureSizeSection = toolSettingsEl.createDiv({ cls: 'sketchpad-pressure-section' });
	const pressureSizeTitle = pressureSizeSection.createDiv({ cls: 'sketchpad-pressure-title' });
		pressureSizeTitle.createEl('label', { text: 'Pressure size' });
	const pressureSizeInput = pressureSizeTitle.createEl('input');
	pressureSizeInput.setAttribute('type', 'checkbox');
	pressureSizeInput.title = 'Enable pressure-driven tool size';
	pressureSizeInput.addEventListener('change', () => {
		plugin.toolSettings[getCurrentTool()].pressureSize = pressureSizeInput.checked;
		void plugin.saveToolSettings();
	});
	const pressureSizeCurveResetButton = pressureSizeTitle.createEl('button');
	pressureSizeCurveResetButton.classList.add('sketchpad-pressure-reset-button');
	setIcon(pressureSizeCurveResetButton, 'reset');
	setTooltip(pressureSizeCurveResetButton, 'Reset pressure size curve');
	pressureSizeCurveResetButton.addEventListener('click', () => {
		const nextCurve = clonePressureCurve(DEFAULT_PRESSURE_CURVE);
		plugin.toolSettings[getCurrentTool()].pressureSizeCurve = nextCurve;
		pressureSizeCurveEditor.setCurve(nextCurve);
		void plugin.saveToolSettings();
	});
	const pressureSizeCurveEditor = buildPressureCurveEditor(pressureSizeSection, DEFAULT_PRESSURE_CURVE, (curve: PressureCurve) => {
		plugin.toolSettings[getCurrentTool()].pressureSizeCurve = curve;
	});
	pressureSizeCurveEditor.canvas.addEventListener('pointerup', () => void plugin.saveToolSettings());

	const minimumSizeRow = toolSettingsEl.createDiv({ cls: 'sketchpad-setting-row' });
	minimumSizeRow.createEl('label', { text: 'Minimum size 1 pixel' });
	setTooltip(minimumSizeRow, 'Enable to keep the tool size to at least 1 pixel');
	const minimumSizeInput = minimumSizeRow.createEl('input');
	minimumSizeInput.setAttribute('type', 'checkbox');
	minimumSizeInput.addEventListener('change', () => {
		plugin.toolSettings[getCurrentTool()].minimumSize = minimumSizeInput.checked;
		void plugin.saveToolSettings();
	});

	const pressureOpacitySection = toolSettingsEl.createDiv({ cls: 'sketchpad-pressure-section' });
	const pressureOpacityTitle = pressureOpacitySection.createDiv({ cls: 'sketchpad-pressure-title' });
		pressureOpacityTitle.createEl('label', { text: 'Pressure opacity' });
	const pressureOpacityInput = pressureOpacityTitle.createEl('input');
	pressureOpacityInput.setAttribute('type', 'checkbox');
	pressureOpacityInput.title = 'Enable pressure-driven tool opacity';
	pressureOpacityInput.addEventListener('change', () => {
		plugin.toolSettings[getCurrentTool()].pressureOpacity = pressureOpacityInput.checked;
		void plugin.saveToolSettings();
	});
	const pressureOpacityCurveResetButton = pressureOpacityTitle.createEl('button');
	pressureOpacityCurveResetButton.classList.add('sketchpad-pressure-reset-button');
	setIcon(pressureOpacityCurveResetButton, 'reset');
	setTooltip(pressureOpacityCurveResetButton, 'Reset pressure opacity curve');
	pressureOpacityCurveResetButton.addEventListener('click', () => {
		const nextCurve = clonePressureCurve(DEFAULT_PRESSURE_CURVE);
		plugin.toolSettings[getCurrentTool()].pressureOpacityCurve = nextCurve;
		pressureOpacityCurveEditor.setCurve(nextCurve);
		void plugin.saveToolSettings();
	});
	const pressureOpacityCurveEditor = buildPressureCurveEditor(pressureOpacitySection, DEFAULT_PRESSURE_CURVE, (curve: PressureCurve) => {
		plugin.toolSettings[getCurrentTool()].pressureOpacityCurve = curve;
	});
	pressureOpacityCurveEditor.canvas.addEventListener('pointerup', () => void plugin.saveToolSettings());

	const pressureReadoutEl = toolSettingsEl.createDiv({ cls: 'sketchpad-pressure-readout' });
	pressureReadoutEl.setText('Pointer: - · raw: - · used: -');

	const okhslPickerButton = verticalControls.createEl('button', { cls: 'sketchpad-expand-collapse-button' });
	verticalControls.insertBefore(okhslPickerButton, verticalControls.firstChild);
	setIcon(okhslPickerButton, 'palette');
	setTooltip(okhslPickerButton, 'Toggle color picker panel');
	okhslPickerButton.classList.add('sketchpad-okhsl-expand-button');

	const setOkhslPickerVisible = (visible: boolean): void => {
		if (!okhslPicker) {
			return;
		}
		okhslPicker.panelEl.classList.toggle('sketchpad-collapsed', !visible);
		okhslPickerButton.classList.toggle('is-active', visible);
	};

	okhslPickerButton.addEventListener('click', () => {
		const visible = okhslPicker?.panelEl.classList.contains('sketchpad-collapsed') ?? true;
		setOkhslPickerVisible(visible);
		plugin.okhslPickerCollapsed = !visible;
		void plugin.saveToolSettings();
	});

	const toolSettingsPanelButton = verticalControls.createEl('button', { cls: 'sketchpad-expand-collapse-button' });
	verticalControls.insertBefore(toolSettingsPanelButton, okhslPickerButton.nextSibling);
	setIcon(toolSettingsPanelButton, 'gear');
	setTooltip(toolSettingsPanelButton, 'Toggle tool settings panel');

	const setToolSettingsVisible = (visible: boolean): void => {
		toolSettingsEl.classList.toggle('sketchpad-collapsed', !visible);
		toolSettingsPanelButton.classList.toggle('is-active', visible);
	};
	
	toolSettingsPanelButton.addEventListener('click', () => {
		const visible = toolSettingsEl.classList.contains('sketchpad-collapsed');
		setToolSettingsVisible(visible);
		plugin.toolSettingsCollapsed = !visible;
		void plugin.saveToolSettings();
	});

	// apply the persisted collapsed state the panels
	setOkhslPickerVisible(!plugin.okhslPickerCollapsed);
	setToolSettingsVisible(!plugin.toolSettingsCollapsed);

	// add drag handle in minimal mode
	if (plugin.minimalUI) {
		const panelMoveButton = verticalControls.createEl('button', { cls: 'sketchpad-panel-move-button' });
		setIcon(panelMoveButton, 'move');
		setTooltip(panelMoveButton, 'Drag to move the right sidebar');
		verticalControls.insertBefore(panelMoveButton, verticalControls.lastChild);
		const shell = container.parentElement;
		if (shell) {
			wirePanelDrag(panelMoveButton, container, shell, (position) => {
				plugin.rightSidebarPos = position;
				void plugin.saveToolSettings();
			}, 'right');
		}
	}

	return {
		sizeInput,
		sizeValueEl,
		opacityInput,
		opacityValueEl,
		hardnessInput,
		hardnessValueEl,
		colorInput,
		blendModeInput,
		pressureSizeInput,
		pressureOpacityInput,
		minimumSizeInput,
		pressureSizeCurveEditor,
		pressureOpacityCurveEditor,
		pressureSizeCurveResetButton,
		pressureOpacityCurveResetButton,
		pressureReadoutEl,
		okhslPicker,
	};
}

function sizeToSlider(size: number): number {
	const t = Math.sqrt((size - 1) / (TOOL_TIP_MAX_SIZE - 1));
	return Math.round(t * 100);
}
function sliderToSize(sizeValue: number): number {
	const t = sizeValue / 100;
	const size = 1 + (TOOL_TIP_MAX_SIZE - 1) * t*t; // quadratic scaling for better control at small sizes
	return Math.round(size);
}


export function syncToolSettingsSidebar(elements: ToolSettingsSidebarElements, settings: ToolSettings, displayTool: ToolName): void {
	elements.sizeInput.value = String(sizeToSlider(settings.size));
	elements.sizeValueEl.setText(`${settings.size}px`);
	elements.opacityInput.value = String(settings.opacity);
	elements.opacityValueEl.setText(`${settings.opacity}%`);
	
	elements.hardnessInput.value = String(settings.hardness);
	const percent = Math.round(Number(elements.hardnessInput.value));
	elements.hardnessInput.style.setProperty('--percent', `${percent}%`);
	elements.hardnessValueEl.setText(`${percent}%`);

	const isEraser = displayTool === 'eraser';

	elements.colorInput.disabled = isEraser;
	elements.colorInput.title = isEraser ? 'Not used by the eraser' : '';
	if (!isEraser) {
		elements.colorInput.value = settings.color;
	}
	syncOkhslColorPicker(elements.okhslPicker, settings.color, displayTool);
	elements.blendModeInput.value = settings.blendMode;
	elements.blendModeInput.disabled = isEraser;
	elements.blendModeInput.title = isEraser ? 'Not used by the eraser' : '';
	elements.pressureSizeInput.checked = settings.pressureSize;
	elements.pressureOpacityInput.checked = settings.pressureOpacity;
	elements.minimumSizeInput.checked = settings.minimumSize;
	elements.pressureSizeCurveEditor.setCurve(settings.pressureSizeCurve);
	elements.pressureOpacityCurveEditor.setCurve(settings.pressureOpacityCurve);
}
