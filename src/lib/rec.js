/* The How to AI rec layer: ONE counting redirect for every placement.
   GET /api/rec/howtoai?src=<surface>&email=<optional> → 302 to Ruben's
   Substack subscribe page with the email prefilled (Location header only,
   NEVER stored) and utm_campaign = the surface, so clicks can be reported
   per surface per week from rec_clicks. Unknown surfaces are rejected. */
import { recClick, recImpression, rateLimit } from './db.js';
import { clientIp, validEmail } from './request.js';

export const REC_TARGET = 'https://rubenhassid.substack.com/subscribe';

// Every placement that links to the redirect. A surface missing here 400s,
// so a new placement is added HERE in the same change that adds its link.
export const REC_SOURCES = new Set([
  'coreg_digest',
  'coreg_buildgames',
  'apppage',
  'alt_page',
  'alt_hub',
  'category',
  'showcase', // the /built-with model showcase, bottom of the page
  'email_entry',
  'email_editlink',
  'email_welcome',
  'email_sponsor',
  'entry_card', // the Build Games post-entry card (legacy /api/thebuildgames/rec)
]);

export function recHref(src, email) {
  const params = new URLSearchParams();
  if (email) params.set('email', email);
  params.set('utm_source', 'vibecodeit');
  params.set('utm_medium', 'rec');
  params.set('utm_campaign', src);
  return `${REC_TARGET}?${params.toString()}`;
}

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

/* Shared handler. Counting is best-effort and never blocks the navigation;
   past the per-IP limit the click still redirects, it just doesn't count. */
export async function redirectToRec({ request, clientAddress, src, email }) {
  if (!REC_SOURCES.has(src)) return new Response('unknown src', { status: 400 });
  const addr = typeof email === 'string' && validEmail(email.trim()) ? email.trim().toLowerCase() : '';
  try {
    if (await rateLimit(`rec:${clientIp(request, clientAddress)}`, 20, 60 * 60 * 1000)) {
      await recClick(src, dayKey());
    }
  } catch {
    /* count is best-effort */
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: recHref(src, addr),
      'X-Robots-Tag': 'noindex',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

/* Impressions: the CTR denominator per surface. Server side (RecModule's
   SSR render) calls countImpression directly; the co-reg card beacons
   POST /api/rec/impression?src= when it is shown. Best-effort, never
   awaited by a render. */
export function countImpression(src) {
  if (!REC_SOURCES.has(src)) return;
  recImpression(src, dayKey()).catch(() => {});
}

export async function impressionBeacon({ request, clientAddress, src }) {
  if (!REC_SOURCES.has(src)) return new Response(null, { status: 400 });
  try {
    if (await rateLimit(`recimp:${clientIp(request, clientAddress)}`, 60, 60 * 60 * 1000)) {
      await recImpression(src, dayKey());
    }
  } catch {
    /* best-effort */
  }
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}
