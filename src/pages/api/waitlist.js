import { addToWaitlist, rateLimit } from '../../lib/db.js';
import { mirrorToResend } from '../../lib/mail.js';
import { clientIp, json, readBody, validEmail } from '../../lib/request.js';

const SOURCES = ['home', 'app', 'app_copy', 'category', 'moat', '404', 'bar', 'sponsor', 'account'];

// RFC 2606 reserved names can never receive mail, and Resend refuses to send a
// broadcast while any @example.com contact sits in the audience.
const RESERVED_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'example.edu']);
const RESERVED_TLDS = ['.test', '.invalid', '.example', '.localhost'];

function unreachable(email) {
  const domain = email.slice(email.lastIndexOf('@') + 1);
  return RESERVED_DOMAINS.has(domain) || RESERVED_TLDS.some((t) => domain.endsWith(t));
}

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
  if (!validEmail(email) || unreachable(email)) return json({ error: 'invalid email' }, 400);

  const source = SOURCES.includes(body.source) ? body.source : 'unknown';

  // Only new rows are mirrored: re-posting an address must never resubscribe
  // someone who unsubscribed on Resend's side.
  if (await addToWaitlist(email, source)) mirrorToResend(email);
  // Dedupe silently — "you're on the list" either way, no email enumeration.
  return json({ ok: true });
}
