// GLSL ES 3.00 shader sources for the WebGL2 sketch renderer.

export interface ShaderSource {
	vertex: string;
	fragment: string;
}

export const STAMP_SHADER: ShaderSource = {
	vertex: /* glsl */ `#version 300 es
	precision highp float;

	uniform vec2 uCanvasSize;

	layout(location = 0) in vec2 aCenter;
	layout(location = 1) in float aRadius;
	layout(location = 2) in float aAlpha;
	layout(location = 3) in float aHardness;

	out vec2 vLocalPos;
	out float vAlpha;
	out float vHardness;

	void main() {
		vec2 corners[6] = vec2[6](
			vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0),
			vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0)
		);
		vec2 corner = corners[gl_VertexID];
		vec2 worldPos = aCenter + corner * aRadius;
		gl_Position = vec4(
			(worldPos.x / uCanvasSize.x) * 2.0 - 1.0,
			1.0 - (worldPos.y / uCanvasSize.y) * 2.0,
			0.0,
			1.0
		);
		vLocalPos = corner;
		vAlpha = aAlpha;
		vHardness = aHardness;
	}
	`,
	fragment: /* glsl */ `#version 300 es
	precision highp float;

	in vec2 vLocalPos;
	in float vAlpha;
	in float vHardness;

	layout(location = 0) out vec4 outColor;

	void main() {
		float dist = length(vLocalPos);
		float innerEdge = clamp(vHardness, 0.0, 1.0);
		float coverage = innerEdge >= 1.0
			? (dist <= 1.0 ? 1.0 : 0.0)
			: 1.0 - smoothstep(innerEdge, 1.0, dist);
		if (coverage <= 0.0) {
			discard;
		}
		outColor = vec4(coverage * vAlpha, 0.0, 0.0, coverage * vAlpha);
	}
	`,
};

const FULLSCREEN_VERTEX = /* glsl */ `#version 300 es
precision highp float;

out vec2 vUv;

void main() {
	vec2 positions[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
	vec2 pos = positions[gl_VertexID];
	gl_Position = vec4(pos, 0.0, 1.0);
	vUv = vec2((pos.x + 1.0) * 0.5, (pos.y + 1.0) * 0.5);
}
`;

export const STROKE_BUILD_SHADER: ShaderSource = {
	vertex: FULLSCREEN_VERTEX,
	fragment: /* glsl */ `#version 300 es
	precision highp float;
	precision highp int;

	in vec2 vUv;

	uniform vec3 uColor;
	uniform int uMode;
	uniform sampler2D uMaskTex;
	uniform sampler2D uBaselineTex;

	layout(location = 0) out vec4 outColor;

	void main() {
		float coverage = texture(uMaskTex, vUv).r;
		if (uMode == 1) {
			vec4 baseline = texture(uBaselineTex, vUv);
			if (baseline.a > coverage) {
				outColor = baseline;
				return;
			}
		}
		outColor = vec4(uColor, coverage);
	}
	`,
};

export const STROKE_COMPOSITE_SHADER: ShaderSource = {
	vertex: FULLSCREEN_VERTEX,
	fragment: /* glsl */ `#version 300 es
	precision highp float;
	precision highp int;

	in vec2 vUv;

	uniform int uMode;
	uniform sampler2D uStrokeTex;
	uniform sampler2D uBaseTex;

	layout(location = 0) out vec4 outColor;

	void main() {
		vec4 src = texture(uStrokeTex, vUv);
		if (src.a <= 0.0) {
			discard;
		}
		vec4 dst = texture(uBaseTex, vUv);
		if (uMode == 1) {
			outColor = vec4(dst.rgb, dst.a * (1.0 - src.a));
			return;
		}
		if (uMode == 2) {
			outColor = src;
			return;
		}
		float outA = src.a + dst.a * (1.0 - src.a);
		vec3 outRgb = vec3(0.0);
		if (outA > 0.0001) {
			outRgb = (src.rgb * src.a + dst.rgb * dst.a * (1.0 - src.a)) / outA;
		}
		outColor = vec4(outRgb, outA);
	}
	`,
};

export const LAYER_COMPOSITE_SHADER: ShaderSource = {
	vertex: FULLSCREEN_VERTEX,
	fragment: /* glsl */ `#version 300 es
	precision highp float;
	precision highp int;

	in vec2 vUv;

	uniform float uOpacity;
	uniform int uBlendMode;
	uniform sampler2D uSrcTex;
	uniform sampler2D uDstTex;

	layout(location = 0) out vec4 outColor;

	void main() {
		vec4 src = texture(uSrcTex, vUv);
		vec4 dst = texture(uDstTex, vUv);
		float srcA = src.a * uOpacity;
		if (srcA <= 0.0) {
			outColor = dst;
			return;
		}
		vec3 srcRgb = src.rgb;
		if (uBlendMode == 1) {
			// multiply against the backdrop where the backdrop has coverage
			srcRgb = mix(src.rgb, src.rgb * dst.rgb, dst.a);
		}
		float outA = srcA + dst.a * (1.0 - srcA);
		vec3 outRgb = vec3(0.0);
		if (outA > 0.0001) {
			outRgb = (srcRgb * srcA + dst.rgb * dst.a * (1.0 - srcA)) / outA;
		}
		outColor = vec4(outRgb, outA);
	}
	`,
};

export const STROKE_PREVIEW_SHADER: ShaderSource = {
	vertex: FULLSCREEN_VERTEX,
	fragment: /* glsl */ `#version 300 es
	precision highp float;
	precision highp int;

	in vec2 vUv;

	uniform float uOpacity;
	uniform int uBlendMode;
	uniform sampler2D uBelowTex;
	uniform sampler2D uStrokeTex;
	uniform sampler2D uAboveTex;

	layout(location = 0) out vec4 outColor;

	void main() {
		vec4 stroke = texture(uStrokeTex, vUv);
		vec4 below = texture(uBelowTex, vUv);
		vec4 above = texture(uAboveTex, vUv);

		// mid = stroke over below, with the layer's opacity/blend mode
		float srcA = stroke.a * uOpacity;
		vec3 srcRgb = stroke.rgb;
		if (uBlendMode == 1) {
			srcRgb = mix(stroke.rgb, stroke.rgb * below.rgb, below.a);
		}
		float midA;
		vec3 midRgb;
		if (srcA <= 0.0) {
			midA = below.a;
			midRgb = below.rgb;
		} else {
			midA = srcA + below.a * (1.0 - srcA);
			midRgb = midA > 0.0001 ? (srcRgb * srcA + below.rgb * below.a * (1.0 - srcA)) / midA : vec3(0.0);
		}

		float outA;
		vec3 outRgb;
		float aboveA = above.a;
		if (aboveA <= 0.0) {
			outA = midA;
			outRgb = midRgb;
		} else {
			outA = aboveA + midA * (1.0 - aboveA);
			outRgb = outA > 0.0001 ? (above.rgb * aboveA + midRgb * midA * (1.0 - aboveA)) / outA : vec3(0.0);
		}
		// this pass writes the presentation texture, and the canvas presents
		// opaquely (alpha: false + desynchronized), so flatten whatever is
		// still transparent over white instead of letting it darken to black
		outRgb = mix(vec3(1.0), outRgb, outA);
		outColor = vec4(outRgb, 1.0);
	}
	`,
};

export const SELECTION_EXTRACT_SHADER: ShaderSource = {
	vertex: FULLSCREEN_VERTEX,
	fragment: /* glsl */ `#version 300 es
	precision highp float;

	in vec2 vUv;

	uniform sampler2D uSourceTex;
	uniform sampler2D uMaskTex;

	layout(location = 0) out vec4 outColor;

	void main() {
		float coverage = texture(uMaskTex, vUv).a;
		if (coverage <= 0.0) {
			discard;
		}
		vec4 src = texture(uSourceTex, vUv);
		float outA = src.a * coverage;
		outColor = vec4(src.rgb * outA, outA);
	}
	`,
};

export const SELECTION_QUAD_SHADER: ShaderSource = {
	vertex: /* glsl */ `#version 300 es
	precision highp float;

	uniform vec2 uCanvasSize;
	uniform vec2 uSelectionCenter;
	uniform vec2 uTranslate;
	uniform float uRotation;
	uniform vec2 uScale;

	out vec2 vUv;

	void main() {
		vec2 corners[6] = vec2[6](
			vec2(0.0, 0.0), vec2(uCanvasSize.x, 0.0), vec2(0.0, uCanvasSize.y),
			vec2(0.0, uCanvasSize.y), vec2(uCanvasSize.x, 0.0), vec2(uCanvasSize.x, uCanvasSize.y)
		);
		vec2 original = corners[gl_VertexID];
		vec2 centered = original - uSelectionCenter;
		vec2 scaled = centered * uScale;
		float sine = sin(uRotation);
		float cosine = cos(uRotation);
		vec2 rotated = vec2(
			scaled.x * cosine - scaled.y * sine,
			scaled.x * sine + scaled.y * cosine
		);
		vec2 transformed = rotated + uSelectionCenter + uTranslate;
		gl_Position = vec4(
			(transformed.x / uCanvasSize.x) * 2.0 - 1.0,
			1.0 - (transformed.y / uCanvasSize.y) * 2.0,
			0.0,
			1.0
		);
		vUv = vec2(original.x / uCanvasSize.x, 1.0 - (original.y / uCanvasSize.y));
	}
	`,
	fragment: /* glsl */ `#version 300 es
	precision highp float;

	in vec2 vUv;

	uniform sampler2D uSelectionTex;
	uniform sampler2D uDstTex;
	uniform vec2 uCanvasSize;
	uniform vec2 uImageOrigin;
	uniform vec2 uImageSize;
	uniform float uImagePlacement;

	layout(location = 0) out vec4 outColor;

	void main() {
		vec4 srcPremultiplied;
		if (uImagePlacement > 0.5) {
			// vUv is doc-space with a flipped Y; recover top-origin doc pixels
			vec2 docPos = vec2(vUv.x * uCanvasSize.x, (1.0 - vUv.y) * uCanvasSize.y);
			vec2 imgUv = vec2(
				(docPos.x - uImageOrigin.x) / uImageSize.x,
				1.0 - (docPos.y - uImageOrigin.y) / uImageSize.y
			);
			if (imgUv.x < 0.0 || imgUv.y < 0.0 || imgUv.x > 1.0 || imgUv.y > 1.0) {
				outColor = texture(uDstTex, gl_FragCoord.xy / uCanvasSize);
				return;
			}
			srcPremultiplied = texture(uSelectionTex, imgUv);
		} else {
			srcPremultiplied = texture(uSelectionTex, vUv);
		}
		vec2 dstUv = gl_FragCoord.xy / uCanvasSize;
		vec4 dst = texture(uDstTex, dstUv);
		if (srcPremultiplied.a <= 0.0) {
			outColor = dst;
			return;
		}
		vec3 srcRgb = srcPremultiplied.rgb / srcPremultiplied.a;
		float srcA = srcPremultiplied.a;
		float outA = srcA + dst.a * (1.0 - srcA);
		vec3 outRgb = outA > 0.0001
			? (srcRgb * srcA + dst.rgb * dst.a * (1.0 - srcA)) / outA
			: vec3(0.0);
		outColor = vec4(outRgb, outA);
	}
	`,
};

export const BLIT_SHADER: ShaderSource = {
	vertex: FULLSCREEN_VERTEX,
	fragment: /* glsl */ `#version 300 es
	precision highp float;

	in vec2 vUv;

	uniform sampler2D uSourceTex;

	layout(location = 0) out vec4 outColor;

	void main() {
		outColor = texture(uSourceTex, vUv);
	}
	`,
};
