import { strToU8, zipSync } from 'fflate';
import { getLayerFallbackColor } from '../utilities/layer-colors';
import {IMAGE_DPI,THUMBNAIL_MAX_DIMENSION} from '../utilities/constants';
import type { LayerName, OraDocument, OraLayer } from '../utilities/types';

export function buildOraArchive(document: OraDocument, layerCanvases?: Map<LayerName, HTMLCanvasElement>): ArrayBuffer {
	const entries: Record<string, Uint8Array> = {};
	entries['mimetype'] = strToU8('image/openraster');
	entries['stack.xml'] = strToU8(buildStackXml(document));
	const canvases = document.layers.map((layer) => layerCanvases?.get(layer.name) ?? createBlankLayerCanvas(document, layer));
	const mergedCanvas = renderMergedCanvas(document, canvases);
	entries['mergedimage.png'] = dataUrlToBytes(mergedCanvas.toDataURL('image/png'));
	entries['Thumbnails/thumbnail.png'] = dataUrlToBytes(renderThumbnailDataUrl(mergedCanvas));
	const orderedCanvases = [...canvases].reverse();
	for (const [index, canvas] of orderedCanvases.entries()) {
		entries[`data/layer${index}.png`] = dataUrlToBytes(canvas.toDataURL('image/png'));
	}
	const archive = zipSync(entries, { level: 0 });
	return archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength);
}

// composites every visible layer into a single flattened raster
export function buildMergedPngBytes(document: OraDocument, layerCanvases: Map<LayerName, HTMLCanvasElement>): ArrayBuffer {
	const canvases = document.layers.map((layer) => layerCanvases.get(layer.name) ?? createBlankLayerCanvas(document, layer));
	const mergedCanvas = renderMergedCanvas(document, canvases);
	const bytes = dataUrlToBytes(mergedCanvas.toDataURL('image/png'));
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function buildStackXml(document: OraDocument): string {
	const orderedLayers = [...document.layers].reverse();
	// layer crop offset in stack.xml must always be 0 since every layer this plugin writes is full-canvas
	const layerEntries = orderedLayers
		.map((layer, index) => `  <layer src="data/layer${index}.png" visibility="${layer.visible ? 'visible' : 'hidden'}" name="${layer.name}" opacity="${layer.opacity / 100}" x="0" y="0" composite-op="${layer.blendMode === 'multiply' ? 'svg:multiply' : 'svg:src-over'}"${index === 0 ? ' selected="true"' : ''}/>`)
		.join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>\n<image h="${document.height}" xres="${IMAGE_DPI}" w="${document.width}" version="0.0.3" yres="${IMAGE_DPI}">\n <stack isolation="isolate" visibility="visible" name="root" opacity="1" x="0" y="0" composite-op="svg:src-over">\n${layerEntries}\n </stack>\n</image>\n`;
}

function createBlankLayerCanvas(document: OraDocument, layer: OraLayer): HTMLCanvasElement {
	const canvas = window.createEl('canvas');
	canvas.width = document.width;
	canvas.height = document.height;
	const context = canvas.getContext('2d');
	if (context && layer.name === 'Paper') {
		context.fillStyle = document.paperColor || getLayerFallbackColor('Paper');
		context.fillRect(0, 0, canvas.width, canvas.height);
	}
	return canvas;
}

function renderMergedCanvas(document: OraDocument, layerCanvases: HTMLCanvasElement[]): HTMLCanvasElement {
	const canvas = window.createEl('canvas');
	canvas.width = document.width;
	canvas.height = document.height;
	const context = canvas.getContext('2d');
	if (!context) {
		return canvas;
	}
	context.clearRect(0, 0, canvas.width, canvas.height);
	document.layers.forEach((layer, index) => {
		const layerCanvas = layerCanvases[index];
		if (!layerCanvas || !layer.visible) {
			return;
		}
		context.save();
		context.globalAlpha = layer.opacity / 100;
		context.globalCompositeOperation = layer.blendMode === 'multiply' ? 'multiply' : 'source-over';
		context.drawImage(layerCanvas, 0, 0);
		context.restore();
	});
	return canvas;
}

function renderThumbnailDataUrl(sourceCanvas: HTMLCanvasElement): string {
	const scale = Math.min(1, THUMBNAIL_MAX_DIMENSION / Math.max(sourceCanvas.width, sourceCanvas.height));
	const canvas = window.createEl('canvas');
	canvas.width = Math.max(1, Math.round(sourceCanvas.width * scale));
	canvas.height = Math.max(1, Math.round(sourceCanvas.height * scale));
	const context = canvas.getContext('2d');
	if (!context) {
		return '';
	}
	context.drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);
	return canvas.toDataURL('image/png');
}


function dataUrlToBytes(dataUrl: string): Uint8Array {
	const [, body] = dataUrl.split(',');
	if (!body) {
		return new Uint8Array();
	}
	const binary = window.atob(body);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}
