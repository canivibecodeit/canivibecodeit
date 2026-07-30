/* Reads site stats back from PostHog via HogQL, server-side, cached for 60s
   so the strip never hammers their API (or leaks how it's queried). Absent
   credentials degrade to nulls — the UI renders placeholders. */

const HOST = process.env.POSTHOG_UI_HOST || 'https://eu.posthog.com';
const PROJECT = process.env.POSTHOG_PROJECT_ID;
const KEY = process.env.POSTHOG_PERSONAL_KEY;

const QUERY = `
  SELECT
    countDistinctIf(person_id, timestamp > now() - INTERVAL 5 MINUTE) AS online,
    countIf(event = '$pageview' AND timestamp >= toStartOfDay(now())) AS views_today,
    countIf(event = '$pageview') AS views_7d,
    countDistinctIf(person_id, event = '$pageview') AS visitors_7d,
    countIf(event = 'copy_prompt') AS copies_7d
  FROM events
  WHERE properties.$host = 'canivibecodeit.com'
    AND timestamp > now() - INTERVAL 7 DAY
`;

let cache = { at: 0, data: null };

export async function siteStats() {
  if (!PROJECT || !KEY) return null;
  const now = Date.now();
  if (now - cache.at < 60_000) return cache.data;

  try {
    const res = await fetch(`${HOST}/api/projects/${PROJECT}/query/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: QUERY } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`posthog ${res.status}`);
    const body = await res.json();
    const [online, viewsToday, views7d, visitors7d, copies7d] = body.results[0];
    cache = {
      at: now,
      data: { online, viewsToday, views7d, visitors7d, copies7d },
    };
  } catch {
    // keep serving the stale value; retry after the TTL
    cache.at = now;
  }
  return cache.data;
}
