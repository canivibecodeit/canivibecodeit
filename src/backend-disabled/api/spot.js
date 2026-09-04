import { addSponsorClick, rateLimit } from '../../lib/db.js';
import { clientIp } from '../../lib/request.js';
import { SLOT_IDS } from '../../lib/sponsors.js';

/* Private first-party log of clicks on sponsor placements: slot, surface,
   country. Never rendered publicly — read from the token-gated admin page.
   Country comes from Cloudflare's edge (CF-IPCountry header); no lookups. */

const SURFACES = new Set(['rail', 'tape', 'banner']);

export async function POST({ request, clientAddress }) {
  const done = new Response(null, { status: 204 });
  try {
    const ip = clientIp(request, clientAddress);
    if (!(await rateLimit(`spot:${ip}`, 120, 60 * 60 * 1000))) return done;

    // sendBeacon ships strings as text/plain, so parse the raw body directly.
    const body = JSON.parse((await request.text()) || '{}');
    const slot = String(body.slot ?? '').trim().toUpperCase();
    const surface = String(body.surface ?? '').trim();
    if (!SLOT_IDS.includes(slot) || !SURFACES.has(surface)) return done;

    const country = request.headers.get('cf-ipcountry') || null;
    await addSponsorClick(slot, surface, country, Date.now());
  } catch {
    // A lost click is a lost click — never an error page.
  }
  return done;
}
