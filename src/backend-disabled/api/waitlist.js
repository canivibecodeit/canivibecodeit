import { createHash } from 'node:crypto';
import { captureServer } from '../../lib/analytics.js';
import { addToWaitlist, rateLimit } from '../../lib/db.js';
import { mirrorToResend } from '../../lib/mail.js';
import { clientIp, json, readBody, unreachableEmail, validEmail } from '../../lib/request.js';

// Every placement that renders a signup form. A source missing here is
// recorded as 'unknown' and its conversion becomes invisible — add the source
// HERE in the same change that adds the form.
const SOURCES = [
  'home', 'app', 'app_copy', 'category', 'moat', '404', 'bar', 'sponsor', 'account',
  'alternatives_hub', 'alternatives', 'alternative_product', 'bvct',
  'newsletter', 'search_miss', 'post_vote', 'post_submit', 'challenge', 'buildgames',
];

// The RFC-2606 reachability gate now lives in lib/request.js (unreachableEmail)
// so EVERY waitlist-adding path shares one filter (audit N3).

export async function POST({ request, clientAddress }) {
  const ip = clientIp(request, clientAddress);
  if (!(await rateLimit(`waitlist:${ip}`, 5, 60 * 60 * 1000))) {
    return json({ error: 'slow down' }, 429);
  }

  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  // Honeypot: bots fill every field. Pretend success, store nothing.
  if (body.website) return json({ ok: true });

  const email = body.email?.trim().toLowerCase();
  if (!validEmail(email) || unreachableEmail(email)) return json({ error: 'invalid email' }, 400);

  const source = SOURCES.includes(body.source) ? body.source : 'unknown';

  // Only new rows are mirrored: re-posting an address must never resubscribe
  // someone who unsubscribed on Resend's side.
  if (await addToWaitlist(email, source)) {
    mirrorToResend(email);
    // Hashed address as distinct_id: stable dedupe key, no address in PostHog.
    captureServer(
      'waitlist_signup',
      { placement: source, source },
      createHash('sha256').update(email).digest('hex').slice(0, 32)
    );
  }
  // Dedupe silently — "you're on the list" either way, no email enumeration.
  return json({ ok: true });
}
