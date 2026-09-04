/* Fetch favicons for every app that doesn't have public/icons/<slug>.png yet.
   Sources tried in order: Google s2 favicon service (64px), then the site's
   /favicon.ico. Flags tiny/placeholder results so they can be hunted manually. */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appsDir = path.join(root, 'data/apps');
const iconsDir = path.join(root, 'public/icons');
const force = process.argv.includes('--force');

const apps = readdirSync(appsDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(path.join(appsDir, f), 'utf8')));

const fetchBuf = async (url) => {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; vibecodeit-icons)' },
  });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
};

const suspicious = [];
let fetched = 0;

for (const app of apps) {
  const out = path.join(iconsDir, `${app.slug}.png`);
  if (!force && existsSync(out) && statSync(out).size > 300) continue;
  let buf = await fetchBuf(
    `https://www.google.com/s2/favicons?domain=${app.domain}&sz=64`
  ).catch(() => null);
  if (!buf || buf.length < 200) {
    buf = (await fetchBuf(`https://${app.domain}/favicon.ico`).catch(() => null)) || buf;
  }
  if (buf) {
    writeFileSync(out, buf);
    fetched++;
    if (buf.length < 300) suspicious.push(app.slug);
    console.log('icon:', app.slug, buf.length);
  } else {
    suspicious.push(app.slug);
    console.log('FAILED:', app.slug, app.domain);
  }
}

/* Alternative tools get favicons too, keyed by hostname (they have no slug) in
   public/icons/alt/. The page falls back to a letter tile when one is missing,
   so a failed fetch degrades, never breaks. */
const altDir = path.join(iconsDir, 'alt');
mkdirSync(altDir, { recursive: true });

const hosts = new Map();
for (const app of apps) {
  for (const alt of app.alternatives ?? []) {
    try {
      const host = new URL(alt.url).hostname.replace(/^www\./, '');
      if (!hosts.has(host)) hosts.set(host, alt.name);
    } catch {
      /* bad URLs are the validator's problem */
    }
  }
}

let altFetched = 0;
const altFailed = [];
for (const [host] of hosts) {
  const out = path.join(altDir, `${host}.png`);
  if (!force && existsSync(out) && statSync(out).size > 300) continue;
  let buf = await fetchBuf(`https://www.google.com/s2/favicons?domain=${host}&sz=64`).catch(() => null);
  if (!buf || buf.length < 200) {
    buf = (await fetchBuf(`https://${host}/favicon.ico`).catch(() => null)) || buf;
  }
  if (buf && buf.length >= 200) {
    writeFileSync(out, buf);
    altFetched++;
    console.log('alt icon:', host, buf.length);
  } else {
    altFailed.push(host);
    console.log('ALT FAILED:', host);
  }
}

console.log(`\nfetched ${fetched}; needs manual attention: ${suspicious.join(', ') || 'none'}`);
console.log(`alt icons fetched ${altFetched}; failed (letter-tile fallback): ${altFailed.join(', ') || 'none'}`);
