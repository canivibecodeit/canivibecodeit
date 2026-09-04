// Outbound-click counter for board rows (public social proof, and the number
// a sponsor is buying). sendBeacon posts text/plain, so the body is parsed by
// hand. Best-effort by design — a lost beacon is a lost count, never a lost
// navigation. Lightly rate-limited so idle inflation costs effort.
import { bgIncrementClicks, rateLimit } from '../../../lib/db.js';
import { buildGamesLive } from '../../../lib/flags.js';
import { clientIp, json } from '../../../lib/request.js';
import { SPONSOR_ID_RE } from '../../../lib/buildgames.js';

export async function POST({ request, clientAddress }) {
  if (!buildGamesLive()) return new Response(null, { status: 404 });
  const ip = clientIp(request, clientAddress);
  if (!(await rateLimit(`bgclick:${ip}`, 30, 60 * 60 * 1000))) return json({ ok: true });

  let id = '';
  try {
    id = String(JSON.parse(await request.text())?.id ?? '');
  } catch {
    return json({ ok: true });
  }
  if (SPONSOR_ID_RE.test(id)) await bgIncrementClicks(id);
  return json({ ok: true });
}
