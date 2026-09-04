// Live pot feed for The Build Games page: pool total, sponsor count, and the
// asymptotic fill level — polled ~30s so the orb and figure move without a
// reload. Pot = SUM of all cleared, non-reversed money.
import { bgLeaderboard, bgPotCents } from '../../../lib/db.js';
import { buildGamesLive } from '../../../lib/flags.js';
import { fillLevel } from '../../../lib/buildgames.js';
import { onlineCount } from '../../../lib/presence.js';
import { json } from '../../../lib/request.js';

export async function GET() {
  if (!buildGamesLive()) return new Response(null, { status: 404 });
  const [potCents, board] = await Promise.all([bgPotCents(), bgLeaderboard()]);
  const res = json({
    pot_cents: potCents,
    count: board.length,
    fill: Number(fillLevel(potCents).toFixed(4)),
    online: onlineCount(),
  });
  res.headers.set('Cache-Control', 'public, max-age=15');
  return res;
}
