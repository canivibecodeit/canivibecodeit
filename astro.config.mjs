import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

// Server-rendered on purpose: vote counts and the MRR ticker are live data
// baked into the HTML of every page (SEO requirement: no client-only content).
// SQLite reads are microseconds; rendering stays comfortably under a millisecond budget.
// The standalone server reads HOST/PORT env vars at runtime (systemd sets
// 127.0.0.1:8095 on a VPS; PaaS platforms inject their own PORT and need
// HOST=0.0.0.0). The dev-server default below only affects `npm run dev`.
export default defineConfig({
  site: 'https://canivibecodeit.com',
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  server: { host: '127.0.0.1', port: 8095 },
  // Astro's CSRF origin check misfires behind a reverse proxy (it compares the
  // browser Origin against the internal listener origin). The POST endpoints
  // carry their own abuse controls: IP rate limits, honeypot, dedupe.
  security: { checkOrigin: false },
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
