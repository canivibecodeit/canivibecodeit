import { getApp, allApps } from '../../../lib/apps.js';
import { addVote, removeVote, rateLimit, consumeRateLimit, mrrDestroyed } from '../../../lib/db.js';
import { clientIp, json } from '../../../lib/request.js';

// The `vote:<ip>:<slug>` key is both the once-per-day limit and the receipt
// the unvote below spends, so it must never outlive a vote that didn't happen.
const VOTE_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function POST({ params, request, clientAddress }) {
  const app = getApp(params.slug);
  if (!app) return json({ error: 'unknown app' }, 404);

  const ip = clientIp(request, clientAddress);
  // Burst cap first: it must not be possible to fail this check *after* the
  // per-app key was written, or the leftover key becomes a receipt for a vote
  // that was never counted, and the unvote below would drain someone else's.
  if (!(await rateLimit(`vote-burst:${ip}`, 10, 60 * 60 * 1000))) {
    return json({ error: 'already counted' }, 429);
  }
  // Then one vote per app per IP per day.
  if (!(await rateLimit(`vote:${ip}:${params.slug}`, 1, VOTE_WINDOW_MS))) {
    return json({ error: 'already counted' }, 429);
  }

  const count = await addVote(params.slug);
  return json({ count, mrr: mrrDestroyed(allApps()) });
}

// Un-vote: only ever undoes a vote THIS client actually cast. The POST above
// leaves a `vote:<ip>:<slug>` key (24h window); it is our proof a vote exists
// to remove. Without it there is nothing to take back, so we refuse, this is
// what stops anyone from draining other people's votes.

export async function DELETE({ params, request, clientAddress }) {
  const app = getApp(params.slug);
  if (!app) return json({ error: 'unknown app' }, 404);

  const ip = clientIp(request, clientAddress);
  if (!(await rateLimit(`unvote-burst:${ip}`, 20, 60 * 60 * 1000))) {
    return json({ error: 'slow down' }, 429);
  }
  // Spend the receipt and decrement only if we were the one that spent it:
  // two concurrent DELETEs would otherwise both pass a separate check and
  // take two votes off for one.
  if (!(await consumeRateLimit(`vote:${ip}:${params.slug}`, VOTE_WINDOW_MS))) {
    return json({ error: 'no vote to remove' }, 403);
  }

  const count = await removeVote(params.slug);
  return json({ count, mrr: mrrDestroyed(allApps()) });
}
