import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

declare global {
	interface ImportMeta {
		dirname: string;
	}
}

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// These files create DETACHED elements (offscreen canvases, a detached tree
		// root) that must never be attached to the DOM. Obsidian's createEl/createDiv
		// helpers append to the node they are called on, so using them here would throw
		// at runtime. document.createElement is required, and prefer-create-el has no
		// option to allow detached element creation.
		files: [
			'src/rendering/gpu-context.ts',
			'src/rendering/gpu-texture-layer.ts',
			'src/technical/gpu-stroke-engine.ts',
			'src/ui/cursor-overlay.ts',
			'src/ui/folder-tree-browser.ts',
			'src/utilities/layer-colors.ts',
			'src/ora/ora-writer.ts',
		],
		rules: {
			'obsidianmd/prefer-create-el': 'off',
		},
	},
	{
		// Settings tab renders imperatively via display() and custom controls;
		// migrating to the declarative getSettingDefinitions() API is tracked separately.
		files: ['src/utilities/settings.ts'],
		rules: {
			'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
		},
	},
	{
		// "Sketchpad" is the plugin's proper name and is intentionally capitalized
		// (e.g. the "Open Sketchpad" ribbon tooltip)
		rules: {
			'obsidianmd/ui/sentence-case': ['warn', { ignoreWords: ['Sketchpad'], enforceCamelCaseLower: true }],
		},
	},
);
