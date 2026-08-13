// WebGL2 texture helpers shared by gpu-stroke-engine.ts
// allocation, FBO clearing/copying, persisted image upload, and pixel readback for .ora export

export type GpuTextureFormat = 'rgba' | 'mask';

export interface GpuTexture {
	texture: WebGLTexture;
	framebuffer: WebGLFramebuffer;
	width: number;
	height: number;
	format: GpuTextureFormat;
}

export const LAYER_TEXTURE_FORMAT: GpuTextureFormat = 'rgba';
export const MASK_TEXTURE_FORMAT: GpuTextureFormat = 'mask';

export function createLayerTexture(gl: WebGL2RenderingContext, width: number, height: number, format: GpuTextureFormat = LAYER_TEXTURE_FORMAT): GpuTexture {
	const texture = gl.createTexture();
	const framebuffer = gl.createFramebuffer();
	if (!texture || !framebuffer) {
		throw new Error('Unable to allocate WebGL texture resources');
	}

	const textureTarget = gl.TEXTURE_2D;
	const internalFormat = format === MASK_TEXTURE_FORMAT ? gl.R8 : gl.RGBA8;
	const uploadFormat = format === MASK_TEXTURE_FORMAT ? gl.RED : gl.RGBA;

	gl.bindTexture(textureTarget, texture);
	gl.texParameteri(textureTarget, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(textureTarget, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(textureTarget, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(textureTarget, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	gl.texImage2D(textureTarget, 0, internalFormat, width, height, 0, uploadFormat, gl.UNSIGNED_BYTE, null);

	gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, textureTarget, texture, 0);
	if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
		throw new Error('Incomplete WebGL framebuffer');
	}

	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.bindTexture(textureTarget, null);

	return { texture, framebuffer, width, height, format };
}

export function destroyTexture(gl: WebGL2RenderingContext, texture: GpuTexture): void {
	gl.deleteFramebuffer(texture.framebuffer);
	gl.deleteTexture(texture.texture);
}

export function clearTexture(gl: WebGL2RenderingContext, texture: GpuTexture, color: { r?: number; g?: number; b?: number; a?: number } = { r: 0, g: 0, b: 0, a: 0 }): void {
	gl.bindFramebuffer(gl.FRAMEBUFFER, texture.framebuffer);
	gl.viewport(0, 0, texture.width, texture.height);
	gl.disable(gl.SCISSOR_TEST);
	gl.clearColor(color.r ?? 0, color.g ?? 0, color.b ?? 0, color.a ?? 0);
	gl.clear(gl.COLOR_BUFFER_BIT);
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

export function fillSolidColor(gl: WebGL2RenderingContext, texture: GpuTexture, width: number, height: number, rgba: [number, number, number, number]): void {
	clearTexture(gl, texture, { r: rgba[0] / 255, g: rgba[1] / 255, b: rgba[2] / 255, a: rgba[3] / 255 });
	void width;
	void height;
}

export function copyTexture(gl: WebGL2RenderingContext, source: GpuTexture, destination: GpuTexture, width: number, height: number): void {
	gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source.framebuffer);
	gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, destination.framebuffer);
	gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
	gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
	gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
}

// load a layer raster into a full-canvas texture
export async function loadImageIntoTexture(gl: WebGL2RenderingContext, texture: GpuTexture, dataUrl: string, width: number, height: number, offsetX = 0, offsetY = 0): Promise<void> {
	const image = new Image();
	image.src = dataUrl;
	await image.decode();
	const canvas = createEl('canvas');
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext('2d');
	if (!context) {
		return;
	}
	context.clearRect(0, 0, width, height);
	context.drawImage(image, offsetX, offsetY);
	writeCanvasToTexture(gl, texture, canvas, width, height);
}

export function writeCanvasToTexture(gl: WebGL2RenderingContext, texture: GpuTexture, canvas: HTMLCanvasElement, width: number, height: number, offsetX = 0, offsetY = 0): void {
	const uploadFormat = texture.format === MASK_TEXTURE_FORMAT ? gl.RED : gl.RGBA;
	gl.bindTexture(gl.TEXTURE_2D, texture.texture);
	gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);

	gl.texSubImage2D(gl.TEXTURE_2D, 0, offsetX, texture.height - offsetY - height, width, height, uploadFormat, gl.UNSIGNED_BYTE, canvas);
	gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
	gl.bindTexture(gl.TEXTURE_2D, null);
}

export async function readTextureToCanvas(gl: WebGL2RenderingContext, texture: GpuTexture, width: number, height: number): Promise<HTMLCanvasElement> {
	const pixels = new Uint8Array(width * height * 4);
	gl.bindFramebuffer(gl.FRAMEBUFFER, texture.framebuffer);
	gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);

	const canvas = createEl('canvas');
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext('2d');
	if (context) {
		const imageData = context.createImageData(width, height);
		const rowSize = width * 4;
		for (let y = 0; y < height; y += 1) {
			const srcStart = (height - 1 - y) * rowSize;
			const destStart = y * rowSize;
			imageData.data.set(pixels.subarray(srcStart, srcStart + rowSize), destStart);
		}
		context.putImageData(imageData, 0, 0);
	}

	return canvas;
}
