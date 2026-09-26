import { unzipSync } from 'fflate';
import { cloneDocument, DEFAULT_DOCUMENT, uniquifyLayerName } from '../technical/sketchpad-document';
import type { BlendMode, LayerName, OraDocument, OraLayer } from '../utilities/types';

interface OraLayerMetadata {
	name: string;
	opacity: number;
	blendMode: BlendMode; //layer blend mode derived from the composite-op attribute in stack.xml
	visible: boolean;
	x: number; //(px) layer offset relative to the document's origin (top-left)
	y: number;
	src?: string; // png image source for the layer's raster
}

export function parseOraArchive(binary: ArrayBuffer | Uint8Array): { document: OraDocument } | null {
	const archive = unzipSync(binary instanceof ArrayBuffer ? new Uint8Array(binary) : binary);
	const stackXml = archive['stack.xml'];
	if (!stackXml) {
		return null;
	}

	const document = cloneDocument(DEFAULT_DOCUMENT);
	const text = new TextDecoder().decode(stackXml);
	const width = parseXmlAttribute(text, 'image', 'w');
	const height = parseXmlAttribute(text, 'image', 'h');
	if (width) {
		document.width = width;
	}
	if (height) {
		document.height = height;
	}

	const parsedLayers = parseLayers(text, archive);
	if (parsedLayers.length > 0) {
		// stack.xml lists layers top-first, document stores them bottom-first
		const bottomFirst = [...parsedLayers].reverse();
		const paper = bottomFirst.find((layer) => layer.name === 'Paper');
		const rest = bottomFirst.filter((layer) => layer.name !== 'Paper');
		document.layers = paper ? [paper, ...rest] : bottomFirst;
	}

	return { document };
}

function parseXmlAttribute(xml: string, tagName: string, attributeName: string): number | undefined {
	const tagMatch = xml.match(new RegExp(`<${tagName}[^>]*>`));
	if (!tagMatch) {
		return undefined;
	}
	const attributeMatch = tagMatch[0].match(new RegExp(`${attributeName}="([0-9.]+)"`));
	return attributeMatch && attributeMatch[1] ? Number.parseFloat(attributeMatch[1]) : undefined;
}

// parses the stack.xml layer tags in document order (top-first) into an ordered array of layers, matching by name 
function parseLayers(xml: string, archive: Record<string, Uint8Array>): OraLayer[] {
	const layerMatches = Array.from(xml.matchAll(/<layer\b([^>]*)>/g));
	const layers: OraLayer[] = [];
	const usedNames = new Set<string>();
	for (const match of layerMatches) {
		const metadata = parseLayerMetadata(match[1] ?? '');
		const name = uniquifyLayerName(normalizeLayerName(metadata.name), usedNames);
		usedNames.add(name);
		const rasterBytes = metadata.src ? archive[metadata.src] : undefined;
		layers.push({
			name,
			opacity: metadata.opacity,
			blendMode: metadata.blendMode,
			visible: metadata.visible,
			x: metadata.x,
			y: metadata.y,
			baseImageDataUrl: rasterBytes ? bytesToDataUrl(rasterBytes, 'image/png') : undefined,
		});
	}
	return layers;
}


function normalizeLayerName(name: string): LayerName {
	const normalized = name.trim();
	if (normalized === 'Sketch') {
		return 'Sketch';
	}
	if (normalized === 'Ink') {
		return 'Ink';
	}
	if (normalized === 'Paint') {
		return 'Paint';
	}
	if (normalized === 'Paper') {
		return 'Paper';
	}
	// preserve extra/custom layer names instead of collapsing them into Paper
	return normalized || 'Paper';
}

function parseLayerMetadata(attributes: string): OraLayerMetadata {
	const entries = Array.from(attributes.matchAll(/([A-Za-z0-9:-]+)="([^"]*)"/g));
	const values = Object.fromEntries(
		entries.map((entry): [string, string] => [entry[1] ?? '', entry[2] ?? '']),
	);
	const name = values.name || values.src || 'Layer';
	const opacityValue = values.opacity ? Number.parseFloat(values.opacity) : 1;
	const opacity = opacityValue > 1 ? opacityValue : opacityValue * 100;
	const compositeOp = values['composite-op'];
	const blendMode: BlendMode = compositeOp === 'svg:multiply' || compositeOp === 'multiply' ? 'multiply' : 'normal';
	const parseOffset = (raw: string | undefined): number => {
		const parsed = raw === undefined ? Number.NaN : Number.parseFloat(raw);
		return Number.isFinite(parsed) ? parsed : 0;
	};
	return {
		name,
		opacity: Number.isFinite(opacity) ? opacity : 100,
		blendMode,
		visible: values.visibility !== 'hidden',
		x: parseOffset(values.x),
		y: parseOffset(values.y),
		src: values.src,
	};
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return `data:${mimeType};base64,${btoa(binary)}`;
}

export function getMergedImageDataUrl(binary: ArrayBuffer | Uint8Array): string | null {
	const archive = unzipSync(binary instanceof ArrayBuffer ? new Uint8Array(binary) : binary);
	const merged = archive['mergedimage.png'];
	if (!merged) {
		return null;
	}
	return bytesToDataUrl(merged, 'image/png');
}

export function getThumbnailDataUrl(binary: ArrayBuffer | Uint8Array): string | null {
	const archive = unzipSync(binary instanceof ArrayBuffer ? new Uint8Array(binary) : binary);
	const thumbnail = archive['Thumbnails/thumbnail.png'] ?? archive['thumbnail.png'];
	if (!thumbnail) {
		return null;
	}
	return bytesToDataUrl(thumbnail, 'image/png');
}
