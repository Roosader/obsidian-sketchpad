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
