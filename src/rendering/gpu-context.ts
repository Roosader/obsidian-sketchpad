// WebGL2 capability check for the sketchpad renderer
export interface GpuContext {
	readonly renderer: 'webgl2';
	readonly maxBlendEquation: number;
}

let gpuContextPromise: Promise<GpuContext | null> | null = null;

export function isGpuSupported(): boolean {
	if (typeof document === 'undefined') {
		return false;
	}
	const canvas = document.createElement('canvas');
	const gl = canvas.getContext('webgl2');
	if (!gl) {
		return false;
	}

	gl.getExtension('WEBGL_lose_context')?.loseContext(); //removes probe context after checking
	return true;
}

export function getGpuContext(): Promise<GpuContext | null> {
	if (!gpuContextPromise) {
		gpuContextPromise = requestGpuContext();
	}
	return gpuContextPromise;
}

async function requestGpuContext(): Promise<GpuContext | null> {
	if (!isGpuSupported()) {
		return null;
	}
	try {
		const canvas = document.createElement('canvas');
		const gl = canvas.getContext('webgl2');
		if (!gl) {
			return null;
		}
		const maxBlendEquation = gl.MAX;

		gl.getExtension('WEBGL_lose_context')?.loseContext();
		return {
			renderer: 'webgl2',
			maxBlendEquation,
		};
	} catch (error) {
		console.error('sketchpad: WebGL2 init failed.', error);
		return null;
	}
}
