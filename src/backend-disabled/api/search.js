/* Search audit: every settled query from the search box, hit count included,
   stored forever in the runtime DB (PostHog's free tier only keeps a year).
   The query is data, never code: parameterised insert, control characters
   stripped, hard length cap, per-IP rate limit. */
import { addSearch, rateLimit } from '../../lib/db.js';
import { clientIp, json, readBody } from '../../lib/request.js';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export async function POST({ request, clientAddress }) {
  const ip = clientIp(request, clientAddress);
  if (!(await rateLimit(`search:${ip}`, 60, 10 * 60 * 1000))) {
    return json({ error: 'slow down' }, 429);
  }

  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  const q =
    typeof body.q === 'string'
      ? body.q
          .replace(CONTROL_CHARS, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase()
          .slice(0, 80)
      : '';
  if (!q) return json({ error: 'empty' }, 400);

  const hits = Math.min(9999, Math.max(0, Math.floor(Number(body.hits)) || 0));
  // Two-letter code straight from Cloudflare's edge, same as /api/spot.
  const country = (request.headers.get('cf-ipcountry') || '').slice(0, 2) || null;

  await addSearch(q, hits, country);
  return json({ ok: true });
}
