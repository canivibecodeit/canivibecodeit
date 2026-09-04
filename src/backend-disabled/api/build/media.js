// Build screenshots: re-encoded server-side with sharp (EXIF gone by
// construction, SVG refused), stored on R2, served from the media host.
// Uploads happen before the build exists; the ids are claimed by
// POST /api/build and orphans are swept later by the admin cron.
import sharp from 'sharp';
import { buildsLive } from '../../../lib/flags.js';
import { insertBuildMedia, rateLimit } from '../../../lib/db.js';
import { crossOrigin, json } from '../../../lib/request.js';
import { newId } from '../../../lib/builds.js';
import { r2Configured, r2Put, r2PublicUrl } from '../../../lib/r2.js';

const MAX_UPLOAD = 8 * 1024 * 1024;

export async function POST({ request, locals }) {
  if (!buildsLive()) return new Response(null, { status: 404 });
  if (!locals.user) return json({ error: 'sign in first' }, 401);
  if (crossOrigin(request)) return json({ error: 'bad origin' }, 403);
  if (!r2Configured()) {
    return json({ error: 'uploads are down right now · try again in a bit' }, 503);
  }
  if (!(await rateLimit(`bmedia:${locals.user.id}`, 12, 60 * 60 * 1000))) {
    return json({ error: 'slow down' }, 429);
  }

  let file;
  try {
    const form = await request.formData();
    file = form.get('file');
  } catch {
    return json({ error: 'bad upload' }, 400);
  }
  if (!file || typeof file.arrayBuffer !== 'function') {
    return json({ error: 'no file' }, 400);
  }
  if (file.size > MAX_UPLOAD) return json({ error: 'images up to 8MB' }, 413);
  if (/svg/i.test(file.type || '')) return json({ error: 'raster images only' }, 415);

  let out;
  try {
    const input = Buffer.from(await file.arrayBuffer());
    const img = sharp(input, { limitInputPixels: 40_000_000 });
    const meta = await img.metadata();
    if (!meta.format || meta.format === 'svg') throw new Error('not a raster image');
    // Re-encode is the sanitizer: whatever came in, a fresh webp goes out.
    out = await img
      .rotate() // bake the EXIF orientation in before the metadata is dropped
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    return json({ error: 'that does not decode as an image' }, 415);
  }

  const id = newId('bm');
  const key = `builds/${new Date().toISOString().slice(0, 7)}/${id}.webp`;
  try {
    await r2Put(key, out, 'image/webp');
  } catch (err) {
    console.error(`build media upload failed: ${err.message}`);
    return json({ error: 'storage hiccup · try again' }, 502);
  }
  await insertBuildMedia({ id, user_id: locals.user.id, key, created_at: Date.now() });

  return json({ ok: true, id, url: r2PublicUrl(key) });
}
