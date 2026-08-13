import type { LayerName } from './types';

export const LAYER_FALLBACK_COLORS: Record<LayerName, string> = {
	Paper: '#ffffff',
	Sketch: '#222222',
	Ink: '#111111',
	Paint: '#3d6bff',
};

export function getLayerFallbackColor(layer: LayerName): string {
	return LAYER_FALLBACK_COLORS[layer];
}

// get paper color from the paper layer's base image
export async function sampleDataUrlColor(dataUrl: string): Promise<string | undefined> {
	try {
		const image = new Image();
		image.src = dataUrl;
		await image.decode();
		const canvas = createEl('canvas');
		canvas.width = 1;
		canvas.height = 1;
		const context = canvas.getContext('2d');
		if (!context) {
			return undefined;
		}

		context.drawImage(image, 0, 0);
		const data = context.getImageData(0, 0, 1, 1).data;
		if ((data[3] ?? 0) < 128) {
			return undefined;
		}
		const [r, g, b] = [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
		return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
	} catch {
		return undefined;
	}
}
