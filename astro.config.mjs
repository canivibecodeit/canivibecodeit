import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://vibecodeit.com',
  output: 'static',
  server: { host: '127.0.0.1', port: 8095 },
  // Build id baked in at build time: unhashed public/ scripts get ?v=<id> so
  // long-lived edge/browser caches can never serve stale JS after a deploy.
  // assetsInlineLimit: Vite otherwise inlines sub-4KB scripts into the HTML,
  // and every inlined script is an unhashable CSP violation (ClientRouter's
  // swap ordering also injects a data: script when a page carries an inline
  // module, which enforce would block). false for scripts only; undefined
  // keeps the default 4KB rule for CSS/fonts so small styles stay inlined.
  vite: {
    define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
    build: { assetsInlineLimit: (filePath) => (filePath.endsWith('.js') ? false : undefined) },
  },
});
