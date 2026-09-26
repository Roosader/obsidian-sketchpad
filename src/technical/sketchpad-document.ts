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

	const byName = new Map<string, Partial<OraLayer>>();
	const order: string[] = [];
	const usedNames = new Set<string>();
	for (const layer of inputLayers) {
		const rawName = layer && typeof layer.name === 'string' ? layer.name : undefined;
		const name = rawName?.trim();
		if (!name) {
			continue;
		}
		const unique = uniquifyLayerName(name, usedNames);
		usedNames.add(unique);
		byName.set(unique, layer);
		order.push(unique);
	}
	// Append any fixed layers missing from the input, in the default order.
	for (const name of FIXED_LAYER_NAMES) {
		if (!byName.has(name)) {
			order.push(name);
		}
	}

	// Paper stays at the bottom of the stack; every other layer (extra
	// layers included) keeps its relative order.
	const paper = normalizeLayer(byName.get('Paper'), 'Paper');
	const nonPaper = order
		.filter((entry) => entry !== 'Paper')
			.map((name) => normalizeLayer(byName.get(name), name));

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


// true for the four built-in layers (Paper/Sketch/Ink/Paint)
export function isFixedLayerName(name: string): boolean {
	return (FIXED_LAYER_NAMES as string[]).includes(name);
}

// returns the name for the next extra layer: the first unused number in
// Extra 1, Extra 2, ... (fills gaps instead of always appending after the max)
export function nextExtraLayerName(layers: OraLayer[]): LayerName {
	const used = new Set<number>();
	const pattern = /^Extra (\d+)$/;
	for (const layer of layers) {
		const match = pattern.exec(layer.name);
		if (match) {
			used.add(Number.parseInt(match[1] ?? '0', 10));
		}
	}
	let candidate = 1;
	while (used.has(candidate)) {
		candidate += 1;
	}
	return `Extra ${candidate}`;
}

// number of non-fixed (extra) layers in the document
export function countExtraLayers(layers: OraLayer[]): number {
	return layers.filter((layer) => !isFixedLayerName(layer.name)).length;
}

// returns `name`, or `name (2)`, `name (3)`, ... until unique against the
// given set of taken names. Used to preserve duplicate-named layers on
// import instead of dropping their content.
export function uniquifyLayerName(name: string, used: Set<string>): LayerName {
	if (!used.has(name)) {
		return name;
	}
	let counter = 2;
	while (used.has(`${name} (${counter})`)) {
		counter += 1;
	}
	return `${name} (${counter})`;
}