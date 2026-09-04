/* Google Safe Browsing v4 lookup for challenge entry URLs.

   Policy: fail to HELD, not to live. Earlier this failed OPEN (an API error
   was indistinguishable from "clean"), which let an attacker burn the quota
   and then post a payload into the outage window (audit H3). Now the caller
   gets a three-way answer — clean / threat / unknown — and unknown queues the
   entry for a human instead of listing it. A positive match always holds. */

const THREAT_TYPES = [
  'MALWARE',
  'SOCIAL_ENGINEERING',
  'UNWANTED_SOFTWARE',
  'POTENTIALLY_HARMFUL_APPLICATION',
];

export const safeBrowsingOn = () => !!process.env.GOOGLE_SAFEBROWSING_KEY;

// Explicit, mirror-only opt-out: run the gate OFF and list entries unchecked.
// Production never sets this, so a missing key there is a hard failure rather
// than a silent no-gate (audit H3-4). Set only on the test mirror.
export const uncheckedAllowed = () => ['1', 'true'].includes(process.env.CHALLENGE_ALLOW_UNCHECKED ?? '');

/* Entry/boot assertion: when ANY user-submission surface is live (the
   challenge OR the build games) the malware gate must be armed OR the operator
   must have explicitly opted into unchecked mode. A missing key with no opt-out
   throws, so "unset" can't silently mean "no gate" on either surface (audit
   H3-4 for the challenge, H1 for the build games — the assert must not key off
   one surface's flag while another surface is what's actually live). */
export function assertSafeBrowsingReady() {
  const anyLive = process.env.CHALLENGE_LIVE || process.env.BUILDGAMES_LIVE;
  if (anyLive && !process.env.GOOGLE_SAFEBROWSING_KEY && !uncheckedAllowed()) {
    throw new Error(
      'A submission surface is live (CHALLENGE_LIVE / BUILDGAMES_LIVE) but GOOGLE_SAFEBROWSING_KEY is missing and CHALLENGE_ALLOW_UNCHECKED is not set — refusing to list entries unchecked'
    );
  }
}

/* Batched lookup (≤500 URLs, the API cap). Returns { ok, matches }:
   - ok=true  → the API answered; `matches` (Map<url, threatType[]>) is
     authoritative and an absent url is genuinely clean.
   - ok=false → off / error / timeout; `matches` empty and the caller MUST
     treat every url as unknown (hold), never clean. */
export async function checkUrls(urls) {
  const matches = new Map();
  const key = process.env.GOOGLE_SAFEBROWSING_KEY;
  if (!key) return { ok: false, matches };
  if (urls.length === 0) return { ok: true, matches };
  try {
    const res = await fetch(
      `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          client: { clientId: 'vibecodeit', clientVersion: '1.0' },
          threatInfo: {
            threatTypes: THREAT_TYPES,
            platformTypes: ['ANY_PLATFORM'],
            threatEntryTypes: ['URL'],
            threatEntries: urls.slice(0, 500).map((url) => ({ url })),
          },
        }),
      }
    );
    if (!res.ok) {
      console.error(`safe browsing lookup → ${res.status}`);
      return { ok: false, matches };
    }
    const data = await res.json();
    for (const m of data.matches ?? []) {
      const url = m.threat?.url;
      if (!url) continue;
      if (!matches.has(url)) matches.set(url, []);
      matches.get(url).push(m.threatType);
    }
    return { ok: true, matches };
  } catch (err) {
    console.error(`safe browsing lookup failed: ${err.message}`);
    return { ok: false, matches };
  }
}

/* Single-URL verdict for the submit path:
   - null       → clean (API answered, no match)
   - string[]   → threat types → HOLD
   - 'unknown'  → API unreachable → HOLD for human review */
export async function checkUrl(url) {
  const { ok, matches } = await checkUrls([url]);
  if (!ok) return 'unknown';
  return matches.get(url) ?? null;
}
