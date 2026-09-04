/* The Build Games — sponsor bidding surface. OUTBID-style PUBLIC self-serve:
   anyone pays any amount, submits a link + tagline, the favicon is pulled and
   self-hosted, and they appear on the board at their cumulative rank. 100% of
   cleared money goes to the builders' prize pool.

   Data model (two tables, see db.js):
   - buildgames_sponsors : identity = canonical link (one row per link).
     tagline + icon are set by the FIRST cleared payment and are immutable via
     payments thereafter (admin can still correct) — kills the $5 defacement
     vector. status = active | held | removed (moderation).
   - buildgames_payments : append-only ledger. status = pending | cleared |
     reversed. Ranking = SUM(cleared, non-reversed) per sponsor; pot = SUM over
     ALL sponsors (removed-for-abuse money stays in the pool). A reversed
     chargeback drops out of both sums automatically.

   Payments are behind an interface (buildgames-payments.js): admin-entry is
   the launch impl; a processor webhook slots in later. Checkout stays dark
   until the entity/processor decision lands. */
import { randomBytes } from 'node:crypto';
import { canonicalUrl, registrableHost } from './challenge.js';

/* ---------- config ---------- */

const envTime = (name) => {
  const v = process.env[name];
  if (!v) return null;
  const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  return Number.isFinite(n) ? n : null;
};

// Countdown target: New York local midnight, Sept 1 (EDT = 04:00 UTC).
export const gamesStartAt = () => envTime('BUILDGAMES_START_AT') ?? Date.UTC(2026, 8, 1, 4, 0, 0);

// Build window close: New York local midnight, Oct 1 (EDT = 04:00 UTC).
export const gamesEndAt = () => envTime('BUILDGAMES_END_AT') ?? Date.UTC(2026, 9, 1, 4, 0, 0);

/* The midnight flip. The page renders the pre-game (sponsor hype) layout
   until the start moment PASSES, then the game layout — a server-side time
   check per request, no cron, no manual flip. The client countdown reloads
   the page at zero, so open tabs flip themselves too. */
export const gamesStarted = (now = Date.now()) => now >= gamesStartAt();

// Entries are accepted only inside the build window.
export const entriesOpen = (now = Date.now()) => now >= gamesStartAt() && now < gamesEndAt();

/* ---------- game copy — THE editable block ----------
   Operator: final wording lands here and nowhere else. Every string below is
   a placeholder until the theme/category/judging copy is decided; the page
   renders whatever these say. Judge bios arrive from research — swap the
   BIO_1/2/3 placeholders for one-liners. */

// Winners announcement date (operator decision, changeable) — ONE string.
// Announcement only: no payout-date promise anywhere, verification timing
// lives in the terms.
export const ANNOUNCE_BY = 'October 15';

export const THEME_ONE_LINER = 'Build a working replacement for something people pay for.';

// Sub-line under the theme; the whole line links to / (the death list).
export const THEME_SUB = 'Need an idea? The death list is 1,100 of them.';

/* THE CANONICAL MONEY SENTENCE (operator's exact wording, Aug 31). Used
   VERBATIM wherever the money is explained — hero, builders page, submission
   form, meta descriptions. Naming scheme it anchors: the big on-screen gross
   number is the SPONSORSHIP POOL; the PRIZE FUND is what this sentence
   defines. ⛔ The words 'admin fees'/'administration costs' are BANNED on
   every public surface. */
export const MONEY_SENTENCE =
  'The prize fund is 100% of the sponsorship money, less any third-party payment processing fees (such as Stripe), and none of the sponsorship money goes to us.';

// Three prize categories — the fund splits evenly, one winner each. Each
// carries its published judging basis (rendered on the tile).
export const CATEGORIES = [
  {
    name: 'Best Replacement',
    line: 'the build most likely to make someone cancel a real subscription',
    judged: "does it actually replace the paid product's core job, and would a real user switch?",
  },
  {
    name: 'Most Creative',
    line: 'the build nobody saw coming',
    judged: 'originality of the idea and of how it was built.',
  },
  {
    name: 'Most Polished',
    line: 'the one that feels like a finished product, not a demo',
    judged: 'design, reliability, and completeness of the shipped thing.',
  },
];

// The judges' panel — FINAL copy (operator punch list, Aug 31): NAME first
// (first names only where that is all the persona uses), @handle secondary
// in muted small type beneath, bios as sent, and NO disclosure line under
// any judge (operator's standing decision). Portraits are self-hosted under
// public/thebuildgames/judges/ (never hotlinked).
export const JUDGES = [
  { name: 'Tony Dinh', handle: 'tdinh_me', url: 'https://x.com/tdinh_me', img: '/thebuildgames/judges/tdinh_me.jpg', bio: 'founder of TypingMind and DevUtils' },
  { name: 'Dudu', handle: 'dudufolio', url: 'https://x.com/dudufolio', img: '/thebuildgames/judges/dudufolio.jpg', bio: 'founder of Toolfolio and Shotbase' },
  { name: 'Andrej', handle: 'scheemunai', url: 'https://x.com/scheemunai', img: '/thebuildgames/judges/scheemunai.jpg', bio: 'founder of CRHQ and TranscriptAPI' },
];

// The note beside the judges heading. Heading stays 'the judges'; describing
// the panel as judging independently is operator-cleared (Aug 31 — the judge
// @scheemunai and the board sponsor AndreBaltazar are different people, no
// sponsor-judge conflict exists).
export const JUDGES_NOTE = 'judging independently on published criteria · sponsors never judge';

// Post-entry recommendation card (cross-promo). One card, one outbound link,
// server-counted via /api/thebuildgames/rec. URL VERIFIED (parent, Aug 31):
// Ruben's actual 'How to AI' Substack — howtoai.com is a stranger's site and
// must never come back.
export const HOWTOAI_REC = {
  name: 'How to AI',
  url: 'https://rubenhassid.substack.com',
  line: 'The newsletter we actually read to get better at building with AI.',
};

// Public bidding accepts submissions only when this is on. Off = the board
// still renders (admin can seed) but the CTA reads "opening soon" and the
// submit endpoint 409s — the slip-protection state for launch morning.
export const biddingOpen = () => ['1', 'true'].includes(process.env.BUILDGAMES_BIDDING_OPEN ?? '');

/* Bid floors/ceiling are CONFIG, not constants — the operator sets them by env
   the moment the pricing call lands (restart, no code change). ENTRY gates a
   link's FIRST appearance on the board; TOPUP gates adding to a sponsor that
   has already cleared. Raising ENTRY isn't just pricing: everything below
   ~$1000 is also the report-bomb (H5) and small-payment (M4/chargeback)
   surface, so a high entry floor deletes those classes outright. Launch
   defaults: $500 entry / $250 top-up / $15k per payment (Faizan may still move
   entry to $1000 — that's the env, not code). */
const envCents = (name, fallback) => {
  const v = Math.round(Number(process.env[name]));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
export const MIN_ENTRY_CENTS = envCents('BUILDGAMES_MIN_ENTRY_CENTS', 50000);
export const MIN_TOPUP_CENTS = envCents('BUILDGAMES_MIN_TOPUP_CENTS', 25000);
export const MAX_BID_CENTS = envCents('BUILDGAMES_MAX_BID_CENTS', 1_500_000);

/* ---------- uncapped asymptotic fill (never 100%) ---------- */

const FILL_SCALE_CENTS = () => envTime('BUILDGAMES_FILL_SCALE_CENTS') ?? 2_500_000; // $25k
const MAX_FILL = 0.9;
const FILL_FLOOR = 0.03;

export function fillLevel(potCents) {
  if (potCents <= 0) return 0;
  const scale = FILL_SCALE_CENTS();
  return Math.min(MAX_FILL, Math.max(FILL_FLOOR, MAX_FILL * (potCents / (potCents + scale))));
}

/* ---------- ids ---------- */

const ID_ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789';
const mkId = (prefix) => `${prefix}_${[...randomBytes(10)].map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('')}`;
export const newSponsorId = () => mkId('bgs');
export const newPaymentId = () => mkId('bgp');
export const newEntryId = () => mkId('bge');
export const SPONSOR_ID_RE = /^bgs_[a-z2-9]{10}$/;
export const PAYMENT_ID_RE = /^bgp_[a-z2-9]{10}$/;

/* ---------- identity + input hygiene ---------- */

// Tracking params that must NOT split one brand into many identities (M4).
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'ref', 'referrer', 'fbclid', 'gclid', 'mc_eid', 'mc_cid', 'igshid', 'yclid', '_hsenc', '_hsmi',
]);

/* The identity key for a sponsor. Beyond canonicalUrl (lowercase host, no
   fragment, sorted value-bearing query), this ALSO strips a leading www.,
   drops tracking params, and collapses /index.html — so one brand can't be
   split into N rows (or N leaderboard slots for N×$5) via cosmetic URL
   variants, and cumulative top-ups from slightly different links still merge
   (audit M4). Kept separate from canonicalUrl, which the challenge relies on. */
export function sponsorIdentity(url) {
  const u = new URL(url.href);
  u.hostname = u.hostname.replace(/^www\./i, '');
  u.pathname = u.pathname.replace(/\/index\.html?$/i, '/');
  for (const k of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(k.toLowerCase())) u.searchParams.delete(k);
  }
  return canonicalUrl(u);
}

export { registrableHost };

/* Platforms where identity lives in the PATH, not the host: two different
   profiles on x.com are two different sponsors. The one-placement-per-host
   rule (M4) exists so one brand can't split into N board rows; on these hosts
   the brand IS the profile, so the host guard would block unrelated sponsors
   instead. Identity stays the full profile URL (sponsorIdentity keeps the
   path), so the SAME profile submitted again still merges as a top-up. */
const PATH_IDENTITY_HOSTS = new Set([
  'x.com',
  'twitter.com',
  'github.com',
  'instagram.com',
  'facebook.com',
  'youtube.com',
  'tiktok.com',
  'linkedin.com',
  'twitch.tv',
  'bsky.app',
  'threads.net',
]);
export function pathIdentityHost(hostname) {
  return PATH_IDENTITY_HOSTS.has(String(hostname || '').replace(/^www\./i, '').toLowerCase());
}

const UNSAFE_GLYPHS = /[​-‏‪-‮⁠-⁯﻿]/g;
const URL_ISH = /(https?:\/\/|www\.|[a-z0-9-]+\.[a-z]{2,}(\/|\b))/i;

// Board taglines get more room than sponsor cards (a row, not a chip).
// 140 = the measured two-line capacity of the desktop tagline column
// (553px at ~7.8px/char = 70 chars/line); past it the 2-line clamp cuts.
export const TAGLINE_MAX = 140;

// Display name cap — matches the sponsor-card name limit; the row's line 1.
export const NAME_MAX = 40;

/* Same hygiene as taglines minus the URL rejection: names like "acme.io" are
   legitimate, and the name only renders as text inside the sponsor's own
   screened link. */
export function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw
    .replace(/[<>]/g, '')
    .replace(UNSAFE_GLYPHS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
  return t.length >= 2 ? t : null;
}

/* Clean a public tagline: strip markup chars and bidi/zero-width glyphs,
   collapse whitespace, cap length. Returns null if it's empty or contains a
   URL (links belong in the entry link, which is screened; a URL in the
   tagline would be an unscreened link on a high-traffic page). */
export function cleanTagline(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw
    .replace(/[<>]/g, '')
    .replace(UNSAFE_GLYPHS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TAGLINE_MAX);
  if (t.length < 2) return null;
  if (URL_ISH.test(t)) return null;
  return t;
}

/* ---------- entry input hygiene ---------- */

// Entry blurb: same hygiene as taglines (markup chars, bidi/zero-width glyphs,
// whitespace collapse, length cap) with its own cap. URLs are allowed — the
// blurb renders only as escaped TEXT, and the entry's links live in their own
// screened fields.
export const BLURB_MAX = 200;

export function cleanBlurb(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw
    .replace(/[<>]/g, '')
    .replace(UNSAFE_GLYPHS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, BLURB_MAX);
  return t.length >= 2 ? t : null;
}

// Builder handle (optional): an @-handle-ish string, leading @ folded off.
export function cleanHandle(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().replace(/^@/, '');
  return /^[a-zA-Z0-9_.-]{2,40}$/.test(t) ? t : null;
}

/* Entry repo URL: exactly https://github.com/<owner>/<repo>. Takes the URL
   object parsePublicUrl produced; returns the canonical string or null.
   The commit history is the build-window evidence, so only real GitHub repos
   qualify — no pages sites, no gists, no deeper paths. */
export function parseGithubRepo(u) {
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'github.com') return null;
  const m = u.pathname.match(/^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/);
  if (!m || m[2] === '.' || m[2] === '..') return null;
  return `https://github.com/${m[1]}/${m[2]}`;
}

/* ---------- ranking (rows carry cleared_total + first_cleared_at from SQL) ---------- */

// Board order: cumulative cleared money desc, earliest first-cleared wins ties
// so a spot holds until someone's total is strictly higher.
export function rankSponsors(rows) {
  return [...rows].sort(
    (a, b) => b.cleared_total - a.cleared_total || (a.first_cleared_at ?? Infinity) - (b.first_cleared_at ?? Infinity)
  );
}

/* ---------- display ---------- */

export function usd(cents) {
  return '$' + Math.round(cents / 100).toLocaleString('en-US');
}

export function countdownParts(untilMs, now = Date.now()) {
  const s = Math.max(0, Math.floor((untilMs - now) / 1000));
  return {
    days: Math.floor(s / 86400),
    hours: Math.floor((s % 86400) / 3600),
    minutes: Math.floor((s % 3600) / 60),
    seconds: s % 60,
  };
}

// Compact relative time for board rows: "just now" → "5m ago" → "3h ago" →
// "2d ago" → "3w ago" → "4mo ago".
export function timeAgo(ms, now = Date.now()) {
  if (!ms) return '';
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 90) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 36) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 9) return `${w}w ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

export function monogram(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

// A display name: the sponsor's chosen name, else tagline, else the host.
export function displayName(sponsor) {
  if (sponsor.name) return sponsor.name;
  if (sponsor.tagline) return sponsor.tagline;
  try {
    return new URL(sponsor.link).hostname.replace(/^www\./, '');
  } catch {
    return sponsor.link;
  }
}
