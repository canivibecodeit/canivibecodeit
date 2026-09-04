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
export const RUN_DAYS = 30;

// Big slots can be locked for a quarter: three 30-day runs, paid upfront,
// price frozen for the whole run. Only offered above this price.
export const QUARTER_MONTHS = 3;
export const QUARTER_MIN_CENTS = 100000;
export const RUN_MS = RUN_DAYS * 24 * 60 * 60 * 1000;

// An outgoing placement may run this far into a slot's next booked term before
// it counts as a conflict — approvals never dock the outgoing run's days.
export const SPILL_MS = 3 * 24 * 60 * 60 * 1000;

// The first of the month after `now`, UTC — when a slot's next run starts.
export function nextRunStart(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

const FULL_MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

export function nextRunMonthName(now = Date.now()) {
  return FULL_MONTHS[new Date(nextRunStart(now)).getUTCMonth()];
}

// Used until a real icon colour is extracted, and when the sponsor's favicon is
// CORS-tainted so the browser can't sample it.
export const DEFAULT_TINT = '#403d88';

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
   Full availability lives on /sponsor, which uses the raw board. Pure
   function of the board, so the balance rules are directly testable. */
export function composeRails(board) {
  const rails = {
    left: board.left.filter((s) => s.state !== 'open'),
    right: board.right.filter((s) => s.state !== 'open'),
  };
  const shorter = () => (rails.right.length < rails.left.length ? 'right' : 'left');
  for (const slot of board.slots.filter((s) => s.state === 'open' && s.house)) {
    rails[shorter()].push(slot);
  }
  const firstOpen = board.slots.find((s) => s.state === 'open' && !s.house) ?? null;
  if (firstOpen) rails[shorter()].push(firstOpen);
  return rails;
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
      priceCents: slot?.price_cents ?? 0,
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
      endsAt: live?.ends_at ?? null,
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
  u.searchParams.set('utm_source', 'vibecodeit');
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
  const base = (process.env.SITE_URL || 'https://vibecodeit.com').replace(/\/+$/, '');
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
