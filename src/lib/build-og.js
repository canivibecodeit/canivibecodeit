/* Runtime OG cards for approved builds: same satori + resvg + sharp stack,
   fonts and background as the build-time app cards (scripts/generate-og.mjs),
   but rendered on demand — builds appear while the site is deployed, so
   their cards can't be baked at build time. Output lands on R2 next to the
   screenshots (permanent, edge-cached) and the URL is written to
   builds.og_image. One render per approval; the known satori native-memory
   leak only bites thousand-render batch jobs, not this.

   The el/mono/logoRow helpers mirror scripts/generate-og.mjs (that file is
   a script with top-level side effects, so it can't be imported). Keep the
   two in the same visual family when either changes. */
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildById, buildUserNames, updateBuild } from './db.js';
import { GOES } from './builds.js';
import { r2Configured, r2Put, r2PublicUrl } from './r2.js';

const COLORS = {
  fg: '#e8e6e0',
  muted: '#9aa29a',
  green: '#403d88',
  onGreen: '#ffffff',
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
const img = (src, style) => ({ type: 'img', props: { src, style } });
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

// The footer hook follows the goes answer — the card sells what the page
// actually holds.
const HOOK = {
  one: 'the exact prompt inside →',
  few: 'the exact prompts inside →',
  weeks: 'how they actually did it, inside →',
  never: 'where it died, inside →',
};

function buildCard(build, handle, shot) {
  const goesLine = `${(GOES[build.goes] ?? build.goes).toUpperCase()} · THEIR WORD`;
  return el('div', {
    width: 1200, height: 630, display: 'flex',
    backgroundImage: `url(${loadAssets().bg})`, backgroundSize: '1200px 630px',
    padding: 64,
  }, [
    el('div', { display: 'flex', flexDirection: 'column', flexGrow: 1, paddingRight: shot ? 44 : 0, minWidth: 0 }, [
      logoRow(),
      el('div', { display: 'flex', flexDirection: 'column', gap: 22, marginTop: 48 }, [
        el('div', {
          fontFamily: 'Space Grotesk', fontSize: build.name.length > 22 ? 52 : 64, fontWeight: 700,
          color: COLORS.fg, letterSpacing: '-0.02em', lineHeight: 1.05,
          lineClamp: 2,
        }, build.name),
        el('div', { display: 'flex', ...mono(26, COLORS.muted) }, [
          el('span', { color: COLORS.muted }, 'by '),
          el('span', { color: COLORS.green, marginLeft: 10, fontWeight: 700 }, handle),
        ]),
        el('div', { display: 'flex' }, [
          el('div', {
            ...mono(22, COLORS.muted, 700), letterSpacing: '0.08em',
            backgroundColor: COLORS.chipBg, border: `2px solid ${COLORS.chipBorder}`,
            padding: '10px 20px', borderRadius: 8,
          }, goesLine),
        ]),
        el('div', { ...mono(26, COLORS.fg), lineHeight: 1.4, lineClamp: 3 }, build.one_liner),
        el('div', mono(24, COLORS.muted), `built with ${build.tool}${build.model ? ` · ${build.model}` : ''}`),
      ]),
      el('div', { display: 'flex', marginTop: 'auto', flexDirection: 'column', gap: 8 }, [
        el('div', mono(21, COLORS.muted), `vibecodeit.com/builds/${handle}`),
        el('div', mono(21, COLORS.green), HOOK[build.goes] ?? HOOK.one),
      ]),
    ]),
    ...(shot
      ? [
          img(shot, {
            width: 420, height: 502, objectFit: 'cover',
            borderRadius: 16, border: `3px solid ${COLORS.chipBorder}`,
          }),
        ]
      : []),
  ]);
}

// The first screenshot, refetched from our own media host and re-encoded to
// PNG (resvg reads png/jpeg, the bucket holds webp). Card renders without it
// if anything fails.
async function firstShot(build) {
  try {
    const media = JSON.parse(build.media || '[]');
    if (!media[0] || !media[0].startsWith(process.env.R2_PUBLIC_BASE + '/')) return null;
    const res = await fetch(media[0], { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const png = await sharp(Buffer.from(await res.arrayBuffer()))
      .resize({ width: 840, withoutEnlargement: true })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return null;
  }
}

/* Fire-and-forget from the approval paths (admin tap, AI reviewer) and as a
   self-heal from the build page for live builds that predate this. */
export async function generateBuildOg(id) {
  try {
    if (!r2Configured()) return;
    const build = await buildById(id);
    if (!build || build.status !== 'live' || build.og_image) return;
    const names = await buildUserNames([build.user_id]);
    const handle = names.get(build.user_id)?.handle;
    if (!handle) return;

    const shot = await firstShot(build);
    const svg = await satori(buildCard(build, handle, shot), {
      width: 1200,
      height: 630,
      fonts: loadAssets().fonts,
    });
    const raw = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
    // Screenshot-bearing cards aren't flat-color: plain palette-free PNG at
    // reasonable compression instead of the batch script's 64 colors.
    const png = await sharp(raw).png({ compressionLevel: 9 }).toBuffer();

    const key = `builds/og/${id}.png`;
    await r2Put(key, png, 'image/png');
    await updateBuild(id, { og_image: r2PublicUrl(key) });
  } catch (err) {
    console.error(`build og ${id}: ${err.message}`);
  }
}
