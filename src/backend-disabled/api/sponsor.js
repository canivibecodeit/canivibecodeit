import { addSponsorInquiry, rateLimit } from '../../lib/db.js';
import { clientIp, json, readBody, validEmail } from '../../lib/request.js';

export async function POST({ request, clientAddress }) {
  const ip = clientIp(request, clientAddress);
  if (!(await rateLimit(`sponsor:${ip}`, 3, 60 * 60 * 1000))) {
    return json({ error: 'slow down' }, 429);
  }

  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  if (body.website) return json({ ok: true });

  const email = body.email?.trim().toLowerCase();
  if (!validEmail(email)) return json({ error: 'invalid email' }, 400);

  await addSponsorInquiry(email, body.message);
  return json({ ok: true });
}
