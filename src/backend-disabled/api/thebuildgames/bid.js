// Place a bid on The Build Games: a public link + tagline + amount. Screens
// the link (SSRF-safe fetch, Safe Browsing, favicon pull) and appends a
// PENDING payment; clearing is the payment interface's job (admin now, webhook
// later). Same open-submission protections as the challenge entry form.
//
// In admin-entry mode the public checkout is dark, so this endpoint is the
// pipeline the admin drives; when a processor lands, the public checkout calls
// it and the webhook clears. It stays gated behind BUILDGAMES_BIDDING_OPEN.
import { createHash, randomUUID } from 'node:crypto';
import { addToWaitlist, bgClearedSponsorByHost, bgIsHostBlocked, bgSponsorByLink, rateLimit } from '../../../lib/db.js';
import { selfHostUploadedIcon } from '../../../lib/challenge-image.js';
import { siteUrl } from '../../../lib/sponsors.js';
import { createBidCheckoutSession } from '../../../lib/stripe.js';
import { buildGamesLive } from '../../../lib/flags.js';
import { mirrorToResend } from '../../../lib/mail.js';
import { clientIp, crossOrigin, json, readBody, unreachableEmail, validEmail } from '../../../lib/request.js';
import {
  MAX_BID_CENTS,
  MIN_ENTRY_CENTS,
  MIN_TOPUP_CENTS,
  TAGLINE_MAX,
  biddingOpen,
  cleanTagline,
  pathIdentityHost,
  registrableHost,
  sponsorIdentity,
} from '../../../lib/buildgames.js';
import { assertSafeBrowsingReady } from '../../../lib/safe-browsing.js';
import { screenSubmission } from '../../../lib/buildgames-screen.js';
import { submitBid } from '../../../lib/buildgames-payments.js';

export async function POST({ request, clientAddress }) {
  if (!buildGamesLive()) return new Response(null, { status: 404 });
  assertSafeBrowsingReady();
  if (crossOrigin(request)) return json({ error: 'bad origin' }, 403);
  if (!biddingOpen()) return json({ error: 'bidding opens soon' }, 409);

  const ip = clientIp(request, clientAddress);
  if (!(await rateLimit(`bgbid:${ip}`, 5, 60 * 60 * 1000))) {
    return json({ error: 'a few bids an hour is plenty · back soon' }, 429);
  }
  if (!(await rateLimit('bgbid:all', 2000, 24 * 60 * 60 * 1000))) {
    return json({ error: 'the board is flooded right now, try again shortly' }, 429);
  }

  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ error: 'bad request' }, 400);
  }
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return json({ ok: true }, 202); // honeypot
  }

  // Amount: integer cents. Cheap pre-screen check against the LOWER of the two
  // floors (the exact entry-vs-topup floor needs the screened identity, below).
  const floorCents = Math.min(MIN_ENTRY_CENTS, MIN_TOPUP_CENTS);
  const amountCents = Math.round(Number(body.amount_cents ?? body.amount));
  if (!Number.isInteger(amountCents) || amountCents < floorCents || amountCents > MAX_BID_CENTS) {
    return json({ error: `amount must be between $${floorCents / 100} and $${MAX_BID_CENTS / 100}` }, 400);
  }

  const tagline = cleanTagline(body.tagline);
  if (body.tagline && !tagline) {
    return json({ error: `tagline: up to ${TAGLINE_MAX} characters, no links` }, 400);
  }

  // Optional contact email: reachable for held/outbid alerts, and (opt-in) it
  // joins the Build Games list — every bidder is an email on THE metric. Stored
  // on the payment, frozen to the sponsor at first clear, never shown publicly.
  const contactEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (contactEmail && !validEmail(contactEmail)) {
    return json({ error: 'that email does not look sendable' }, 400);
  }

  // Screen the link (parse + SSRF-safe fetch + Safe Browsing + favicon).
  const screen = await screenSubmission(body.link);
  if (!screen.ok) return json({ error: screen.reason || 'that link cannot be entered' }, 400);

  // Host blocklist on the FINAL host (a removed/abusive host stays out).
  if (await bgIsHostBlocked(registrableHost(screen.finalUrl.hostname))) {
    return json({ error: "that site can't be entered" }, 403);
  }

  // Exact floor, now that screening resolved the identity: a bid on a sponsor
  // that has already CLEARED is a top-up; everything else (new link, or a link
  // whose bids never cleared) is an entry and pays the entry floor.
  const identityLink = sponsorIdentity(screen.finalUrl);
  const existing = await bgSponsorByLink(identityLink);
  const isTopup = existing?.first_cleared_at != null;
  const minCents = isTopup ? MIN_TOPUP_CENTS : MIN_ENTRY_CENTS;
  if (amountCents < minCents) {
    return json({ error: `minimum ${isTopup ? 'top-up' : 'entry'} is $${minCents / 100}` }, 400);
  }

  // M4 residual: one PAID placement per registrable host on the public path.
  // Different paths/URLs on a host that already bought its identity can't mint
  // extra board slots (N slots for N payments). Unpaid rows never block, so a
  // free squat submission can't lock a brand out. Admin add stays free of this
  // check — exceptions are human judgment.
  // On path-identity hosts (x.com profiles and the like) the per-host guard
  // would block unrelated sponsors who happen to share the platform, so it
  // only applies to ordinary domains. Same-profile duplicates still merge
  // into a top-up above either way.
  if (
    !isTopup &&
    !pathIdentityHost(screen.finalUrl.hostname) &&
    (await bgClearedSponsorByHost(registrableHost(screen.finalUrl.hostname), identityLink))
  ) {
    return json({ error: 'that site already has a placement — top it up instead' }, 409);
  }

  // The flow runs UNATTENDED (pay → screened → listed, no human). So a link
  // that screens anything but clean is refused BEFORE money moves — we never
  // take a payment we'd have to hold or refund while Faizan sleeps. Admin `add`
  // remains the exception path for judgment calls.
  if (screen.verdict !== 'ok') {
    // Refusals are logged, not emailed — operator's call (Aug 28): refusal
    // mail was noise next to the money alerts. The log line keeps the link
    // visible for diagnosing false refusals (bot-walled legit sites).
    console.log(`bg bid refused at screening: ${screen.reason || 'flagged'} · ${String(body.link).slice(0, 200)}`);
    return json({ error: "that link can't be listed automatically — nothing was charged" }, 403);
  }

  // Optional uploaded icon (raster only, ≤1MB — SVG never reaches sharp). An
  // upload that doesn't validate is a clear 400, not a silent fallback.
  let iconSrc = null;
  const upload = body.icon && typeof body.icon === 'object' && typeof body.icon.arrayBuffer === 'function' ? body.icon : null;
  if (upload && upload.size > 0) {
    if (upload.size > 1024 * 1024) return json({ error: 'icon: png/jpg/webp up to 1MB' }, 400);
    iconSrc = await selfHostUploadedIcon(
      Buffer.from(await upload.arrayBuffer()),
      upload.type,
      `buildgames/upload-${randomUUID()}.webp`
    );
    if (!iconSrc) return json({ error: 'icon: png/jpg/webp up to 1MB' }, 400);
  }

  const result = await submitBid({ screen, tagline, amountCents, contactEmail: contactEmail || null, iconSrc });
  if (result.error === 'blocked') return json({ error: "that site can't be entered" }, 403);

  // List capture (opt-in): a new waitlist row mirrors to Resend; existing
  // unsubscribes stay unsubscribed. Only when the bidder ticked the box, and
  // never for an RFC-2606 reserved address (audit N3 — one @example.com
  // contact in the audience makes Resend refuse every broadcast).
  if (
    contactEmail &&
    !unreachableEmail(contactEmail) &&
    ['1', 'true', 'on', 'yes'].includes(String(body.email_optin ?? '').toLowerCase())
  ) {
    if (await addToWaitlist(contactEmail, 'buildgames')) mirrorToResend(contactEmail);
  }

  // Hashed IP distinct_id only — no address stored.
  const _did = createHash('sha256').update(ip).digest('hex').slice(0, 32);

  // Real money path: hand the buyer to Stripe. The webhook clears the payment
  // with the CAPTURED amount and the placement lists itself — no human step.
  try {
    const session = await createBidCheckoutSession({
      paymentId: result.paymentId,
      sponsorId: result.sponsorId,
      amountCents,
      // Success lands on the post-checkout details page: token identifies the
      // payer, the session id settles the redirect-vs-webhook race there
      // (same mechanic as /sponsor/details). Cancel keeps the ?paid=0 toast.
      successUrl: `${siteUrl('/thebuildgames/details')}?token=${result.detailsToken}&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${siteUrl('/thebuildgames')}?paid=0`,
      customerEmail: contactEmail || undefined,
    });
    if (!session?.url) throw new Error('no checkout url on session');
    return json({ ok: true, url: session.url }, 201);
  } catch (err) {
    console.error(`bg checkout create failed: ${err.message}`);
    return json({ error: 'checkout is unavailable right now — nothing was charged, try again in a minute' }, 502);
  }
}
