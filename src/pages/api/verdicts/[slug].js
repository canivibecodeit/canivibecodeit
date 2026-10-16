/* Single-app verdict lookup for agents.
   GET /api/verdicts/{slug} -> one app, full detail. */
import { getApp } from '../../../lib/apps.js';
import { voteCount } from '../../../lib/db.js';
import { json } from '../../../lib/request.js';

export async function GET({ params }) {
  const app = getApp(params.slug);
  if (!app) return json({ error: 'not found' }, 404);
  const votes = await voteCount(app.slug);
  return json({
    slug: app.slug,
    name: app.name,
    domain: app.domain ?? null,
    tagline: app.tagline ?? null,
    category: app.category,
    subcategory: app.subcategory ?? null,
    verdict: app.verdict,
    verdictConfidence: app.verdictConfidence ?? null,
    verdictSummary: app.verdictSummary ?? null,
    coreLoopDIY: app.coreLoopDIY ?? null,
    diyTimeEstimate: app.diyTimeEstimate ?? null,
    requirements: app.requirements ?? [],
    whatYouLose: app.whatYouLose ?? [],
    moatTags: app.moatTags ?? [],
    moatNotes: app.moatNotes ?? null,
    whyPeopleStillPay: app.whyPeopleStillPay ?? null,
    priceMonthly: app.priceMonthly ?? null,
    pricing: app.pricing ?? null,
    prompt: app.prompt ?? null,
    promptCurated: app.promptCurated ?? false,
    verifiedOneShot: app.verifiedOneShot ?? false,
    votes,
    url: `https://canivibecodeit.com/${app.slug}`,
  });
}
