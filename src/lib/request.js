// Client IP: only Cloudflare can reach this box in production, so CF-Connecting-IP
// is trustworthy there. The x-forwarded-for fallback is client-spoofable, so it
// only applies while the origin lock is off (local dev / pre-rollout): with
// ORIGIN_VERIFY_SECRET set, a request with no cf-connecting-ip reached the
// origin directly and gets the shared 'unknown' rate-limit bucket instead of a
// self-chosen fresh one.
export function clientIp(request, astroClientAddress) {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf;
  // The literal bucket, not astroClientAddress: Astro's clientAddress starts
  // trusting x-forwarded-for if security.allowedDomains is ever configured,
  // which would silently reopen the spoof this line exists to close.
  if (process.env.ORIGIN_VERIFY_SECRET) return 'unknown';
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    astroClientAddress ||
    'unknown'
  );
}

// Serialise a value for embedding inside a <script> tag via set:html. Only "<"
// can begin a "</script>" that would break out of the tag, so escaping it (and
// the two JS line terminators) makes the JSON inert as markup while staying
// valid JSON and valid JS. Use this for EVERY set:html JSON blob.
export function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
}

// Cross-site writes are already blocked by the session cookie's SameSite=Lax;
// this closes the loop explicitly since Astro's own checkOrigin is off (it
// misfires behind the proxy). Only a PRESENT mismatched Origin is rejected:
// same-origin non-browser clients may omit the header entirely.
export function crossOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const expected = process.env.BETTER_AUTH_URL || process.env.SITE_URL;
  if (!expected) return false;
  try {
    return new URL(origin).origin !== new URL(expected).origin;
  } catch {
    return true;
  }
}

// Accepts JSON or classic form posts, so the forms work without JS too.
export async function readBody(request) {
  const type = request.headers.get('content-type') || '';
  if (type.includes('application/json')) return await request.json();
  const form = await request.formData();
  return Object.fromEntries(form.entries());
}
