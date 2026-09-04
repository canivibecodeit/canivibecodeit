import { allApps } from '../../lib/apps.js';
import { mrrDestroyed, voteCounts } from '../../lib/db.js';
import { json } from '../../lib/request.js';

export async function GET() {
  const votes = await voteCounts();
  return json({
    mrr: mrrDestroyed(allApps()),
    votes: Object.fromEntries(allApps().map((a) => [a.slug, votes(a.slug)])),
  });
}
