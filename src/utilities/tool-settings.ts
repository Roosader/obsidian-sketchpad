import { clampPressureCurve, clonePressureCurve, DEFAULT_PRESSURE_CURVE } from '../technical/pressure-curve';
import type { StrokeParams, ToolName } from './types';

export type ToolSettings = StrokeParams;

export type ToolSettingsMap = Record<ToolName, ToolSettings>;

export const DEFAULT_TOOL_SETTINGS: ToolSettingsMap = {
	pencil: {
		size: 2,
		opacity: 100,
		color: '#222222',
		blendMode: 'normal',
		hardness: 100,
		minimumSize: false,
		pressureSize: false,
		pressureOpacity: false,
		pressureSizeCurve: clonePressureCurve(DEFAULT_PRESSURE_CURVE),
		pressureOpacityCurve: clonePressureCurve(DEFAULT_PRESSURE_CURVE),
	},
	pen: {
		size: 3,
		opacity: 100,
		color: '#111111',
		blendMode: 'normal',
		hardness: 100,
		minimumSize: false,
		pressureSize: false,
		pressureOpacity: false,
		pressureSizeCurve: clonePressureCurve(DEFAULT_PRESSURE_CURVE),
		pressureOpacityCurve: clonePressureCurve(DEFAULT_PRESSURE_CURVE),
	},
	brush: {
		size: 5,
		opacity: 100,
		color: '#3d6bff',
		blendMode: 'normal',
		hardness: 70,
		minimumSize: false,
		pressureSize: false,
		pressureOpacity: false,
		pressureSizeCurve: clonePressureCurve(DEFAULT_PRESSURE_CURVE),
		pressureOpacityCurve: clonePressureCurve(DEFAULT_PRESSURE_CURVE),
	},
	eraser: {
		size: 6,
		opacity: 100,
		color: '#ffffff',
		blendMode: 'normal',
		hardness: 100,
		minimumSize: false,
		pressureSize: false,
		pressureOpacity: false,
		pressureSizeCurve: clonePressureCurve(DEFAULT_PRESSURE_CURVE),
		pressureOpacityCurve: clonePressureCurve(DEFAULT_PRESSURE_CURVE),
	},
	marker: {
		size: 12,
		opacity: 70,
		color: '#ffd43b',
		blendMode: 'normal',
		hardness: 100,
		minimumSize: false,
		pressureSize: false,
		pressureOpacity: false,
		pressureSizeCurve: clonePressureCurve(DEFAULT_PRESSURE_CURVE),
		pressureOpacityCurve: clonePressureCurve(DEFAULT_PRESSURE_CURVE),
	},
};

// retrieve tool settings from saved data
export function cloneToolSettings(saved?: Partial<Record<ToolName, Partial<ToolSettings>>>): ToolSettingsMap {
	const result = {} as ToolSettingsMap;
	for (const tool of Object.keys(DEFAULT_TOOL_SETTINGS) as ToolName[]) {
		const defaults = DEFAULT_TOOL_SETTINGS[tool];
		const override = saved?.[tool];
		const sizeCurveOverride = override?.pressureSizeCurve;
		const opacityCurveOverride = override?.pressureOpacityCurve;
		result[tool] = {
			size: typeof override?.size === 'number' ? override.size : defaults.size,
			opacity: typeof override?.opacity === 'number' ? override.opacity : defaults.opacity,
			color: typeof override?.color === 'string' ? override.color : defaults.color,
			blendMode: override?.blendMode ?? defaults.blendMode,
			hardness: typeof override?.hardness === 'number' ? override.hardness : defaults.hardness,
			pressureSize: typeof override?.pressureSize === 'boolean' ? override.pressureSize : defaults.pressureSize,
			pressureOpacity: typeof override?.pressureOpacity === 'boolean' ? override.pressureOpacity : defaults.pressureOpacity,
			minimumSize: typeof override?.minimumSize === 'boolean' ? override.minimumSize : defaults.minimumSize,
			pressureSizeCurve: clampPressureCurve(sizeCurveOverride ?? defaults.pressureSizeCurve),
			pressureOpacityCurve: clampPressureCurve(opacityCurveOverride ?? defaults.pressureOpacityCurve),
		};
	}
	return result;
}

