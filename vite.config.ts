import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	// CommonJS emscripten build, imported from a worker — pre-bundle it so dev serves it as ESM.
	optimizeDeps: { include: ['occt-import-js'] },
	server: {
		// Hostnames only (no protocol or port). The leading dot allows every subdomain:
		// quick-tunnel URLs change each time cloudflared starts.
		allowedHosts: ['.trycloudflare.com']
	}
});
