/* Builds vertical: shared vocabulary + helpers. User-facing words live here
   once so every surface says the same thing (and the jargon ban is enforced
   in one place: no "verified", ever — a build is what the maker told us). */
import { randomBytes } from 'node:crypto';

/* ---------- ids ---------- */

const ID_ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789';

export function newId(prefix) {
  const bytes = randomBytes(10);
  return `${prefix}_${[...bytes].map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('')}`;
}

export const BUILD_ID_RE = /^b_[a-z2-9]{10}$/;

/* ---------- "how many goes?" vocab ---------- */

// Self-declared, disclosed, never judged. The answer decides what the form
// asks for next: near one-shot the prompt IS the content; weeks in, the
// story of what actually got it done is; a failure only owes "where it broke".
export const GOES = {
  one: 'one shot',
  few: 'a few goes',
  weeks: 'weeks',
  never: 'never got there',
};

export const goesLabel = (build) => GOES[build.goes] ?? build.goes;

// one go / a few goes -> the exact prompt is required and displayed big.
export const promptRequired = (goes) => goes === 'one' || goes === 'few';

// weeks -> the prompt is decoration; "what actually got it done" is the meat.
export const storyRequired = (goes) => goes === 'weeks';

// Failures are publishable with nothing to link to.
export const linkRequired = (goes) => goes !== 'never';

// Curated tool list for the typeahead; free text is allowed on top.
export const TOOLS = [
  'Claude Code',
  'Codex CLI',
  'Cursor',
  'Windsurf',
  'Lovable',
  'v0',
  'Bolt',
  'Replit',
  'GitHub Copilot',
  'Devin',
  'Cline',
  'Aider',
  'none (straight API)',
];

// Platforms whose chats have no outsider-visible link (the facts box states
// this as a vendor fact, never a maker failure).
const NO_PUBLIC_CHAT = /claude code|codex|cursor|windsurf|copilot|aider|cline|none/i;

export function chatFactLine(build) {
  if (build.chat_url) return null; // the row renders the link instead
  const t = build.tool || 'this tool';
  if (!build.tool) return 'no chat link on file';
  if (NO_PUBLIC_CHAT.test(t)) return `${t} doesn't show chats to outsiders`;
  return `no chat link on file · ${t} can show one`;
}

/* ---------- display helpers ---------- */

export function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 90) return 'just now';
  const m = s / 60;
  if (m < 90) return `${Math.round(m)} min ago`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)} hour${Math.round(h) === 1 ? '' : 's'} ago`;
  const d = h / 24;
  if (d < 11) return `${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'} ago`;
  const w = d / 7;
  if (w < 5) return `${Math.round(w)} week${Math.round(w) === 1 ? '' : 's'} ago`;
  const mo = d / 30;
  if (mo < 12) return `${Math.round(mo)} month${Math.round(mo) === 1 ? '' : 's'} ago`;
  return `${Math.round(mo / 12)} year${Math.round(mo / 12) === 1 ? '' : 's'} ago`;
}

export function shortDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// The maker's claimed handle; the OAuth name only for accounts that predate
// handles (every build post claims one now).
export function builderName(names, build) {
  const u = names.get(build.user_id);
  return u?.handle || u?.name || 'a builder';
}

// Canonical build URL: /builds/<handle>/<slug>, GitHub-style owner/thing.
// The b_ id route stays as a fallback + redirect for anything unlinked.
export function buildHref(names, build) {
  const u = names.get(build.user_id);
  return u?.handle && build.slug ? `/builds/${u.handle}/${build.slug}` : `/builds/${build.id}`;
}

/* ---------- maker handles ---------- */

// Claimed once, unique case-insensitive, lives in URLs: keep it URL-plain.
export const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{2,19}$/i;

// Names that would read as the site talking, or collide with our own paths.
export const RESERVED_HANDLES = new Set([
  'admin', 'staff', 'mod', 'team', 'official', 'vibecodeit', 'cvci',
]);

// Build-name -> URL slug. Ascii-only on purpose: names are free text, URLs
// are not. Falls back to "build" when nothing survives.
export function slugifyBuildName(name) {
  const s = String(name)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return s || 'build';
}

/* ---------- URL validation (same bar as the submit pipeline) ---------- */

// Public https product URLs only: no bare hosts, no IP literals, nothing that
// could point a server-side fetch at internal services.
export function parsePublicUrl(raw, { maxLen = 300 } = {}) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > maxLen) return null;
  const withProto = /^https?:\/\//i.test(raw) ? raw.trim() : `https://${raw.trim()}`;
  let u;
  try {
    u = new URL(withProto);
  } catch {
    return null;
  }
  // A pasted http:// link gets quietly upgraded; everything we fetch or
  // publish stays https-only either way.
  if (u.protocol === 'http:') u.protocol = 'https:';
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(host)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    return null;
  }
  return u;
}
