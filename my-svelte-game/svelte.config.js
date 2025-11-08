import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			precompress: true,
			strict: true
			// fallback: 'index.html' // uncomment for SPA fallback instead of full SSG
		}),
		prerender: {
			entries: ['*']
		},
		env: {
			dir: '.',
			publicPrefix: 'PUBLIC_'
		}
	}
};

export default config;
