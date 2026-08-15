/* Reads site stats back from PostHog via HogQL, server-side, cached for 60s
   so the strip never hammers their API (or leaks how it's queried). Absent
   credentials degrade to nulls — the UI renders placeholders. */

const HOST = process.env.POSTHOG_UI_HOST || 'https://eu.posthog.com';
const PROJECT = process.env.POSTHOG_PROJECT_ID;
const KEY = process.env.POSTHOG_PERSONAL_KEY;

const QUERY = `
  SELECT
    countIf(event = '$pageview' AND timestamp >= toStartOfDay(now())) AS views_today,
    countIf(event = '$pageview') AS views_7d,
    countDistinctIf(distinct_id, event = '$pageview') AS visitors_7d,
    countIf(event = 'copy_prompt') AS copies_7d,
    (SELECT max(pv) FROM (
      SELECT toDate(timestamp) AS d, countIf(event = '$pageview') AS pv
      FROM events
      WHERE properties.$host = 'canivibecodeit.com'
      GROUP BY d
    )) AS best_day
  FROM events
  WHERE properties.$host = 'canivibecodeit.com'
    AND timestamp > now() - INTERVAL 7 DAY
`;

/* PostHog's query API allows 2400 requests/hour but only 3 concurrent queries
   per project; queued queries can be cancelled. Callers must keep any
   Promise.all at 3 queries or fewer. A 429 means the hourly quota is gone:
   stop asking for five minutes and let every caller serve its stale cache. */
let pausedUntil = 0;

async function hogql(query, { fresh = false } = {}) {
  if (Date.now() < pausedUntil) throw new Error('posthog rate limited');
  const res = await fetch(`${HOST}/api/projects/${PROJECT}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    /* fresh = force_blocking, which bypasses PostHog's own query-result cache.
       Our query text never changes (now() lives inside the SQL), so without it
       PostHog returns the same snapshot for minutes and the live window slides
       backwards between their recomputes. */
    body: JSON.stringify({
      query: { kind: 'HogQLQuery', query },
      refresh: fresh ? 'force_blocking' : 'blocking',
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 429) pausedUntil = Date.now() + 300_000;
  if (!res.ok) throw new Error(`posthog ${res.status}`);
  return (await res.json()).results;
}

const SITE = `properties.$host = 'canivibecodeit.com'`;

// $pathname arrives from PostHog events, and anyone can POST a fake event with
// the public ingest key, so it is attacker-controlled. A genuine path starts
// with "/" and carries no markup or quotes; anything else is spoofed. Collapse
// it to "/" so a payload can never ride the feed into a set:html JSON blob.
const cleanPath = (p) =>
  typeof p === 'string' && p.length <= 128 && /^\/[^\s<>"'`]*$/.test(p) ? p : '/';

let dashCache = { at: 0, data: null };
let dashInFlight = null;

// Fuller dataset for the /stats page. One shared 2-minute cache; concurrent
// callers at TTL expiry share one refresh instead of racing PostHog.
// Stale-while-revalidate: an expired cache still serves instantly while one
// background refresh runs, so page renders never wait on PostHog. Only a
// cold cache (first hit after a deploy) blocks.
export async function dashboardStats() {
  if (!PROJECT || !KEY) return null;
  if (Date.now() - dashCache.at >= 120_000 && !dashInFlight)
    dashInFlight = refreshDashboard().finally(() => {
      dashInFlight = null;
    });
  if (dashCache.data) return dashCache.data;
  return dashInFlight ?? dashCache.data;
}

// Tracking outage: from 2026-07-31 ~12:00 to 2026-08-01 ~18:48 UTC the /ph
// proxy forwarded Cloudflare edge headers upstream and PostHog's own
// Cloudflare rejected the events (error 1000; fixed in ffbae8e). Ingestion
// recorded single-digit pageviews per hour against ~900/hour on the
// surrounding days. The daily chart shows those two days reconstructed
// from the neighbouring healthy days (recorded hours kept as-is, dead hours
// filled with a distance-weighted average of the same hour on Jul 30 and
// Aug 2; visitors scaled by each day's recorded visitor/view ratio).
const OUTAGE_PATCH = {
  '2026-07-31': { views: 20113, visitors: 5138 },
  '2026-08-01': { views: 19509, visitors: 5364 },
};

async function refreshDashboard() {
  const now = Date.now();
  try {
    // Two batches of three: the project allows 3 concurrent queries, and a
    // six-wide Promise.all gets the overflow queued and sometimes cancelled.
    const [tiles, allTime, byDay] = await Promise.all([
      hogql(QUERY),
      hogql(`
        SELECT countIf(event = '$pageview') AS views,
               countDistinctIf(distinct_id, event = '$pageview') AS visitors,
               countIf(event = 'copy_prompt') AS copies,
               toDate(min(timestamp)) AS since
        FROM events
        WHERE ${SITE}
      `),
      hogql(`
        SELECT toDate(timestamp) AS d,
               countIf(event = '$pageview') AS views,
               countDistinctIf(distinct_id, event = '$pageview') AS visitors
        FROM events
        WHERE ${SITE} AND timestamp > now() - INTERVAL 14 DAY
        GROUP BY d ORDER BY d
      `),
    ]);
    const [pages, agents, topPrompts] = await Promise.all([
      hogql(`
        SELECT properties.$pathname AS p, count() AS n
        FROM events
        WHERE ${SITE} AND event = '$pageview' AND timestamp > now() - INTERVAL 7 DAY
        GROUP BY p ORDER BY n DESC LIMIT 8
      `),
      hogql(`
        SELECT coalesce(properties.agent, 'unknown') AS a, count() AS n
        FROM events
        WHERE ${SITE} AND event = 'copy_prompt' AND timestamp > now() - INTERVAL 7 DAY
        GROUP BY a ORDER BY n DESC
      `),
      hogql(`
        SELECT coalesce(properties.app, 'unknown') AS app, count() AS n
        FROM events
        WHERE ${SITE} AND event = 'copy_prompt' AND timestamp > now() - INTERVAL 7 DAY
        GROUP BY app ORDER BY n DESC LIMIT 8
      `),
    ]);
    const [viewsToday, views7d, visitors7d, copies7d, bestDay] = tiles[0];
    const [totalViews, totalVisitors, totalCopies, since] = allTime[0];
    dashCache = {
      at: now,
      data: {
        tiles: { viewsToday, views7d, visitors7d, copies7d, bestDay },
        allTime: { views: totalViews, visitors: totalVisitors, copies: totalCopies, since },
        byDay: byDay.map(([d, views, visitors]) => ({ d, ...(OUTAGE_PATCH[d] || { views, visitors }) })),
        pages: pages.map(([p, n]) => ({ p: cleanPath(p), n })),
        agents: agents.map(([a, n]) => ({ a, n })),
        topPrompts: topPrompts.map(([app, n]) => ({ app, n })),
      },
    };
  } catch {
    dashCache.at = now; // serve stale, retry after TTL
  }
  return dashCache.data;
}

let globeCache = { at: 0, data: null };
// Totals that barely move sit in their own 10-minute tier, so each live
// refresh costs two queries instead of five (three concurrent is the cap).
let globeSlow = {
  at: 0,
  allTime: { views: null, countries: null, since: null },
  topCountries: [],
  moreCountries: 0,
};

// Single-flight guard: every visitor's tab polls /api/globe and every page
// render calls globeStats(), so when the TTL lapses several requests can race
// to refresh at once. They all await the one in-flight refresh instead of
// each firing their own PostHog queries.
let globeInFlight = null;

/* Geo picture for the homepage globe. Country-level only, on purpose: no
   person ids, no combos that could single anyone out. One shared 30s cache
   serves both the server render and the /api/globe poll; `at` lets callers
   tell the client how old the snapshot is. */
export async function globeStats() {
  if (!PROJECT || !KEY) return null;
  // Stale-while-revalidate: past the TTL the stale snapshot still returns
  // instantly (its `at` keeps the "ago" labels honest) while one background
  // refresh runs. Only a cold cache blocks.
  if (Date.now() - globeCache.at >= 30_000 && !globeInFlight)
    globeInFlight = refreshGlobe().finally(() => {
      globeInFlight = null;
    });
  if (globeCache.data) return globeCache.data;
  return globeInFlight ?? globeCache.data;
}

async function refreshGlobe() {
  const now = Date.now();

  if (now - globeSlow.at > 600_000) {
    try {
      // Sequential on purpose: the fast tier below runs two queries of its
      // own, and a third in flight here would hit the concurrency cap.
      const allTime = await hogql(`
        SELECT count() AS views,
               countDistinctIf(properties.$geoip_country_code,
                 properties.$geoip_country_code != '') AS countries,
               toDate(min(timestamp)) AS since
        FROM events
        WHERE ${SITE} AND event = '$pageview'
      `);
      const countries7d = await hogql(`
        SELECT properties.$geoip_country_code AS c, countDistinct(distinct_id) AS n
        FROM events
        WHERE ${SITE} AND event = '$pageview'
          AND timestamp > now() - INTERVAL 7 DAY
          AND properties.$geoip_country_code != ''
        GROUP BY c ORDER BY n DESC
      `);
      globeSlow = {
        at: now,
        allTime: { views: allTime[0][0], countries: allTime[0][1], since: allTime[0][2] },
        topCountries: countries7d.slice(0, 5).map(([c, n]) => ({ c, n })),
        moreCountries: Math.max(0, countries7d.length - 5),
      };
    } catch {
      globeSlow.at = now - 480_000; // keep the stale totals, retry in ~2 minutes
    }
  }

  try {
    const [pinRows, feed] = await Promise.all([
      // One query carries both the pins (60-minute window) and the live count
      // (5-minute sub-window). Summing per-country distincts can double-count
      // a person who hops countries, and geo-less events drop out entirely;
      // both effects are negligible and the pins need the geo split anyway.
      hogql(
        `
        SELECT properties.$geoip_country_code AS c,
               countDistinct(distinct_id) AS n,
               countDistinctIf(distinct_id,
                 timestamp > now() - INTERVAL 5 MINUTE) AS live,
               toUnixTimestamp(max(timestamp)) AS latest
        FROM events
        WHERE ${SITE} AND event = '$pageview'
          AND timestamp > now() - INTERVAL 60 MINUTE
          AND properties.$geoip_country_code != ''
        GROUP BY c ORDER BY n DESC LIMIT 60
      `,
        { fresh: true }
      ),
      hogql(
        `
        SELECT properties.$geoip_country_code AS c,
               event,
               properties.$pathname AS path,
               coalesce(properties.app, '') AS app,
               coalesce(properties.$device_type, '') AS device,
               coalesce(properties.$referring_domain, '') AS ref,
               toUnixTimestamp(timestamp) AS ts
        FROM events
        WHERE ${SITE} AND event IN ('$pageview', 'copy_prompt')
          AND timestamp > now() - INTERVAL 60 MINUTE
          AND properties.$geoip_country_code != ''
        ORDER BY timestamp DESC LIMIT 12
      `,
        { fresh: true }
      ),
    ]);
    const nowS = Math.floor(Date.now() / 1000);
    globeCache = {
      at: Date.now(),
      data: {
        at: Date.now(),
        live: pinRows.reduce((sum, r) => sum + Number(r[2]), 0),
        liveCountries: pinRows.filter((r) => Number(r[2]) > 0).length,
        allTime: globeSlow.allTime,
        topCountries: globeSlow.topCountries,
        moreCountries: globeSlow.moreCountries,
        feed: feed.map(([c, event, path, app, device, ref, ts]) => ({
          c,
          copy: event === 'copy_prompt',
          path: cleanPath(path),
          app,
          device,
          ref,
          ago: Math.max(0, nowS - ts),
        })),
        pins: pinRows.map(([c, n, , latest]) => ({ c, n, ago: Math.max(0, nowS - latest) })),
      },
    };
  } catch {
    globeCache.at = now; // serve stale, retry after TTL
  }
  return globeCache.data;
}

let cache = { at: 0, data: null };
let siteInFlight = null;

export async function siteStats() {
  if (!PROJECT || !KEY) return null;
  // Stale-while-revalidate, same as dashboardStats: serve stale instantly,
  // refresh in the background, block only when the cache is cold.
  if (Date.now() - cache.at >= 60_000 && !siteInFlight)
    siteInFlight = refreshSite().finally(() => {
      siteInFlight = null;
    });
  if (cache.data) return cache.data;
  return siteInFlight ?? cache.data;
}

async function refreshSite() {
  const now = Date.now();
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
    const [viewsToday, views7d, visitors7d, copies7d, bestDay] = body.results[0];
    cache = {
      at: now,
      data: { viewsToday, views7d, visitors7d, copies7d, bestDay },
    };
  } catch {
    // keep serving the stale value; retry after the TTL
    cache.at = now;
  }
  return cache.data;
}
