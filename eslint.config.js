import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

export default ts.config(
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	prettier,
	...svelte.configs.prettier,
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node },
		},
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: { parser: ts.parser },
		},
	},
	{
		rules: {
			// プロジェクト規約: any / unknown を使わない
			'@typescript-eslint/no-explicit-any': 'error',
		},
	},
	{
		files: ['pipeline/src/index.ts'],
		rules: {
			'@typescript-eslint/triple-slash-reference': 'off',
		},
	},
	{
		ignores: [
			'**/node_modules/',
			'**/.svelte-kit/',
			'**/dist/',
			'**/.wrangler/',
			'**/.tmp/',
			'**/worker-configuration.d.ts',
			'docs/',
			'infra/',
		],
	},
);
