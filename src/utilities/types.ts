import type { PressureCurve } from '../technical/pressure-curve';

export type ToolName = 'pencil' | 'pen' | 'brush' | 'eraser';
export type ViewTool = ToolName | 'eyedropper' | 'hand' | 'lasso' | 'zoom-in' | 'zoom-out' | 'rotate';
export type RotateAction = 'rotate-ccw' | 'rotate-cw';
export type SizeAction = 'size-increase' | 'size-decrease';
export type LayerName = 'Paper' | 'Sketch' | 'Ink' | 'Paint';
export type BlendMode = 'normal' | 'multiply';
export type ToolBlendMode = 'normal' | 'replace-alpha' | 'compare-density';

export interface Point {
	x: number;
	y: number;
	pressure?: number; // 0-1 for pen input, treated as 1 for mouse and touch
}

export interface StrokeParams {
	size: number;
	opacity: number;
	color: string;
	blendMode: ToolBlendMode;
	hardness: number; //0-100, 100 = no antialiasing

	pressureSize: boolean;
	pressureOpacity: boolean;
	pressureSizeCurve: PressureCurve;
	pressureOpacityCurve: PressureCurve;

	minimumSize: boolean;
}

export interface Stroke extends StrokeParams {
	tool: ToolName;
	points: Point[];
}

export interface OraLayer {
	name: LayerName;
	opacity: number;
	blendMode: BlendMode;
	visible: boolean;

	//layer offset value within the document in pixels
	x: number; 
	y: number;

	baseImageDataUrl?: string;
}

export interface OraDocument {
	version: number;
	width: number;
	height: number;
	paperColor: string;
	layers: OraLayer[];
}

// lasso selection's bounding box
export interface SelectionBounds {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface SelectionTransform {
	translateX: number;
	translateY: number;
	rotation: number;
	scaleX: number;
	scaleY: number;
}

