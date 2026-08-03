/* Build-time OG image generation: satori (JSX-object → SVG) + resvg (SVG → PNG).
   One background template + programmatic text = pixel-accurate, $0 per new app. */
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const outDir = path.join(root, 'public/og');
mkdirSync(outDir, { recursive: true });

// Local build cache: maps output file -> hash of everything that fed its render.
// Not committed (gitignored) — a fresh checkout just rebuilds everything once.
// Delete it to force a full rebuild after editing the templates below.
const cacheFile = path.join(root, '.og-cache.json');
const loadCache = () => {
  try { return JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { return {}; }
};
const saveCache = (cache) => writeFileSync(cacheFile, JSON.stringify(cache));

// Changing the template, background, or fonts invalidates every cached hash at
// once — the only case where a stale image would otherwise slip through.
const templateHash = createHash('sha256')
  .update(readFileSync(new URL(import.meta.url)))
  .update(readFileSync(path.join(root, 'scripts/og-background.png')))
  .digest('hex');

const hashFor = (key) => createHash('sha256').update(templateHash).update(key).digest('hex');

// Cheap stand-in for the icon's bytes: size+mtime changes whenever the file does,
// without re-reading and base64-encoding it just to check the cache.
const iconStatKey = (slug) => {
  try {
    const s = statSync(path.join(root, 'public/icons', `${slug}.png`));
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return 'noicon';
  }
};

const fonts = [
  { name: 'Space Grotesk', weight: 700, data: readFileSync(path.join(root, 'scripts/fonts/SpaceGrotesk-Bold.ttf')) },
  { name: 'JetBrains Mono', weight: 400, data: readFileSync(path.join(root, 'scripts/fonts/JetBrainsMono-Regular.ttf')) },
  { name: 'JetBrains Mono', weight: 700, data: readFileSync(path.join(root, 'scripts/fonts/JetBrainsMono-Bold.ttf')) },
];

const bg = `data:image/png;base64,${readFileSync(path.join(root, 'scripts/og-background.png')).toString('base64')}`;
const icon = (slug) => {
  const p = path.join(root, 'public/icons', `${slug}.png`);
  return existsSync(p) ? `data:image/png;base64,${readFileSync(p).toString('base64')}` : null;
};

const COLORS = {
  fg: '#e8e6e0',
  muted: '#9aa29a',
  green: '#33e667',
  onGreen: '#06170b',
  amber: '#ffb000',
  onAmber: '#1a1200',
  red: '#ff4444',
  ticker: '#ff5c33',
};

const VERDICT = {
  yes: { label: 'YES · one-shottable', bg: COLORS.green, fg: COLORS.onGreen },
  kinda: { label: 'KINDA · weekend project', bg: COLORS.amber, fg: COLORS.onAmber },
  no: { label: "NOT REALLY · don't bother", bg: COLORS.red, fg: '#fff' },
};

const el = (type, style, children) => ({ type, props: { style, ...(children !== undefined && { children }) } });
const img = (src, style) => ({ type: 'img', props: { src, style } });

const mono = (size, color, weight = 400) => ({
  fontFamily: 'JetBrains Mono',
  fontSize: size,
  fontWeight: weight,
  color,
});

const logoRow = el(
  'div',
  { display: 'flex', alignItems: 'center', gap: 16 },
  [
    el('div', {
      width: 44, height: 44, border: `4px solid ${COLORS.green}`, borderRadius: 10,
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
    }, [
      el('div', { ...mono(22, COLORS.green, 700), lineHeight: 1 }, '?'),
      el('div', { width: 7, height: 18, backgroundColor: COLORS.green }),
    ]),
    el('div', { display: 'flex', ...mono(26, COLORS.fg) }, [
      el('span', { color: COLORS.fg }, 'can'),
      el('span', { color: COLORS.green }, 'i'),
      el('span', { color: COLORS.fg }, 'vibecode'),
      el('span', { color: COLORS.green }, 'it'),
    ]),
  ]
);

function page(children) {
  return el('div', {
    width: 1200, height: 630, display: 'flex', flexDirection: 'column',
    backgroundImage: `url(${bg})`, backgroundSize: '1200px 630px',
    padding: 64,
  }, children);
}

function appCard(app) {
  const v = VERDICT[app.verdict];
  const ic = icon(app.slug);
  const shortName = app.name.split(' / ')[0];
  return page([
    logoRow,
    el('div', { display: 'flex', flexDirection: 'column', gap: 28, marginTop: 66 }, [
      el('div', { display: 'flex', alignItems: 'center', gap: 24 }, [
        ...(ic ? [img(ic, { width: 72, height: 72, borderRadius: 16 })] : []),
        el('div', {
          fontFamily: 'Space Grotesk', fontSize: 74, fontWeight: 700,
          color: COLORS.fg, letterSpacing: '-0.02em',
        }, `Can I vibecode ${shortName}?`),
      ]),
      el('div', { display: 'flex', alignItems: 'center', gap: 22 }, [
        el('div', {
          ...mono(30, v.fg, 700), backgroundColor: v.bg,
          padding: '14px 28px', borderRadius: 10,
        }, v.label),
        el(
          'div',
          mono(28, COLORS.muted),
          app.priceMonthly != null
            ? `$${app.priceMonthly}/mo · save $${(app.priceMonthly * 12).toLocaleString('en-US')}/yr`
            : 'pricing varies'
        ),
      ]),
    ]),
    el('div', { display: 'flex', marginTop: 'auto', justifyContent: 'space-between' }, [
      el('div', mono(22, COLORS.muted), `canivibecodeit.com/${app.slug}`),
      el('div', mono(22, COLORS.muted), 'the exact prompt inside →'),
    ]),
  ]);
}

function homeCard(mrr) {
  return page([
    logoRow,
    el('div', { display: 'flex', flexDirection: 'column', gap: 30, marginTop: 56 }, [
      el('div', {
        fontFamily: 'Space Grotesk', fontSize: 84, fontWeight: 700,
        color: COLORS.fg, letterSpacing: '-0.02em', lineHeight: 1.05,
      }, 'Can I vibecode ___?'),
      el('div', mono(30, COLORS.muted), 'Which subscriptions are one prompt away from free.'),
      el('div', { display: 'flex', alignItems: 'center', gap: 18, marginTop: 18 }, [
        el('div', { ...mono(26, '#ff8a5c', 700), letterSpacing: '0.08em' }, 'COLLECTIVE MRR DESTROYED'),
        el('div', {
          ...mono(40, COLORS.ticker, 700), backgroundColor: '#1f1210',
          border: '2px solid #43241a', borderRadius: 10, padding: '6px 20px',
        }, `$${mrr.toLocaleString('en-US')}/mo`),
      ]),
    ]),
    el('div', { display: 'flex', marginTop: 'auto', justifyContent: 'space-between' }, [
      el('div', mono(22, COLORS.muted), 'canivibecodeit.com'),
      el('div', mono(22, COLORS.muted), 'the death list →'),
    ]),
  ]);
}

async function render(node, file) {
  const svg = await satori(node, { width: 1200, height: 630, fonts });
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
  // resvg's raw PNG is unquantized (~900KB for a flat-color card). These cards
  // only ever use a handful of distinct colors, so a 64-color palette is
  // visually identical and ~10x smaller — matters a lot at 950+ files in git.
  const optimized = await sharp(png)
    .png({ palette: true, colors: 64, effort: 10, compressionLevel: 9 })
    .toBuffer();
  writeFileSync(path.join(outDir, file), optimized);
  console.log('og:', file);
}

async function renderCached(node, file, hashKey, cache) {
  const hash = hashFor(hashKey);
  if (cache[file] === hash && existsSync(path.join(outDir, file))) {
    console.log('og (cached):', file);
    return;
  }
  await render(node, file);
  cache[file] = hash;
}

const apps = readdirSync(path.join(root, 'data/apps'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(path.join(root, 'data/apps', f), 'utf8')));

// Headline stat = total monthly cost of every app on the list (matches src/lib/db.js).
const mrr = Math.round(apps.reduce((s, a) => s + (a.priceMonthly ?? 0), 0));

// The meta card: the site is its own death-list entry.
function siteCard() {
  return page([
    logoRow,
    el('div', { display: 'flex', flexDirection: 'column', gap: 26, marginTop: 62 }, [
      el('div', {
        fontFamily: 'Space Grotesk', fontSize: 76, fontWeight: 700,
        color: COLORS.fg, letterSpacing: '-0.02em', lineHeight: 1.05,
      }, 'Can I vibecode canivibecodeit.com?'),
      el('div', { display: 'flex', alignItems: 'center', gap: 22 }, [
        el('div', {
          ...mono(30, COLORS.onGreen, 700), backgroundColor: COLORS.green,
          padding: '14px 28px', borderRadius: 10,
        }, 'YES · obviously'),
        el('div', mono(28, COLORS.muted), '$0/mo · this site is also just a prompt'),
      ]),
    ]),
    el('div', { display: 'flex', marginTop: 'auto', justifyContent: 'space-between' }, [
      el('div', mono(22, COLORS.muted), 'canivibecodeit.com/vibecode-this-site'),
      el('div', mono(22, COLORS.muted), 'the rebuild prompt inside →'),
    ]),
  ]);
}

// satori/resvg leak native memory per render, so a single process rendering the
// whole catalog OOMs small machines. The parent renders the two singleton cards,
// then re-invokes itself per slice of apps; each child's memory dies with it.
const range = process.env.OG_RANGE;
if (range) {
  const [start, end] = range.split(':').map(Number);
  const cache = loadCache();
  for (const app of apps.slice(start, end)) {
    await renderCached(appCard(app), `${app.slug}.png`, JSON.stringify(app) + '|' + iconStatKey(app.slug), cache);
  }
  saveCache(cache);
} else {
  const cache = loadCache();
  await renderCached(homeCard(mrr), 'home.png', `home:${mrr}`, cache);
  await renderCached(siteCard(), 'vibecode-this-site.png', 'site', cache);
  saveCache(cache);
  const { spawnSync } = await import('node:child_process');
  const self = new URL(import.meta.url).pathname;
  const CHUNK = 100;
  for (let i = 0; i < apps.length; i += CHUNK) {
    const r = spawnSync(process.execPath, [self], {
      stdio: 'inherit',
      env: { ...process.env, OG_RANGE: `${i}:${i + CHUNK}` },
    });
    if (r.status !== 0) {
      console.error(`og chunk ${i}:${i + CHUNK} failed (exit ${r.status})`);
      process.exit(1);
    }
  }
  console.log('done:', apps.length + 2, 'images');
}
