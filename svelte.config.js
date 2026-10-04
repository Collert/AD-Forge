import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: vitePreprocess(),

	kit: {
		// A plain Node server (`node build`): quotes run OrcaSlicer, which serverless hosts can't.
		// Upload size is capped by the BODY_SIZE_LIMIT env var at runtime (see nixpacks.toml).
		adapter: adapter()
	}
};

export default config;
