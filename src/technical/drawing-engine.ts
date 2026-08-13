import type { LayerName, OraDocument, OraLayer, Point, SelectionBounds, SelectionTransform, StrokeParams, ToolName } from '../utilities/types';

export interface DrawingEngine {
	isDrawing(): boolean;

	setDocument(documentState: OraDocument, onLayerReady: () => void): void;

	setPaperColor(color: string): void;

	appendPoint(point: Point): void;
	beginStroke(layer: OraLayer, point: Point, stroke: StrokeParams & { tool: ToolName }): void;
	finishStroke(layer: OraLayer): void;

	// renders the flattened document
	renderBase(): void;

	// renders the in-progress drawing stroke
	drawPreview(layer: OraLayer, fallbackColor: string): void;

	// lasso select/transform tool support
	hasSelection(): boolean;
	getSelectionBounds(): SelectionBounds | null;
	beginSelection(layer: OraLayer, polygon: Point[]): void;
	drawSelectionPreview(layer: OraLayer, transform: SelectionTransform): void;
	commitSelection(layer: OraLayer, transform: SelectionTransform): void;
	cancelSelection(layer: OraLayer): void;

	// reads every layer's current pixels back into a plain <canvas>, for .ora export 
	snapshotLayerCanvases(): Promise<Map<LayerName, HTMLCanvasElement>>;

	sampleFlattenedPixel(x: number, y: number): { r: number; g: number; b: number; a: number } | null;

	canUndo(): boolean;
	canRedo(): boolean;
	undo(): void;
	redo(): void;

	destroy(): void;
}
