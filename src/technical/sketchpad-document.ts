import { DEFAULT_IMAGE_HEIGHT, DEFAULT_IMAGE_WIDTH, DEFAULT_PAPER_COLOR, DEFAULT_LAYER_ORDER } from '../utilities/constants';
import type { BlendMode, LayerName, OraDocument, OraLayer } from '../utilities/types';

export const DEFAULT_DOCUMENT: OraDocument = {
	version: 1,
	width: DEFAULT_IMAGE_WIDTH,
	height: DEFAULT_IMAGE_HEIGHT,
	paperColor: DEFAULT_PAPER_COLOR,
	layers: [
		{ name: 'Paper', opacity: 100, blendMode: 'normal', visible: true, x: 0, y: 0 },
		{ name: 'Sketch', opacity: 100, blendMode: 'normal', visible: true, x: 0, y: 0 },
		{ name: 'Ink', opacity: 100, blendMode: 'normal', visible: true, x: 0, y: 0 },
		{ name: 'Paint', opacity: 100, blendMode: 'normal', visible: true, x: 0, y: 0 },
	],
};

export function cloneDocument(document: OraDocument): OraDocument {
	return structuredClone(document);
}

const FIXED_LAYER_NAMES = DEFAULT_LAYER_ORDER;

export function normalizeDocument(input?: Partial<OraDocument> | null): OraDocument {
	const inputLayers = Array.isArray(input?.layers) ? input.layers : [];

	const normalizeLayer = (layer: Partial<OraLayer> | undefined, name: LayerName): OraLayer => {
		const blendMode: BlendMode = layer?.blendMode === 'multiply' ? 'multiply' : 'normal';
		return {
			name,
			opacity: typeof layer?.opacity === 'number' ? layer.opacity : 100,
			blendMode,
			visible: typeof layer?.visible === 'boolean' ? layer.visible : true,
			x: typeof layer?.x === 'number' ? layer.x : 0,
			y: typeof layer?.y === 'number' ? layer.y : 0,
			baseImageDataUrl: typeof layer?.baseImageDataUrl === 'string' ? layer.baseImageDataUrl : undefined,
		};
	};

	const byName = new Map<LayerName, Partial<OraLayer>>();
	const ordered: LayerName[] = [];
	for (const layer of inputLayers) {
		const name = layer && typeof layer.name === 'string' ? layer.name : undefined;
		if (!name || !FIXED_LAYER_NAMES.includes(name) || byName.has(name)) {
			continue;
		}
		byName.set(name, layer);
		if (name !== 'Paper') {
			ordered.push(name);
		}
	}
	// Append any fixed layers missing from the input, in the default order.
	for (const name of FIXED_LAYER_NAMES) {
		if (name !== 'Paper' && !byName.has(name)) {
			ordered.push(name);
		}
	}

	const paper = normalizeLayer(byName.get('Paper'), 'Paper');
	const nonPaper = ordered.map((name) => normalizeLayer(byName.get(name), name));

	return {
		version: 1,
		width: typeof input?.width === 'number' ? input.width : DEFAULT_DOCUMENT.width,
		height: typeof input?.height === 'number' ? input.height : DEFAULT_DOCUMENT.height,
		paperColor: typeof input?.paperColor === 'string' ? input.paperColor : DEFAULT_DOCUMENT.paperColor,
		layers: [paper, ...nonPaper],
	};
}

// moves a non-paper layer one slot up (1) or down (-1)
export function reorderLayer(layers: OraLayer[], layerName: LayerName, direction: -1 | 1): boolean {
	const from = layers.findIndex((layer) => layer.name === layerName);
	if (from <= 0) {
		return false; // paper (or an unknown layer) is never reordered.
	}
	const to = from + direction;
	if (to <= 0 || to >= layers.length) {
		return false; // off the bottom (Paper's slot) or past the top.
	}
	const [moving] = layers.splice(from, 1);
	if (!moving) {
		return false;
	}
	layers.splice(to, 0, moving);
	return true;
}

export function applyDefaultLayerOrder(layers: OraLayer[], order: LayerName[]): OraLayer[] {
	const byName = new Map<LayerName, OraLayer>();
	for (const layer of layers) {
		byName.set(layer.name, layer);
	}
	const result: OraLayer[] = [];
	const used = new Set<LayerName>();
	for (const name of order) {
		const layer = byName.get(name);
		if (layer && !used.has(name)) {
			result.push(layer);
			used.add(name);
		}
	}
	for (const name of FIXED_LAYER_NAMES) {
		const layer = byName.get(name);
		if (layer && !used.has(name)) {
			result.push(layer);
			used.add(name);
		}
	}
	// keep Paper at the bottom
	const paper = byName.get('Paper');
	if (paper) {
		return [paper, ...result.filter((layer) => layer.name !== 'Paper')];
	}
	return result;
}
