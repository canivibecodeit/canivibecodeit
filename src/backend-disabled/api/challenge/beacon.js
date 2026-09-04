// Badge phone-home: the embeddable "I vibecoded it" badge on ENTRANTS' OWN
// sites sends one beacon per page load. Cross-origin by definition, so this
// endpoint is CORS-open, cookie-free, and answers 204 no matter what — a
// broken beacon must never surface on someone else's site. Counter only:
// no cookies, no fingerprints, no per-visitor anything.
import { bumpEntryBadge, rateLimit } from '../../../lib/db.js';
import { challengeLive } from '../../../lib/flags.js';
import { clientIp } from '../../../lib/request.js';
import { ENTRY_ID_RE } from '../../../lib/challenge.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const done = () => new Response(null, { status: 204, headers: CORS });

export function OPTIONS() {
  return done();
}

export async function POST({ request, clientAddress }) {
  try {
    if (!challengeLive()) return done();
    const ip = clientIp(request, clientAddress);
    if (!(await rateLimit(`chbeac:${ip}`, 60, 60 * 60 * 1000))) return done();

    // sendBeacon ships strings as text/plain: parse the raw body directly.
    const body = JSON.parse((await request.text()) || '{}');
    const id = String(body.id ?? '');
    if (!ENTRY_ID_RE.test(id)) return done();

    await bumpEntryBadge(id); // no-ops unless the entry is live
  } catch {
    /* swallow everything — see the header comment */
  }
  return done();
}
