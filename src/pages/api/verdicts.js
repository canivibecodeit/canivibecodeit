/* Machine-readable verdict index for agents.
   GET /api/verdicts -> every app as compact JSON.
   No auth, no writes, no tracking: agents can rely on it. */
import { allApps } from '../../lib/apps.js';
import { voteCounts } from '../../lib/db.js';
import { json } from '../../lib/request.js';

const ORDER = { yes: 0, kinda: 1, no: 2 };

export async function GET() {
  const votes = await voteCounts();
  const apps = allApps()
    .map((a) => ({
      slug: a.slug,
      name: a.name,
      verdict: a.verdict,
      verdictConfidence: a.verdictConfidence ?? null,
      category: a.category,
      subcategory: a.subcategory ?? null,
      priceMonthly: a.priceMonthly ?? null,
      votes: votes(a.slug),
      url: `https://canivibecodeit.com/${a.slug}`,
    }))
    .sort(
      (a, b) =>
        (ORDER[a.verdict] ?? 9) - (ORDER[b.verdict] ?? 9) ||
        b.votes - a.votes ||
        a.name.localeCompare(b.name)
    );
  return json({
    total: apps.length,
    generatedAt: new Date().toISOString(),
    legend: {
      yes: 'one AI session rebuilds a usable personal version; no moat in the way',
      kinda: 'buildable in a weekend; real gaps remain',
      no: 'the value is the network, the data, or the infra; the moat survives',
    },
    apps,
  });
}
