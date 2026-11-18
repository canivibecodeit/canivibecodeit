/* Sponsor slots: the single source of truth for whether a slot is free, what the
   rails render, and the signatures on the emailed approve/reject links.

   Expiry is decided at render time, never by a cron: a hold that ran out or a
   placement past its end date frees its slot the moment the next page renders,
   so a missed cron run can only cost bookkeeping, never correctness. */

import crypto from 'node:crypto';
import { activePurchases, sponsorSlots } from './db.js';

export const SLOT_IDS = ['L1', 'L2', 'L3', 'L4', 'L5', 'R1', 'R2', 'R3', 'R4', 'R5'];

/* Stripe's minimum session lifetime is 30 minutes; the hold row outlives it by
   five so it is never marked stale while its session is still payable. Neither
   value reserves a slot — a late payment is caught by the rivals check in
   promoteFromSession and refunded, not blocked by an expiry clock. */
export const SESSION_TTL_MS = 30 * 60 * 1000;
export const HOLD_TTL_MS = 35 * 60 * 1000;
// One-off 30-day runs: how sponsors bought before subscriptions, and still how
// hand-minted one-off links and the rows already running work.
export const RUN_DAYS = 30;
export const RUN_MS = RUN_DAYS * 24 * 60 * 60 * 1000;

/* ---------- subscriptions ----------

   A slot is sold as a monthly Stripe subscription. The price lives here and
   nowhere else: SPONSOR_PRICE_CENTS overrides it without a deploy. A price
   change only reaches new subscriptions; Stripe keeps billing every existing
   one at the price it started at.

   A subscription row's card runs from approval for as long as Stripe has
   been paid, so the row keeps:
     paid_through  end of the latest period Stripe has been paid for
     shift_ms      how far the card's run sits after Stripe's periods (the time
                   between payment and approval, or a run being carried over)
     ends_at       what the board reads: paid_through + shift_ms, plus
                   whatever the subscription's state adds (TERM_EXTRA_MS):
       renewing  a 2-day grace, because Stripe bills a renewal up to an hour
                 after the period ends and the card must not flicker off (and
                 the slot must not look free) meanwhile;
       retrying  a renewal failed and Stripe is retrying: the card stays up
                 and the slot stays held for 7 days, then both end;
       ending    cancelled, or Stripe gave up: nothing, the card ends with the
                 paid period.
   Render-time expiry is unchanged. */
export const SPONSOR_PRICE_DEFAULT_CENTS = 100000;
export const RENEWAL_GRACE_MS = 2 * 24 * 60 * 60 * 1000;
export const FAILED_HOLD_MS = 7 * 24 * 60 * 60 * 1000;
export const TERM_EXTRA_MS = Object.freeze({ renewing: RENEWAL_GRACE_MS, retrying: FAILED_HOLD_MS, ending: 0 });

export function sponsorPriceCents(env = process.env) {
  const n = Number(env.SPONSOR_PRICE_CENTS);
  return Number.isInteger(n) && n >= 100 && n <= 10000000 ? n : SPONSOR_PRICE_DEFAULT_CENTS;
}

export function isSubscription(p) {
  return !!p?.stripe_subscription_id;
}

// The end of the time the sponsor has paid for, as the card counts it.
export function paidEndAt(p) {
  if (!p?.paid_through) return p?.ends_at ?? null;
  return Number(p.paid_through) + Math.max(0, Number(p.shift_ms) || 0);
}

export function subscriptionEndsAt({ paidThrough, shiftMs = 0, mode = 'renewing' }) {
  if (!paidThrough) return null;
  return paidThrough + Math.max(0, Number(shiftMs) || 0) + (TERM_EXTRA_MS[mode] ?? 0);
}

// Stripe's own word on whether a subscription will bill again.
export function subscriptionRenews(sub) {
  if (!sub) return false;
  return ['active', 'trialing'].includes(sub.status) && !sub.cancel_at_period_end && !sub.cancel_at;
}

// Which TERM_EXTRA_MS applies to a subscription in this state.
export function subscriptionMode(sub) {
  if (!sub || sub.status === 'canceled' || sub.status === 'unpaid' || sub.status === 'incomplete_expired') return 'ending';
  if (sub.cancel_at_period_end || sub.cancel_at) return 'ending';
  if (sub.status === 'past_due') return 'retrying';
  return 'renewing';
}

/* Approval starts the card's clock: the sponsor gets every day they paid for,
   counted from the moment the card goes up, not from the payment. */
export function approvalTerm(p, now = Date.now()) {
  const periodStart = Number(p.paid_at) || now;
  const paidThrough = Number(p.paid_through) || periodStart + RUN_MS;
  const shiftMs = Math.max(0, now - periodStart);
  const mode = p.cancel_at || p.canceled_at ? 'ending' : 'renewing';
  return {
    starts_at: now,
    paid_through: paidThrough,
    shift_ms: shiftMs,
    ends_at: subscriptionEndsAt({ paidThrough, shiftMs, mode }),
  };
}

// An outgoing placement may run this far into a slot's next booked term before
// it counts as a conflict — approvals never dock the outgoing run's days.
export const SPILL_MS = 3 * 24 * 60 * 60 * 1000;

// The first of the month after `now`, UTC — when a slot's next run starts.
export function nextRunStart(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

// Used until a real icon colour is extracted, and when the sponsor's favicon is
// CORS-tainted so the browser can't sample it.
export const DEFAULT_TINT = '#33e667';

const BOARD_TTL_MS = 60 * 1000;

/* House cards: our own placements filling listed slots that have no live
   purchase — the rails render them as normal-looking cards instead of open
   units. A real PAID sponsor always outranks a house card in the same slot
   (the derivation puts live first), and the slot stays fully buyable on
   /sponsor: house occupancy is a rails-only rendering, never inventory.
   Clicks go out through withUtm campaign 'house' so analytics can tell
   them from paid placements. Logos are self-hosted under public/icons. */
export const HOUSE_CARDS = [
  {
    slot: 'L3',
    name: 'SuperX',
    tagline: 'Grow and monetize your X audience',
    url: 'https://superx.so',
    logoUrl: '/icons/superx.webp',
    tint: '#f77d43',
  },
];

/* Rail composition (operator decision, Sep 2, v2 — replaces one-open-per-side):
   - money cards (live / reserved) stay pinned to their own side, packed from
     the top in slot order — an open unit never sits between occupied cards;
   - house cards are ours to place, so they FLOAT to whichever rail is
     currently shorter (tie → left) to balance the board;
   - exactly ONE open unit renders on the ENTIRE board — the first open slot
     in SLOT_IDS order — appended LAST to the shorter rail regardless of
     which side its slot id belongs to (its checkout still buys that real
     slot). Every other open slot doesn't render at all.
   - The Attention Playbook's house slot (operator decision, Sep 29) sits
     immediately ABOVE that open unit, in the same rail: a slot of the
     sequence, not an extra under it.
   Full availability lives on /sponsor, which uses the raw board. Pure
   function of the board, so the balance rules are directly testable. */
/* The Attention Playbook's house slot. A slot of the rails in its own right,
   like the house card above, but not one of the ten sellable slots: it has
   no price, takes no inventory and never appears on /sponsor. It renders
   as components/HouseSlotCard.astro. HOUSE_TAP_SLOT=0 removes it without a
   deploy. */
export const TAP_SLOT = Object.freeze({ id: 'TAP', side: null, state: 'tap', house: null, sponsor: null, priceCents: 0 });

export function tapSlotOn() {
  return process.env.HOUSE_TAP_SLOT !== '0';
}

export function composeRails(board, { tapSlot = tapSlotOn() } = {}) {
  const rails = {
    left: board.left.filter((s) => s.state !== 'open'),
    right: board.right.filter((s) => s.state !== 'open'),
  };
  const shorter = () => (rails.right.length < rails.left.length ? 'right' : 'left');
  for (const slot of board.slots.filter((s) => s.state === 'open' && s.house)) {
    rails[shorter()].push(slot);
  }
  const firstOpen = board.slots.find((s) => s.state === 'open' && !s.house) ?? null;
  /* The rail the open unit goes to is chosen exactly as before. The
     Attention Playbook's slot sits immediately above the open unit in that
     rail; with no open unit it closes the rail the open unit would have
     taken. Every slot above it keeps its rail and its order. */
  const side = shorter();
  if (tapSlot) rails[side].push(TAP_SLOT);
  if (firstOpen) rails[side].push(firstOpen);
  return rails;
}

/* ---------- rail sizing: every card the same height ----------

   Fairness rule: no card in either rail may be smaller than any other. The
   rails can hold different numbers of cards, so every card in BOTH rails
   is sized by the rail that holds more: the rail's height (the viewport
   less RAIL.chrome) shared between that many cards, capped at the card's
   full height. Both rails start at the same top.

   What fits in a card follows from its height, not from the viewport: a
   card holds its frame, the icon, the name and as many tagline lines as
   the rest allows. The rules are generated from the number of rows, which
   the server knows, and go out in the page <head>. */
export const RAIL = {
  chrome: 90, // 76px above the rails, 14px below
  gap: 10,
  cardMax: 176,
  frame: 26, // 12px padding top and bottom, 1px border each
  icon: 26,
  name: 25, // 7px above, one 18px line
  tagGap: 2,
  tagLine: 15,
  tagMaxLines: 4,
  // The Attention Playbook's card at the narrowest rail width: name and
  // tagline wrap to two lines each, then the counter line.
  tapFull: 148,
  tapNoLine: 127,
};

// Cards in the taller rail; the sold-out notice, when shown, is one more row.
export function railRows(rails, soldOut = false) {
  return Math.max(1, Math.max(rails.left.length, rails.right.length) + (soldOut ? 1 : 0));
}

// The height every card gets at a viewport height.
export function railCardHeight(rows, viewportHeight) {
  return Math.min(RAIL.cardMax, (viewportHeight - RAIL.chrome - (rows - 1) * RAIL.gap) / rows);
}

// The shortest viewport at which a card of this height still fits in the rows.
const viewportFor = (rows, cardHeight) => Math.ceil(RAIL.chrome + rows * cardHeight + (rows - 1) * RAIL.gap);

// Card height needed to show a sponsor's icon, name and this many tagline lines in full.
export function cardHeightFor(tagLines) {
  return RAIL.frame + RAIL.icon + RAIL.name + (tagLines > 0 ? RAIL.tagGap + tagLines * RAIL.tagLine : 0);
}

export function railSizingCss(rows) {
  const n = Math.max(1, Math.floor(rows));
  const tag = 'aside.sp-rail .sp-card .sp-tag';
  const clamp = (lines) => `-webkit-line-clamp:${lines};line-clamp:${lines}`;
  const out = [`aside.sp-rail{--sp-rows:${n}}`, `${tag}{display:-webkit-box;${clamp(RAIL.tagMaxLines)}}`];
  for (let lines = RAIL.tagMaxLines; lines >= 1; lines--) {
    const below = viewportFor(n, cardHeightFor(lines)) - 1;
    out.push(`@media (max-height:${below}px){${tag}{${lines > 1 ? clamp(lines - 1) : 'display:none'}}}`);
  }
  out.push(`@media (max-height:${viewportFor(n, RAIL.tapFull) - 1}px){aside.sp-rail .tap-slot-card .tap-rail-line{display:none}}`);
  out.push(`@media (max-height:${viewportFor(n, RAIL.tapNoLine) - 1}px){aside.sp-rail .tap-slot-card .tap-rail-tag{display:none}}`);
  return `@media (min-width:1280px){${out.join('')}}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ---------- money + dates ---------- */

export function usd(cents) {
  const n = Number(cents) || 0;
  const whole = n / 100;
  return `$${(Number.isInteger(whole) ? whole : whole.toFixed(2)).toLocaleString('en-US')}`;
}

export function shortDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/* ---------- slot state ---------- */

export function slotSide(id) {
  return id.startsWith('L') ? 'left' : 'right';
}

/* Only money takes a slot: paid, submitted, a refund we owe and failed to make,
   or a placement still running.

   A hold deliberately blocks nothing. Holds exist to tie a Stripe session to a
   purchase, not to reserve inventory — anyone curious enough to open checkout
   would otherwise take a slot off the board without paying for it. Several
   people can be in checkout for the same slot at once; whoever pays first wins,
   and the loser is refunded automatically (see promoteFromSession). */
export function blocksSlot(p, now = Date.now()) {
  if (p.status === 'paid' || p.status === 'submitted' || p.status === 'reject_failed') return true;
  if (p.status === 'live') return p.ends_at > now;
  return false;
}

/* A run can be paid for before it starts: such a row blocks its slot (see
   blocksSlot) but doesn't render a card until its start date arrives. */
export function isLive(p, now = Date.now()) {
  return p.status === 'live' && p.ends_at > now && (!p.starts_at || p.starts_at <= now);
}

/* ---------- board ---------- */

let cache = null;

// Approvals and price edits must show up immediately, not a minute later.
export function clearCache() {
  cache = null;
}

async function deriveBoard(now) {
  const [slots, purchases] = await Promise.all([sponsorSlots(), activePurchases()]);
  const byId = new Map(slots.map((s) => [s.id, s]));

  /* Operator holds: comma-separated slot ids in RESERVED_SLOTS render the
     reserved treatment while a deal is mid-negotiation — no fake purchase
     rows, no schema change, flip = env edit + restart. A LIVE sponsor
     always outranks a hold (real money beats a handshake). */
  const heldByOperator = new Set(
    (process.env.RESERVED_SLOTS || '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  );

  const board = SLOT_IDS.map((id) => {
    const slot = byId.get(id);
    const mine = purchases.filter((p) => p.slot_id === id);
    // Two runs can briefly both be live when one spills into the next term;
    // the one whose term started most recently owns the card.
    const live = mine
      .filter((p) => isLive(p, now))
      .sort((a, b) => (b.starts_at ?? 0) - (a.starts_at ?? 0))[0];
    const blocked = mine.some((p) => blocksSlot(p, now));
    // The slot's next run: taken the moment a future-dated purchase exists;
    // otherwise whatever the admin last set (pending/open/reserved).
    const futureRuns = mine.filter((p) => p.status !== 'hold' && p.starts_at && p.starts_at > now);
    const nextTaken = futureRuns.length > 0;
    const nextStartsAt = nextTaken
      ? Math.min(...futureRuns.map((p) => p.starts_at))
      : null;
    return {
      id,
      side: slotSide(id),
      // One price for every slot, from config (sponsorPriceCents).
      priceCents: sponsorPriceCents(),
      renewalPriceCents: slot?.renewal_price_cents ?? null,
      nextState: slot?.next_state || 'pending',
      nextTaken,
      nextStartsAt,
      // reserved = paid for, but not running yet (or an operator hold via
      // RESERVED_SLOTS). Stripe checkout holds show as open.
      state: live ? 'live' : blocked || heldByOperator.has(id) ? 'reserved' : 'open',
      // House card for an otherwise-open slot: rails render it instead of an
      // open unit; /sponsor still sells the slot (state stays 'open').
      house: !live && !blocked && !heldByOperator.has(id) ? HOUSE_CARDS.find((h) => h.slot === id) ?? null : null,
      // Subscriptions: the end of the paid period, not the renewal grace.
      // During a failed renewal's week-long hold the paid end is already
      // past; the hold's end is the honest date to show then.
      endsAt: live ? (paidEndAt(live) > now ? paidEndAt(live) : live.ends_at) : null,
      sponsor: live
        ? {
            name: live.name,
            tagline: live.tagline,
            url: live.url,
            logoUrl: live.logo_url,
            tint: live.tint || DEFAULT_TINT,
          }
        : null,
    };
  });

  const open = board.filter((s) => s.state === 'open');
  const running = board.filter((s) => s.state === 'live' && s.endsAt);
  // Nothing open anywhere: the next slot back on the market is whichever
  // placement ends first, at that slot's current price.
  const soonest = running.sort((a, b) => a.endsAt - b.endsAt)[0] ?? null;

  const liveSlots = board.filter((s) => s.state === 'live');

  // A slot is pre-booked when an active purchase's run starts in the future —
  // renewal reconciliation writes those rows; nothing else does.
  const prebooked = new Set(
    purchases
      .filter((p) => p.status !== 'hold' && p.starts_at && p.starts_at > now)
      .map((p) => p.slot_id)
  );

  return {
    slots: board,
    left: board.filter((s) => s.side === 'left'),
    right: board.filter((s) => s.side === 'right'),
    live: liveSlots,
    open,
    reserved: board.filter((s) => s.state === 'reserved'),
    openCount: open.length,
    soldOut: open.length === 0,
    // Only a board that is genuinely all-running is "sold out". A board held up
    // by reservations gets reserved cards instead, which say so honestly.
    allLive: liveSlots.length === board.length,
    nextOpen: soonest ? { at: soonest.endsAt, priceCents: soonest.priceCents } : null,
    prebookedCount: prebooked.size,
  };
}

export async function getBoard() {
  const now = Date.now();
  if (cache && cache.until > now) return cache.board;
  const board = await deriveBoard(now);
  cache = { board, until: now + BOARD_TTL_MS };
  return board;
}

/* ---------- in-list banner placement ---------- */

const BANNER_EVERY = 8;
// The list is 900 rows long; a banner every eight of them for the whole length
// would be ~110 of them. Nobody scrolls that far, and the ones past the cap
// would only be page weight.
const BANNER_MAX = 8;

// row index → banner index, so the caller can cycle through the live sponsors.
// The first banner sits after row 3: below 1560px the rails are hidden and the
// in-list banners are the only sponsor surface, so one has to be above the fold.
export function bannerSlots(rowCount) {
  const map = new Map();
  for (let n = 1; n <= BANNER_MAX; n++) {
    const after = (n - 1) * BANNER_EVERY + 2;
    if (after >= rowCount - 1) break;
    map.set(after, n - 1);
  }
  return map;
}

/* ---------- signed action links ---------- */

// Emailed approve/reject links carry a signature so a leaked or guessed id can't
// change anything. SPONSOR_SIGNING_SECRET is optional: the admin token already
// gates the same actions, so one secret is enough to start with.
function signingSecret() {
  return process.env.SPONSOR_SIGNING_SECRET || process.env.ADMIN_TOKEN || '';
}

export function signAction(id, action) {
  const secret = signingSecret();
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update(`${id}:${action}`).digest('hex');
}

export function verifyAction(id, action, sig) {
  const expected = signAction(id, action);
  if (!expected || typeof sig !== 'string' || sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

export function timingSafeMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function isAdmin(token) {
  const expected = process.env.ADMIN_TOKEN;
  return !!expected && timingSafeMatch(String(token ?? ''), expected);
}

export function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/* ---------- links ---------- */

/* Appends campaign tags so the click is attributable in the SPONSOR's own
   analytics (our click counter is separate and internal). A URL that already
   carries utm_ params is left exactly as supplied.

   `campaign` distinguishes the surfaces: the sitewide cards stay
   'sponsor_card' — the default, so every existing caller is unchanged — while
   The Build Games passes its own, so a sponsor can tell which placement is
   actually sending them traffic. */
export function withUtm(raw, campaign = 'sponsor_card') {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  for (const key of u.searchParams.keys()) {
    if (key.toLowerCase().startsWith('utm_')) return u.href;
  }
  u.searchParams.set('utm_source', 'canivibecodeit');
  u.searchParams.set('utm_medium', 'referral');
  u.searchParams.set('utm_campaign', campaign);
  return u.href;
}

/* An X / Twitter profile link's favicon is just the X logo — the sponsor's
   actual face is their avatar. unavatar.io resolves handle → avatar image.
   Returns null for anything that isn't a profile path (search, intent, home,
   …) so callers fall back to the normal favicon. Kept here (not in the
   screen) because both the stored pipeline and the render fallback use it. */
const X_RESERVED = new Set([
  'i', 'home', 'search', 'explore', 'notifications', 'messages', 'settings',
  'intent', 'hashtag', 'share', 'login', 'signup', 'compose', 'tos',
  'privacy', 'about', 'download',
]);
export function xAvatarUrl(u) {
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  if (host !== 'x.com' && host !== 'twitter.com') return null;
  const seg = u.pathname.split('/').filter(Boolean);
  if (seg.length === 0) return null;
  const handle = seg[0].replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle) || X_RESERVED.has(handle.toLowerCase())) return null;
  return `https://unavatar.io/x/${encodeURIComponent(handle)}`;
}

// Same trick the app icons use: no upload flow, no storage, no broken images.
// X/Twitter profile links get the profile picture instead of the X logo.
export function faviconUrl(raw) {
  try {
    const u = new URL(raw);
    return xAvatarUrl(u) ?? `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=64`;
  } catch {
    return '';
  }
}

export function siteUrl(pathname = '/') {
  const base = (process.env.SITE_URL || 'https://canivibecodeit.com').replace(/\/+$/, '');
  return `${base}${pathname}`;
}

/* ---------- validators ---------- */

export const LIMITS = { name: 40, tagline: 60, url: 300 };

export function cleanText(value, max) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 0 && s.length <= max ? s : null;
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

// People type "superx.so", not "https://superx.so". Anything that already
// carries a scheme is left alone, so javascript: and ftp: still get rejected
// below rather than quietly turned into https.
export function withScheme(value) {
  const s = String(value ?? '').trim();
  return !s || SCHEME_RE.test(s) ? s : `https://${s}`;
}

export function cleanUrl(value) {
  const s = withScheme(value);
  if (!s || s.length > LIMITS.url) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // A bare word is a typo, not a domain: "foo" must not become https://foo.
  if (!u.hostname.includes('.') || u.hostname.endsWith('.')) return null;
  return u.href;
}

export function cleanTint(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

// #rrggbb → "r, g, b" so a stylesheet can build rgba() at whatever opacity the
// card wants. Tints arrive from the DB, so they never reach CSS unvalidated.
export function tintChannels(hex) {
  const safe = cleanTint(hex) || DEFAULT_TINT;
  return [1, 3, 5].map((i) => parseInt(safe.slice(i, i + 2), 16)).join(', ');
}
