/* Runtime OG card for a challenge entry: same satori + resvg + sharp stack
   and visual family as build-og.js, but rendered on request and cached in
   memory — no R2 dependency, so permalinks share correctly on the mirror
   too. Entries appear instantly, so their cards can't be baked at build
   time. Only live entries get a card; held/unlisted 404 (stale edge copies
   age out with the max-age). */
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { challengeEntryById } from '../../../../lib/db.js';
import { challengeLive } from '../../../../lib/flags.js';
import { CHALLENGES, ENTRY_ID_RE } from '../../../../lib/challenge.js';

const COLORS = {
  fg: '#e8e6e0',
  muted: '#9aa29a',
  green: '#403d88',
  chipBg: '#20241f',
  chipBorder: '#2e332d',
};

let assets = null;
const loadAssets = () => {
  if (assets) return assets;
  const root = process.cwd();
  assets = {
    fonts: [
      { name: 'Space Grotesk', weight: 700, data: readFileSync(path.join(root, 'scripts/fonts/SpaceGrotesk-Bold.ttf')) },
      { name: 'JetBrains Mono', weight: 400, data: readFileSync(path.join(root, 'scripts/fonts/JetBrainsMono-Regular.ttf')) },
      { name: 'JetBrains Mono', weight: 700, data: readFileSync(path.join(root, 'scripts/fonts/JetBrainsMono-Bold.ttf')) },
    ],
    bg: `data:image/png;base64,${readFileSync(path.join(root, 'scripts/og-background.png')).toString('base64')}`,
  };
  return assets;
};

const el = (type, style, children) => ({ type, props: { style, ...(children !== undefined && { children }) } });
const mono = (size, color, weight = 400) => ({
  fontFamily: 'JetBrains Mono',
  fontSize: size,
  fontWeight: weight,
  color,
});

const logoRow = () =>
  el('div', { display: 'flex', alignItems: 'center', gap: 16 }, [
    el('div', {
      width: 44, height: 44, border: `4px solid ${COLORS.green}`, borderRadius: 10,
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
    }, [
      el('div', { ...mono(22, COLORS.green, 700), lineHeight: 1 }, '?'),
      el('div', { width: 7, height: 18, backgroundColor: COLORS.green }),
    ]),
    el('div', { display: 'flex', ...mono(26, COLORS.fg) }, [
      el('span', { color: COLORS.fg }, 'vibecode'),
      el('span', { color: COLORS.green }, 'it'),
    ]),
  ]);

// Rendered cards, capped: ids are unguessable and entries immutable-ish, so
// a tiny LRU-by-eviction map beats re-rendering per crawler hit.
const cache = new Map();
const CACHE_MAX = 500;

async function renderCard(entry, challengeTitle) {
  const { fonts, bg } = loadAssets();
  const title = (entry.page_title ?? entry.url).slice(0, 90);
  const tree = el('div', {
    width: 1200, height: 630, display: 'flex', flexDirection: 'column',
    justifyContent: 'space-between', padding: 64,
    backgroundImage: `url(${bg})`, backgroundSize: '1200px 630px',
  }, [
    el('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between' }, [
      logoRow(),
      el('div', {
        ...mono(24, COLORS.green, 700),
        padding: '10px 22px',
        backgroundColor: COLORS.chipBg,
        border: `2px solid ${COLORS.chipBorder}`,
        borderRadius: 999,
      }, challengeTitle.toLowerCase()),
    ]),
    el('div', { display: 'flex', flexDirection: 'column', gap: 24 }, [
      el('div', {
        fontFamily: 'Space Grotesk', fontSize: 64, fontWeight: 700,
        color: COLORS.fg, lineHeight: 1.15,
      }, title),
      el('div', { display: 'flex', alignItems: 'baseline', gap: 12 }, [
        el('div', { ...mono(30, COLORS.green, 700) }, `built by @${entry.x_handle}`),
        // The card is the impersonation artefact — mark the handle unverified
        // so "@someone-famous" can't read as a real endorsement (audit M4).
        el('div', { ...mono(20, COLORS.muted) }, 'handle unverified'),
      ]),
    ]),
    el('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between' }, [
      el('div', { ...mono(24, COLORS.muted) }, 'vibecoded during the window · the twist proves it'),
      el('div', { ...mono(24, COLORS.muted) }, 'vibecodeit.com/challenge'),
    ]),
  ]);

  const svg = await satori(tree, { width: 1200, height: 630, fonts });
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
  return sharp(png).png({ compressionLevel: 9, palette: true }).toBuffer();
}

export async function GET({ params }) {
  if (!challengeLive()) return new Response(null, { status: 404 });
  const id = params.id ?? '';
  if (!ENTRY_ID_RE.test(id)) return new Response(null, { status: 404 });

  const entry = await challengeEntryById(id);
  if (!entry || entry.status !== 'live') return new Response(null, { status: 404 });

  let buf = cache.get(id);
  if (!buf) {
    const title = CHALLENGES.find((c) => c.id === entry.challenge_id)?.title ?? 'challenge';
    buf = await renderCard(entry, title);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(id, buf);
  }

  return new Response(buf, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
