// Enter the challenge: a live https URL + an X handle, nothing else typed.
// Title and image are derived from the page itself, so the form stays under
// a minute. Entries go live INSTANTLY when checks pass; a Safe Browsing
// match lands in the held queue instead (and only an admin releases it).
// Optional email opt-in rides the existing waitlist + Resend audience.
import { createHash } from 'node:crypto';
import { captureServer } from '../../../lib/analytics.js';
import {
  addToWaitlist,
  challengeEntryByUrl,
  insertChallengeEntry,
  isHostBlocked,
  rateLimit,
} from '../../../lib/db.js';
import { challengeLive } from '../../../lib/flags.js';
import { alertAdmin, esc, mirrorToResend } from '../../../lib/mail.js';
import { clientIp, crossOrigin, json, readBody, unreachableEmail, validEmail } from '../../../lib/request.js';
import { parsePublicUrl } from '../../../lib/builds.js';
import {
  canonicalUrl,
  challengeState,
  currentChallenge,
  fetchPageMeta,
  newEntryId,
  normalizeHandle,
  registrableHost,
} from '../../../lib/challenge.js';
import { assertSafeBrowsingReady, checkUrl, safeBrowsingOn } from '../../../lib/safe-browsing.js';
import { selfHostOgImage } from '../../../lib/challenge-image.js';

export async function POST({ request, clientAddress }) {
  if (!challengeLive()) return new Response(null, { status: 404 });
  // The gate must be armed whenever the vertical is live: refuse to accept
  // entries we can't screen rather than list them unchecked.
  assertSafeBrowsingReady();
  if (crossOrigin(request)) return json({ error: 'bad origin' }, 403);

  const challenge = currentChallenge();
  const state = challengeState(challenge);
  if (state !== 'open') {
    return json(
      { error: state === 'upcoming' ? 'not open yet · come back at kickoff' : 'this one is closed · next challenge soon' },
      409
    );
  }

  const ip = clientIp(request, clientAddress);
  if (!(await rateLimit(`chent:${ip}`, 5, 60 * 60 * 1000))) {
    return json({ error: 'five entries an hour is plenty. back soon.' }, 429);
  }
  if (!(await rateLimit('chent:all', 500, 24 * 60 * 60 * 1000))) {
    if (await rateLimit('chent:cap-alert', 1, 24 * 60 * 60 * 1000)) {
      alertAdmin(
        '[cvci] challenge entry cap tripped',
        '<p>The global challenge entry cap (500/day) tripped. Great day or a flood — check the gallery. Caps live in src/pages/api/challenge/enter.js.</p>'
      ).catch((err) => console.error(`challenge cap alert failed: ${err.message}`));
    }
    return json({ error: 'the gallery is flooded right now, try again in a bit' }, 429);
  }

  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  // Honeypot: a real visitor never fills this hidden field.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return json({ ok: true, id: newEntryId(), url: '/challenge' }, 201);
  }

  // The URL: public https only — parsePublicUrl refuses javascript:/data:
  // by construction (URL parse + https-only), plus credentials, IP literals
  // and internal-looking hosts.
  const url = parsePublicUrl(body.url);
  if (!url) return json({ error: 'the entry needs a public https address' }, 400);

  const handle = normalizeHandle(body.x_handle);
  if (!handle) return json({ error: 'an X handle: 1-15 letters, numbers, underscores' }, 400);

  // Host blocklist first: a site an admin unlisted (or Safe Browsing flagged)
  // can't come back under a fresh query string OR a fresh subdomain. Keyed on
  // the registrable host, so blocking evil.com also stops a.evil.com. Neutral
  // message — don't confirm the host is specifically blocked.
  if (await isHostBlocked(registrableHost(url.hostname))) {
    return json({ error: "that site can't be entered" }, 403);
  }

  // Dedupe on the CANONICAL url (lowercased host, no fragment, sorted query),
  // so evil.com/?2 and evil.com/#x collapse into the stored row instead of
  // minting infinite distinct entries. Only a LIVE dupe hands back its
  // permalink; held/unlisted matches return neutrally (no moderation oracle).
  const existingDupe = (dupe) =>
    dupe.status === 'live'
      ? json({ ok: true, id: dupe.id, url: `/challenge/e/${dupe.id}`, existing: true }, 200)
      : json({ ok: true, existing: true, message: 'that entry is already in' }, 200);

  // Fast-path dedupe on the submitted URL: an identical re-post is rejected
  // before we spend a fetch on it.
  const submittedCanonical = canonicalUrl(url);
  const dupe0 = await challengeEntryByUrl(challenge.id, submittedCanonical);
  if (dupe0) return existingDupe(dupe0);

  // Optional opt-in: results + next challenge, via the one digest list.
  // Only new waitlist rows mirror to Resend (unsubscribes stay unsubscribed).
  let emailOpted = 0;
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (email) {
    if (!validEmail(email)) return json({ error: 'that email does not look sendable' }, 400);
    // N3: reserved RFC-2606 addresses never reach the waitlist/audience.
    if (!unreachableEmail(email) && (await addToWaitlist(email, 'challenge'))) mirrorToResend(email);
    emailOpted = 1;
  }

  // Derive title + og:image, and resolve the URL we actually LAND on. From
  // here everything — the blocklist, the Safe Browsing screen, dedupe, what we
  // store, and what the daily recheck will re-screen — uses the FINAL URL, not
  // the submitted one, so a padded redirect target can't be screened-then-
  // discarded (audit P1) and the recheck always screens where the link lands.
  const meta = await fetchPageMeta(url);
  let effective = url;
  let effectiveCanonical = submittedCanonical;
  let reachedOk = meta.reached;
  if (meta.reached) {
    // The hop screen already produced this URL at maxLen 500, so it re-parses;
    // matching that bound is the fix for the 301–500 char revert. A parse
    // failure here can't normally happen — if it does, fail closed.
    const f = parsePublicUrl(meta.finalUrl, { maxLen: 500 });
    if (f) {
      effective = f;
      effectiveCanonical = canonicalUrl(f);
    } else {
      reachedOk = false;
    }
  }

  // Blocklist on the FINAL host — a redirect into a blocked host is caught.
  if (await isHostBlocked(registrableHost(effective.hostname))) {
    return json({ error: "that site can't be entered" }, 403);
  }

  // Second dedupe when the redirect moved us to a different canonical URL:
  // two submissions that land on the same place are one entry (and this keeps
  // the unique index from throwing on insert).
  if (effectiveCanonical !== submittedCanonical) {
    const dupe1 = await challengeEntryByUrl(challenge.id, effectiveCanonical);
    if (dupe1) return existingDupe(dupe1);
  }

  // Safe Browsing gate — fail CLOSED. Three ways an entry holds for review:
  //  - the walk never reached a definitive destination (can't screen it),
  //  - the API was unavailable ('unknown'),
  //  - a positive threat match.
  // On the mirror (unchecked explicitly allowed, no key) the gate is skipped
  // and entries list; production always carries the key.
  let status = 'live';
  let heldReason = null;
  if (safeBrowsingOn()) {
    if (!reachedOk) {
      status = 'held';
      heldReason = 'safe-browsing: destination unreachable, pending review';
    } else {
      const verdict = await checkUrl(effective.href);
      if (verdict === 'unknown') {
        status = 'held';
        heldReason = 'safe-browsing: check unavailable, pending review';
      } else if (verdict) {
        status = 'held';
        heldReason = `safe-browsing: ${verdict.join(', ')}`;
      }
    }
  }

  // Self-host the og:image so it can't be swapped after approval. Mirror has
  // R2 off, so this is null there and the fallback tile shows.
  const id = newEntryId();
  const ogImage = meta.ogImage && status === 'live' ? await selfHostOgImage(meta.ogImage, id) : null;

  await insertChallengeEntry({
    id,
    challenge_id: challenge.id,
    x_handle: handle,
    url: effectiveCanonical,
    page_title: meta.title,
    og_image: ogImage,
    email_opted: emailOpted,
    kind: 'entry',
    status,
    held_reason: heldReason,
    country: request.headers.get('cf-ipcountry') || null,
    created_at: Date.now(),
  });

  // Rate-limit the held-alert mail: now that an unavailable Safe Browsing API
  // correctly HOLDS every submission, an outage would otherwise fire one email
  // per entry up to the daily cap. Cap the mail at 6/hour — the entries still
  // sit in the admin queue regardless (audit N3).
  if (status === 'held' && (await rateLimit('challenge:held-alert', 6, 60 * 60 * 1000))) {
    alertAdmin(
      '[cvci] challenge entry held',
      `<p>A challenge entry needs review:</p>
       <p><b>${esc(meta.title)}</b> by @${esc(handle)}</p>
       <p>${esc(heldReason)}</p>
       <p><a href="https://vibecodeit.com/admin/challenge">open the queue and paste your token</a></p>`
    ).catch((err) => console.error(`challenge held alert failed: ${err.message}`));
  }

  // Hashed IP as distinct_id: stable dedupe, no address in PostHog.
  captureServer(
    'challenge_entry',
    { challenge: challenge.id, held: status === 'held', opted_in: emailOpted === 1 },
    createHash('sha256').update(ip).digest('hex').slice(0, 32)
  );

  return json(
    status === 'held'
      ? { ok: true, id, held: true, message: 'entry received · it needs a quick manual look before it lists' }
      : { ok: true, id, url: `/challenge/e/${id}` },
    201
  );
}
