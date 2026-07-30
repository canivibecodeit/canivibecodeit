import { getApp, allApps } from '../../../lib/apps.js';
import { addVote, removeVote, rateLimit, clearRateLimit, mrrDestroyed } from '../../../lib/db.js';
import { clientIp, json } from '../../../lib/request.js';

export async function POST({ params, request, clientAddress }) {
  const app = getApp(params.slug);
  if (!app) return json({ error: 'unknown app' }, 404);

  const ip = clientIp(request, clientAddress);
  // One vote per app per IP per day, and a burst cap across all apps.
  if (
    !(await rateLimit(`vote:${ip}:${params.slug}`, 1, 24 * 60 * 60 * 1000)) ||
    !(await rateLimit(`vote-burst:${ip}`, 10, 60 * 60 * 1000))
  ) {
    return json({ error: 'already counted' }, 429);
  }

  const count = await addVote(params.slug);
  return json({ count, mrr: mrrDestroyed(allApps()) });
}

// Un-vote: decrement and clear this IP's daily-limit key so re-voting works.
export async function DELETE({ params, request, clientAddress }) {
  const app = getApp(params.slug);
  if (!app) return json({ error: 'unknown app' }, 404);

  const ip = clientIp(request, clientAddress);
  if (!(await rateLimit(`unvote-burst:${ip}`, 20, 60 * 60 * 1000))) {
    return json({ error: 'slow down' }, 429);
  }

  const count = await removeVote(params.slug);
  await clearRateLimit(`vote:${ip}:${params.slug}`);
  return json({ count, mrr: mrrDestroyed(allApps()) });
}
