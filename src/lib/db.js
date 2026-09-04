/* Data layer with two drivers:
   - DATABASE_URL set  → Postgres (Railway / any managed PG)
   - otherwise         → SQLite via better-sqlite3 (local dev, plain VPS)
   All exports are async so call sites don't care which driver is live. */

const PG_URL = process.env.DATABASE_URL;

const SCHEMA_SQLITE = `
  CREATE TABLE IF NOT EXISTS votes (
    slug TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS waitlist (
    email TEXT PRIMARY KEY,
    source TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sponsors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    window_start INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sponsor_slots (
    id TEXT PRIMARY KEY,
    price_cents INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sponsor_purchases (
    id TEXT PRIMARY KEY,
    slot_id TEXT NOT NULL,
    status TEXT NOT NULL,
    stripe_session_id TEXT UNIQUE,
    stripe_payment_intent TEXT,
    amount_cents INTEGER,
    email TEXT,
    details_token TEXT UNIQUE,
    name TEXT,
    tagline TEXT,
    url TEXT,
    logo_url TEXT,
    tint TEXT,
    created_at INTEGER NOT NULL,
    hold_expires_at INTEGER,
    paid_at INTEGER,
    submitted_at INTEGER,
    approved_at INTEGER,
    starts_at INTEGER,
    ends_at INTEGER,
    reminder_details_at INTEGER,
    reminder_renew_at INTEGER,
    months INTEGER
  );
  CREATE INDEX IF NOT EXISTS sponsor_purchases_status ON sponsor_purchases (status);
  CREATE TABLE IF NOT EXISTS sponsor_clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slot_id TEXT NOT NULL,
    surface TEXT,
    country TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sponsor_clicks_slot ON sponsor_clicks (slot_id, created_at);
  CREATE TABLE IF NOT EXISTS sponsor_impressions (
    slot_id TEXT NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (slot_id, day)
  );
  CREATE TABLE IF NOT EXISTS searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0,
    country TEXT,
    created_at INTEGER NOT NULL
  );

  /* Better Auth tables, exactly as \`npx auth generate\` emits them for the
     kysely/sqlite adapter (camelCase quoted columns are the adapter's own
     naming, do not snake_case them). Plus our stack table. */
  CREATE TABLE IF NOT EXISTS "user" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL UNIQUE,
    "emailVerified" INTEGER NOT NULL,
    "image" TEXT,
    "createdAt" DATE NOT NULL,
    "updatedAt" DATE NOT NULL,
    "newsletter" INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS "session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "expiresAt" DATE NOT NULL,
    "token" TEXT NOT NULL UNIQUE,
    "createdAt" DATE NOT NULL,
    "updatedAt" DATE NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("userId");
  CREATE TABLE IF NOT EXISTS "account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" DATE,
    "refreshTokenExpiresAt" DATE,
    "scope" TEXT,
    "password" TEXT,
    "createdAt" DATE NOT NULL,
    "updatedAt" DATE NOT NULL
  );
  CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("userId");
  CREATE TABLE IF NOT EXISTS "verification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" DATE NOT NULL,
    "createdAt" DATE NOT NULL,
    "updatedAt" DATE NOT NULL
  );
  CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier");
  CREATE TABLE IF NOT EXISTS "rateLimit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL UNIQUE,
    "count" INTEGER NOT NULL,
    "lastRequest" BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stack (
    user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
    app_slug TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, app_slug)
  );
  CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    app_name TEXT NOT NULL,
    app_url TEXT NOT NULL,
    take TEXT,
    submitter TEXT,
    user_id TEXT,
    status TEXT NOT NULL,
    pr_url TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS submissions_slug ON submissions (slug, status);

  /* Reader-submitted guides for the sunday newsletter. Content only: the body
     lands here as Markdown and a human reviews it at /admin/articles. Nothing
     in this table is ever rendered publicly · approval means it goes into an
     issue with the writer's byline, not that it appears on the site. */
  CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    email TEXT NOT NULL,
    link TEXT,
    summary TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    note TEXT,
    user_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS articles_status ON articles (status, created_at);

  /* Community builds: runtime state only, app/verdict content stays JSON in
     the repo. Builds land as status 'pending' and go live on admin approval.
     goes = the self-declared "how many goes?" answer (one|few|weeks|never);
     prompt is required for one/few, story for weeks, where_broke always.
     by_owner = repo owner matched the poster's GitHub login at submit time. */
  CREATE TABLE IF NOT EXISTS builds (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
    app_slug TEXT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    one_liner TEXT NOT NULL,
    goes TEXT NOT NULL,
    prompt TEXT,
    story TEXT,
    where_broke TEXT NOT NULL,
    tool TEXT NOT NULL,
    model TEXT,
    model_norm TEXT,
    demo_url TEXT,
    repo_url TEXT,
    chat_url TEXT,
    media TEXT NOT NULL DEFAULT '[]',
    affiliation TEXT,
    by_owner INTEGER NOT NULL DEFAULT 0,
    featured INTEGER NOT NULL DEFAULT 0,
    featured_note TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS builds_app ON builds (app_slug, status);
  CREATE INDEX IF NOT EXISTS builds_user ON builds (user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS builds_user_slug ON builds (user_id, slug);
  CREATE TABLE IF NOT EXISTS build_media (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    build_id TEXT,
    created_at INTEGER NOT NULL
  );

  /* Build challenges: challenge content lives in src/lib/challenge.js (the
     repo is the admin panel, same as apps); this is runtime state only.
     Entries are keyed by a self-declared X handle — future portfolio pages
     hang off it. status: live | held | unlisted. kind: entry | seed | demo. */
  CREATE TABLE IF NOT EXISTS challenge_entries (
    id TEXT PRIMARY KEY,
    challenge_id INTEGER NOT NULL,
    x_handle TEXT NOT NULL,
    url TEXT NOT NULL,
    page_title TEXT,
    og_image TEXT,
    email_opted INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'entry',
    status TEXT NOT NULL DEFAULT 'live',
    held_reason TEXT,
    report_count INTEGER NOT NULL DEFAULT 0,
    badge_hits INTEGER NOT NULL DEFAULT 0,
    country TEXT,
    created_at INTEGER NOT NULL,
    last_checked_at INTEGER,
    check_result TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS challenge_entries_url ON challenge_entries (challenge_id, url);
  CREATE INDEX IF NOT EXISTS challenge_entries_feed ON challenge_entries (challenge_id, status, created_at);
  CREATE INDEX IF NOT EXISTS challenge_entries_handle ON challenge_entries (lower(x_handle));

  /* One row per (entry, reporter) so a single IP can't run the report count
     up on its own — the auto-hold weighs DISTINCT reporters, not raw hits. */
  CREATE TABLE IF NOT EXISTS challenge_reports (
    entry_id TEXT NOT NULL,
    reporter_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (entry_id, reporter_hash)
  );

  /* Registrable hosts an admin has removed (or Safe Browsing flagged): a new
     entry on the same host is rejected before it ever lists, so re-posting
     the same site under a fresh query string can't dodge a moderation call. */
  CREATE TABLE IF NOT EXISTS challenge_blocked_hosts (
    host TEXT PRIMARY KEY,
    reason TEXT,
    created_at INTEGER NOT NULL
  );

  /* The Build Games: sponsor bidding. Identity = canonical link (one row).
     tagline/icon set by the first cleared payment, immutable via payments.
     status = active | held | removed (moderation). */
  CREATE TABLE IF NOT EXISTS buildgames_sponsors (
    id TEXT PRIMARY KEY,
    link TEXT NOT NULL UNIQUE,
    host TEXT NOT NULL,
    tagline TEXT,
    icon_url TEXT,
    status TEXT NOT NULL DEFAULT 'held',
    held_reason TEXT,
    report_count INTEGER NOT NULL DEFAULT 0,
    first_cleared_at INTEGER,
    last_checked_at INTEGER,
    check_result TEXT,
    contact_email TEXT,
    name TEXT,
    claimed_by TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS buildgames_sponsors_host ON buildgames_sponsors (host);
  /* Append-only payment ledger. status = pending | cleared | reversed. */
  /* Each payment carries the tagline + icon source PROPOSED with it. On the
     FIRST payment to clear for a sponsor, those freeze onto the sponsor row
     (first-cleared-payer sets identity, immutable thereafter). Later payments
     add money only. */
  /* Each payment carries the tagline, icon source AND the screening outcome
     PROPOSED with it. On the FIRST payment to clear for a sponsor, those
     freeze onto the sponsor row (first-cleared-payer sets identity AND the
     status is re-evaluated from THAT payment's screen — so a squatter's
     unpaid 'held' can't poison a paying sponsor's placement). Later payments
     add money only. */
  CREATE TABLE IF NOT EXISTS buildgames_payments (
    id TEXT PRIMARY KEY,
    sponsor_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    processor_ref TEXT,
    proposed_tagline TEXT,
    proposed_icon_src TEXT,
    proposed_status TEXT,
    proposed_reason TEXT,
    contact_email TEXT,
    details_token TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS buildgames_payments_sponsor ON buildgames_payments (sponsor_id, status);
  CREATE TABLE IF NOT EXISTS buildgames_reports (
    sponsor_id TEXT NOT NULL,
    reporter_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (sponsor_id, reporter_hash)
  );
  CREATE TABLE IF NOT EXISTS buildgames_blocked_hosts (
    host TEXT PRIMARY KEY,
    reason TEXT,
    created_at INTEGER NOT NULL
  );
  /* Build Games ENTRIES (the builders, not the sponsors). Not publicly
     listed yet — judging renders them later. edit_token authorises edits
     token-only (same mechanic as the payment details token), UNIQUE so the
     lookup is indexed and two entries can never share a token. */
  CREATE TABLE IF NOT EXISTS buildgames_entries (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    handle TEXT,
    demo_url TEXT NOT NULL,
    repo_url TEXT NOT NULL,
    blurb TEXT,
    contact_email TEXT NOT NULL,
    edit_token TEXT NOT NULL UNIQUE,
    newsletter_optin INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'submitted',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS buildgames_entries_email ON buildgames_entries (contact_email);
  /* One counter per recommendation card (the post-entry cross-promo):
     the outbound click is server-counted through /api/thebuildgames/rec. */
  CREATE TABLE IF NOT EXISTS buildgames_rec_clicks (
    rec TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0
  );
  /* How to AI rec layer: one counting redirect, clicks per (surface, day)
     so placements can be reported weekly. No email, no IP, nothing personal. */
  CREATE TABLE IF NOT EXISTS rec_clicks (
    src TEXT NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (src, day)
  );
  /* Impressions per (surface, day): the CTR denominator for rec_clicks. */
  CREATE TABLE IF NOT EXISTS rec_impressions (
    src TEXT NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (src, day)
  );
  /* Model showcase demos (/built-with/<model>): curated posts pulled from
     X / GitHub / YouTube / the web, media self-hosted on R2, text short and
     editable. status = live | hidden. Ordered by featured_order. */
  CREATE TABLE IF NOT EXISTS model_demos (
    id TEXT PRIMARY KEY,
    model_slug TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'x',
    source_url TEXT NOT NULL,
    source_id TEXT NOT NULL,
    author_handle TEXT,
    author_name TEXT,
    author_avatar_url TEXT,
    text TEXT,
    media_kind TEXT NOT NULL DEFAULT 'none',
    media_url TEXT,
    poster_url TEXT,
    width INTEGER,
    height INTEGER,
    featured_order INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'live',
    fetched_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS model_demos_source ON model_demos (model_slug, source, source_id);
  CREATE INDEX IF NOT EXISTS model_demos_model ON model_demos (model_slug, status, featured_order);
`;

const SCHEMA_PG = `
  CREATE TABLE IF NOT EXISTS votes (
    slug TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS waitlist (
    email TEXT PRIMARY KEY,
    source TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS sponsors (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    window_start BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sponsor_slots (
    id TEXT PRIMARY KEY,
    price_cents INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sponsor_purchases (
    id TEXT PRIMARY KEY,
    slot_id TEXT NOT NULL,
    status TEXT NOT NULL,
    stripe_session_id TEXT UNIQUE,
    stripe_payment_intent TEXT,
    amount_cents INTEGER,
    email TEXT,
    details_token TEXT UNIQUE,
    name TEXT,
    tagline TEXT,
    url TEXT,
    logo_url TEXT,
    tint TEXT,
    created_at BIGINT NOT NULL,
    hold_expires_at BIGINT,
    paid_at BIGINT,
    submitted_at BIGINT,
    approved_at BIGINT,
    starts_at BIGINT,
    ends_at BIGINT,
    reminder_details_at BIGINT,
    reminder_renew_at BIGINT,
    months INTEGER
  );
  CREATE INDEX IF NOT EXISTS sponsor_purchases_status ON sponsor_purchases (status);
  CREATE TABLE IF NOT EXISTS sponsor_clicks (
    id SERIAL PRIMARY KEY,
    slot_id TEXT NOT NULL,
    surface TEXT,
    country TEXT,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sponsor_clicks_slot ON sponsor_clicks (slot_id, created_at);
  CREATE TABLE IF NOT EXISTS sponsor_impressions (
    slot_id TEXT NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (slot_id, day)
  );
  CREATE TABLE IF NOT EXISTS searches (
    id SERIAL PRIMARY KEY,
    query TEXT NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0,
    country TEXT,
    created_at BIGINT NOT NULL
  );

  /* Better Auth tables (kysely/postgres dialect: text / boolean / timestamptz,
     camelCase quoted columns are the adapter's own naming, do not snake_case
     them). Plus our stack table. */
  CREATE TABLE IF NOT EXISTS "user" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL UNIQUE,
    "emailVerified" BOOLEAN NOT NULL,
    "image" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "newsletter" BOOLEAN NOT NULL
  );
  CREATE TABLE IF NOT EXISTS "session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "token" TEXT NOT NULL UNIQUE,
    "createdAt" TIMESTAMPTZ NOT NULL,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("userId");
  CREATE TABLE IF NOT EXISTS "account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ,
    "refreshTokenExpiresAt" TIMESTAMPTZ,
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL,
    "updatedAt" TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("userId");
  CREATE TABLE IF NOT EXISTS "verification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL,
    "updatedAt" TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier");
  CREATE TABLE IF NOT EXISTS "rateLimit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL UNIQUE,
    "count" INTEGER NOT NULL,
    "lastRequest" BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stack (
    user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
    app_slug TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, app_slug)
  );
  CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    app_name TEXT NOT NULL,
    app_url TEXT NOT NULL,
    take TEXT,
    submitter TEXT,
    user_id TEXT,
    status TEXT NOT NULL,
    pr_url TEXT,
    error TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS submissions_slug ON submissions (slug, status);

  /* Reader-submitted guides (same notes as the SQLite schema). */
  CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    email TEXT NOT NULL,
    link TEXT,
    summary TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    note TEXT,
    user_id TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS articles_status ON articles (status, created_at);

  /* Community builds (same notes as the SQLite schema). */
  CREATE TABLE IF NOT EXISTS builds (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
    app_slug TEXT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    one_liner TEXT NOT NULL,
    goes TEXT NOT NULL,
    prompt TEXT,
    story TEXT,
    where_broke TEXT NOT NULL,
    tool TEXT NOT NULL,
    model TEXT,
    model_norm TEXT,
    demo_url TEXT,
    repo_url TEXT,
    chat_url TEXT,
    media TEXT NOT NULL DEFAULT '[]',
    affiliation TEXT,
    by_owner INTEGER NOT NULL DEFAULT 0,
    featured INTEGER NOT NULL DEFAULT 0,
    featured_note TEXT,
    status TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS builds_app ON builds (app_slug, status);
  CREATE INDEX IF NOT EXISTS builds_user ON builds (user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS builds_user_slug ON builds (user_id, slug);
  CREATE TABLE IF NOT EXISTS build_media (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    build_id TEXT,
    created_at BIGINT NOT NULL
  );

  /* Build challenges: content in src/lib/challenge.js, runtime state here.
     See the SQLite schema for the field notes. */
  CREATE TABLE IF NOT EXISTS challenge_entries (
    id TEXT PRIMARY KEY,
    challenge_id INTEGER NOT NULL,
    x_handle TEXT NOT NULL,
    url TEXT NOT NULL,
    page_title TEXT,
    og_image TEXT,
    email_opted INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'entry',
    status TEXT NOT NULL DEFAULT 'live',
    held_reason TEXT,
    report_count INTEGER NOT NULL DEFAULT 0,
    badge_hits INTEGER NOT NULL DEFAULT 0,
    country TEXT,
    created_at BIGINT NOT NULL,
    last_checked_at BIGINT,
    check_result TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS challenge_entries_url ON challenge_entries (challenge_id, url);
  CREATE INDEX IF NOT EXISTS challenge_entries_feed ON challenge_entries (challenge_id, status, created_at);
  CREATE INDEX IF NOT EXISTS challenge_entries_handle ON challenge_entries (lower(x_handle));

  CREATE TABLE IF NOT EXISTS challenge_reports (
    entry_id TEXT NOT NULL,
    reporter_hash TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (entry_id, reporter_hash)
  );
  CREATE TABLE IF NOT EXISTS challenge_blocked_hosts (
    host TEXT PRIMARY KEY,
    reason TEXT,
    created_at BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS buildgames_sponsors (
    id TEXT PRIMARY KEY,
    link TEXT NOT NULL UNIQUE,
    host TEXT NOT NULL,
    tagline TEXT,
    icon_url TEXT,
    status TEXT NOT NULL DEFAULT 'held',
    held_reason TEXT,
    report_count INTEGER NOT NULL DEFAULT 0,
    first_cleared_at BIGINT,
    last_checked_at BIGINT,
    check_result TEXT,
    contact_email TEXT,
    name TEXT,
    claimed_by TEXT,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS buildgames_sponsors_host ON buildgames_sponsors (host);
  CREATE TABLE IF NOT EXISTS buildgames_payments (
    id TEXT PRIMARY KEY,
    sponsor_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    processor_ref TEXT,
    proposed_tagline TEXT,
    proposed_icon_src TEXT,
    proposed_status TEXT,
    proposed_reason TEXT,
    contact_email TEXT,
    details_token TEXT,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS buildgames_payments_sponsor ON buildgames_payments (sponsor_id, status);
  CREATE TABLE IF NOT EXISTS buildgames_reports (
    sponsor_id TEXT NOT NULL,
    reporter_hash TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (sponsor_id, reporter_hash)
  );
  CREATE TABLE IF NOT EXISTS buildgames_blocked_hosts (
    host TEXT PRIMARY KEY,
    reason TEXT,
    created_at BIGINT NOT NULL
  );
  /* Build Games ENTRIES — see the sqlite schema comment. */
  CREATE TABLE IF NOT EXISTS buildgames_entries (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    handle TEXT,
    demo_url TEXT NOT NULL,
    repo_url TEXT NOT NULL,
    blurb TEXT,
    contact_email TEXT NOT NULL,
    edit_token TEXT NOT NULL UNIQUE,
    newsletter_optin INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'submitted',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS buildgames_entries_email ON buildgames_entries (contact_email);
  CREATE TABLE IF NOT EXISTS buildgames_rec_clicks (
    rec TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS rec_clicks (
    src TEXT NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (src, day)
  );
  CREATE TABLE IF NOT EXISTS rec_impressions (
    src TEXT NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (src, day)
  );
  CREATE TABLE IF NOT EXISTS model_demos (
    id TEXT PRIMARY KEY,
    model_slug TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'x',
    source_url TEXT NOT NULL,
    source_id TEXT NOT NULL,
    author_handle TEXT,
    author_name TEXT,
    author_avatar_url TEXT,
    text TEXT,
    media_kind TEXT NOT NULL DEFAULT 'none',
    media_url TEXT,
    poster_url TEXT,
    width INTEGER,
    height INTEGER,
    featured_order INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'live',
    fetched_at BIGINT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS model_demos_source ON model_demos (model_slug, source, source_id);
  CREATE INDEX IF NOT EXISTS model_demos_model ON model_demos (model_slug, status, featured_order);
`;

/* Ten fixed slots, five per rail side. Seed prices only — editable at runtime.
   These INSERTs are ON CONFLICT DO NOTHING, so they set the price of a slot
   exactly once, when its row is first created: an existing board's prices are
   never overwritten by a deploy. To reprice a live board, use the admin form or
   `node scripts/set-slot-prices.mjs`.

   Ladder repriced 2026-09-04 (operator): $199 for L1, rising $50 a slot down
   the board as it renders — the whole left rail, then the whole right. */
export const SLOT_SEED = [
  ['L1', 19900],
  ['L2', 24900],
  ['L3', 29900],
  ['L4', 34900],
  ['L5', 39900],
  ['R1', 44900],
  ['R2', 49900],
  ['R3', 54900],
  ['R4', 59900],
  ['R5', 64900],
];

// Everything the slot-blocked predicate and the board care about. Anything else
// (expired, rejected, refunded_conflict, expired_hold) frees the slot.
const ACTIVE_STATUSES = ['hold', 'paid', 'submitted', 'reject_failed', 'live'];

// Whitelist: field names reach SQL as identifiers, so they can never come from a
// request body unchecked.
const PURCHASE_FIELDS = [
  'slot_id', 'status', 'stripe_session_id', 'stripe_payment_intent', 'amount_cents',
  'email', 'name', 'tagline', 'url', 'logo_url', 'tint', 'hold_expires_at', 'paid_at',
  'submitted_at', 'approved_at', 'starts_at', 'ends_at', 'reminder_details_at',
  'reminder_renew_at', 'reminder_offer_at', 'months',
];

const NUMERIC_COLUMNS = [
  'amount_cents', 'created_at', 'hold_expires_at', 'paid_at', 'submitted_at',
  'approved_at', 'starts_at', 'ends_at', 'reminder_details_at', 'reminder_renew_at',
  'reminder_offer_at', 'months',
];

// Postgres hands BIGINT back as a string; the rest of the code does date maths.
function purchaseRow(row) {
  if (!row) return null;
  const out = { ...row };
  for (const c of NUMERIC_COLUMNS) out[c] = out[c] == null ? null : Number(out[c]);
  return out;
}

function updateParts(fields) {
  const keys = Object.keys(fields).filter((k) => PURCHASE_FIELDS.includes(k));
  if (keys.length === 0) throw new Error('updatePurchase: no writable fields');
  return keys;
}

// Same rule for lookups: purchaseBy interpolates the column name, so it only
// accepts the three identifiers the exported helpers actually use.
const PURCHASE_LOOKUP_COLS = ['id', 'stripe_session_id', 'details_token'];

// Submission columns the pipeline may rewrite after insert. Same rule as
// PURCHASE_FIELDS: names reach SQL as identifiers, never from a request body.
const SUBMISSION_FIELDS = ['status', 'pr_url', 'error', 'updated_at'];

function submissionParts(fields) {
  const keys = Object.keys(fields).filter((k) => SUBMISSION_FIELDS.includes(k));
  if (keys.length === 0) throw new Error('updateSubmission: no writable fields');
  return keys;
}

// Statuses that mean "this slug is already being worked": a second visitor
// submitting the same app while these are live gets a duplicate answer.
// Time-bounded: a pipeline killed mid-run (deploy, crash) leaves its row in a
// non-terminal status forever, and without the cutoff that slug could never be
// submitted again. Matches the API route's 10-minute stall horizon.
const SUBMISSION_OPEN_STATUSES = ['queued', 'drafting', 'opening'];
const SUBMISSION_STALL_MS = 10 * 60 * 1000;

function lookupCol(column) {
  if (!PURCHASE_LOOKUP_COLS.includes(column)) {
    throw new Error(`purchaseBy: invalid column: ${column}`);
  }
  return column;
}

// Build columns the admin surface may rewrite after insert. Same rule as
// PURCHASE_FIELDS: names reach SQL as identifiers, never from a request body.
const BUILD_FIELDS = [
  'status', 'featured', 'featured_note', 'model_norm', 'media', 'og_image', 'updated_at',
];

function buildParts(fields) {
  const keys = Object.keys(fields).filter((k) => BUILD_FIELDS.includes(k));
  if (keys.length === 0) throw new Error('updateBuild: no writable fields');
  return keys;
}

// Postgres hands BIGINT back as strings; the pages do date maths on these.
const BUILD_NUMERIC = ['created_at', 'updated_at'];

function numericRow(cols) {
  return (row) => {
    if (!row) return null;
    const out = { ...row };
    for (const c of cols) out[c] = out[c] == null ? null : Number(out[c]);
    return out;
  };
}

const buildRow = numericRow(BUILD_NUMERIC);

/* Challenge entries: writable fields for updates, BIGINT columns for the
   PG string → number fix. Counters (report_count, badge_hits) are bumped by
   dedicated atomic methods, never through update. */
const CH_ENTRY_FIELDS = [
  'status', 'held_reason', 'kind', 'page_title', 'og_image',
  'last_checked_at', 'check_result',
];

function chParts(fields) {
  const keys = Object.keys(fields).filter((k) => CH_ENTRY_FIELDS.includes(k));
  if (keys.length === 0) throw new Error('updateChallengeEntry: no writable fields');
  return keys;
}

const chRow = numericRow(['created_at', 'last_checked_at']);

/* Build Games sponsors: writable fields for admin/moderation updates, and the
   BIGINT columns for the PG string→number fix. cleared_total/pending_total are
   query-computed and coerced here too when present. */
const BG_SPONSOR_FIELDS = ['status', 'held_reason', 'tagline', 'icon_url', 'first_cleared_at', 'last_checked_at', 'check_result', 'name'];

function bgSponsorParts(fields) {
  const keys = Object.keys(fields).filter((k) => BG_SPONSOR_FIELDS.includes(k));
  if (keys.length === 0) throw new Error('updateBgSponsor: no writable fields');
  return keys;
}

function bgSponsorRow(row) {
  if (!row) return null;
  const out = { ...row };
  for (const c of ['first_cleared_at', 'last_checked_at', 'created_at', 'report_count', 'click_count', 'cleared_total', 'pending_total']) {
    if (out[c] != null) out[c] = Number(out[c]);
  }
  return out;
}

/* Build Games entries: writable fields for the token-authorised edit path,
   and the BIGINT columns for the PG string→number fix. Same rule as
   PURCHASE_FIELDS: names reach SQL as identifiers, never from a request. */
const BG_ENTRY_FIELDS = ['name', 'handle', 'demo_url', 'repo_url', 'blurb', 'newsletter_optin', 'status', 'updated_at'];

function bgEntryParts(fields) {
  const keys = Object.keys(fields).filter((k) => BG_ENTRY_FIELDS.includes(k));
  if (keys.length === 0) throw new Error('updateBgEntry: no writable fields');
  return keys;
}

const bgEntryRow = numericRow(['created_at', 'updated_at', 'newsletter_optin']);

/* Model demos: writable fields for the curation API, BIGINT coercion. */
const MD_FIELDS = [
  'author_handle', 'author_name', 'author_avatar_url', 'text', 'media_kind', 'media_url',
  'poster_url', 'width', 'height', 'featured_order', 'status', 'fetched_at', 'updated_at',
];
const MD_COLS = [
  'id', 'model_slug', 'source', 'source_url', 'source_id', 'author_handle', 'author_name',
  'author_avatar_url', 'text', 'media_kind', 'media_url', 'poster_url', 'width', 'height',
  'featured_order', 'status', 'fetched_at', 'created_at', 'updated_at',
];
function mdParts(fields) {
  const keys = Object.keys(fields).filter((k) => MD_FIELDS.includes(k));
  if (keys.length === 0) throw new Error('updateModelDemo: no writable fields');
  return keys;
}
const mdRow = numericRow(['width', 'height', 'featured_order', 'fetched_at', 'created_at', 'updated_at']);

let driver;

/* Raw connection handles, shared between the query driver below and Better
   Auth (which wants the pg Pool / better-sqlite3 Database instance itself).
   One pool, one sqlite handle, never two connections to the same store. */
let pgPool;
async function rawPgPool() {
  if (!pgPool) {
    const { default: pg } = await import('pg');
    pgPool = new pg.Pool({ connectionString: PG_URL, max: 5 });
  }
  return pgPool;
}

let sqliteDb;
async function rawSqliteDb() {
  if (!sqliteDb) {
    const { default: Database } = await import('better-sqlite3');
    const { mkdirSync } = await import('node:fs');
    const path = await import('node:path');
    const dir = process.env.DATA_DIR || 'data/private';
    mkdirSync(dir, { recursive: true });
    sqliteDb = new Database(path.join(dir, 'site.db'));
    sqliteDb.pragma('journal_mode = WAL');
  }
  return sqliteDb;
}

/* For Better Auth: the raw handle, guaranteed post-schema (getDriver applies
   the schema, including the auth tables). */
export async function authDatabase() {
  await getDriver();
  return PG_URL ? rawPgPool() : rawSqliteDb();
}

async function pgDriver() {
  const pool = await rawPgPool();
  await pool.query(SCHEMA_PG);
  // A NULL source means the row predates per-placement tracking: scanner era.
  await pool.query('ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS source TEXT');
  // Quarter deals: how many 30-day runs one payment covers (NULL = 1).
  await pool.query('ALTER TABLE sponsor_purchases ADD COLUMN IF NOT EXISTS months INTEGER');
  // What the slot's NEXT run is doing: pending | open | reserved. "Taken" is
  // never stored — it's derived from a future-dated purchase existing.
  await pool.query('ALTER TABLE sponsor_slots ADD COLUMN IF NOT EXISTS next_state TEXT');
  // The slot's private next-run offer price for its current occupant (cents).
  await pool.query('ALTER TABLE sponsor_slots ADD COLUMN IF NOT EXISTS renewal_price_cents INTEGER');
  // When the automated next-run offer email went out for a purchase.
  await pool.query('ALTER TABLE sponsor_purchases ADD COLUMN IF NOT EXISTS reminder_offer_at BIGINT');
  // Maker handle: claimed once at first build post, unique case-insensitive,
  // shown (and used in /builds URLs) instead of the OAuth display name.
  await pool.query('ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "handle" TEXT');
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS user_handle_unique ON "user" (lower("handle"))'
  );
  // Share card for an approved build, generated at approval and stored on R2.
  await pool.query('ALTER TABLE builds ADD COLUMN IF NOT EXISTS og_image TEXT');
  // Moderation: a pinned row's count is frozen. Votes still get a normal 200
  // so vote-stuffers see nothing, but nothing is written.
  await pool.query('ALTER TABLE votes ADD COLUMN IF NOT EXISTS pinned INTEGER NOT NULL DEFAULT 0');
  // Build Games columns added after the tables first shipped (N1): a table
  // created by an earlier schema is missing them and every bid would 500.
  await pool.query('ALTER TABLE buildgames_sponsors ADD COLUMN IF NOT EXISTS last_checked_at BIGINT');
  await pool.query('ALTER TABLE buildgames_sponsors ADD COLUMN IF NOT EXISTS check_result TEXT');
  await pool.query('ALTER TABLE buildgames_sponsors ADD COLUMN IF NOT EXISTS contact_email TEXT');
  await pool.query('ALTER TABLE buildgames_payments ADD COLUMN IF NOT EXISTS proposed_tagline TEXT');
  await pool.query('ALTER TABLE buildgames_payments ADD COLUMN IF NOT EXISTS proposed_icon_src TEXT');
  await pool.query('ALTER TABLE buildgames_payments ADD COLUMN IF NOT EXISTS proposed_status TEXT');
  await pool.query('ALTER TABLE buildgames_payments ADD COLUMN IF NOT EXISTS proposed_reason TEXT');
  await pool.query('ALTER TABLE buildgames_payments ADD COLUMN IF NOT EXISTS contact_email TEXT');
  await pool.query('ALTER TABLE buildgames_payments ADD COLUMN IF NOT EXISTS details_token TEXT');
  await pool.query('ALTER TABLE buildgames_sponsors ADD COLUMN IF NOT EXISTS name TEXT');
  await pool.query('ALTER TABLE buildgames_sponsors ADD COLUMN IF NOT EXISTS claimed_by TEXT');
  // Public click counter for board rows (social proof for buyers).
  await pool.query('ALTER TABLE buildgames_sponsors ADD COLUMN IF NOT EXISTS click_count INTEGER NOT NULL DEFAULT 0');
  // H4.2: one processor capture clears exactly one payment — a replayed or
  // cross-wired webhook citing an already-used ref must fail loudly, not
  // double-credit. Legacy 'admin' refs are first made unique so the index can
  // build; NULL refs (pending rows) stay exempt.
  await pool.query("UPDATE buildgames_payments SET processor_ref = 'admin:' || id WHERE processor_ref = 'admin'");
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS buildgames_payments_ref ON buildgames_payments (processor_ref) WHERE processor_ref IS NOT NULL'
  );
  await pool.query("UPDATE waitlist SET source = 'scanner' WHERE source IS NULL");
  for (const [id, cents] of SLOT_SEED) {
    await pool.query(
      'INSERT INTO sponsor_slots (id, price_cents) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [id, cents]
    );
  }
  return {
    async voteCount(slug) {
      const r = await pool.query('SELECT count FROM votes WHERE slug = $1', [slug]);
      return r.rows[0]?.count ?? 0;
    },
    async allVotes() {
      const r = await pool.query('SELECT slug, count FROM votes');
      return r.rows;
    },
    async addVote(slug) {
      const r = await pool.query(
        `INSERT INTO votes (slug, count) VALUES ($1, 1)
         ON CONFLICT (slug) DO UPDATE
           SET count = CASE WHEN votes.pinned = 1 THEN votes.count ELSE votes.count + 1 END
         RETURNING count`,
        [slug]
      );
      return r.rows[0].count;
    },
    async removeVote(slug) {
      const r = await pool.query(
        `UPDATE votes SET count = GREATEST(count - 1, 0) WHERE slug = $1 AND pinned = 0 RETURNING count`,
        [slug]
      );
      return r.rows[0]?.count ?? 0;
    },
    // Atomically spend a live rate-limit key: true only for the one caller
    // that got to delete it. Checking and clearing as two statements let two
    // concurrent unvotes both see the same key and both decrement.
    async consumeRateLimit(key, windowMs) {
      const r = await pool.query(
        'DELETE FROM rate_limits WHERE key = $1 AND window_start >= $2 RETURNING key',
        [key, Date.now() - windowMs]
      );
      return r.rowCount > 0;
    },
    async addEmail(email, source) {
      const r = await pool.query(
        'INSERT INTO waitlist (email, source) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [email, source]
      );
      return r.rowCount > 0;
    },
    async addSponsor(email, message) {
      await pool.query('INSERT INTO sponsors (email, message) VALUES ($1, $2)', [
        email,
        message,
      ]);
    },
    async rateLimit(key, max, windowMs) {
      const now = Date.now();
      const r = await pool.query('SELECT count, window_start FROM rate_limits WHERE key = $1', [key]);
      const row = r.rows[0];
      if (!row || now - Number(row.window_start) > windowMs) {
        await pool.query(
          `INSERT INTO rate_limits (key, count, window_start) VALUES ($1, 1, $2)
           ON CONFLICT (key) DO UPDATE SET count = 1, window_start = $2`,
          [key, now]
        );
        return true;
      }
      if (row.count >= max) return false;
      await pool.query('UPDATE rate_limits SET count = count + 1 WHERE key = $1', [key]);
      return true;
    },
    async sponsorSlots() {
      const r = await pool.query(
        'SELECT id, price_cents, next_state, renewal_price_cents FROM sponsor_slots ORDER BY id'
      );
      return r.rows.map((s) => ({
        id: s.id,
        price_cents: Number(s.price_cents),
        next_state: s.next_state ?? null,
        renewal_price_cents: s.renewal_price_cents == null ? null : Number(s.renewal_price_cents),
      }));
    },
    async waitlistEmails(source) {
      const r = await pool.query('SELECT email FROM waitlist WHERE source = $1 ORDER BY created_at', [source]);
      return r.rows.map((x) => x.email);
    },
    async setSlotPrice(id, cents) {
      const r = await pool.query('UPDATE sponsor_slots SET price_cents = $2 WHERE id = $1', [id, cents]);
      return r.rowCount > 0;
    },
    async setSlotNextState(id, state) {
      const r = await pool.query('UPDATE sponsor_slots SET next_state = $2 WHERE id = $1', [id, state]);
      return r.rowCount > 0;
    },
    async insertPurchase(p) {
      await pool.query(
        `INSERT INTO sponsor_purchases
           (id, slot_id, status, amount_cents, months, details_token, created_at, hold_expires_at, stripe_session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [p.id, p.slot_id, p.status, p.amount_cents, p.months ?? 1, p.details_token, p.created_at, p.hold_expires_at, p.stripe_session_id ?? null]
      );
    },
    async activePurchases() {
      const r = await pool.query(
        'SELECT * FROM sponsor_purchases WHERE status = ANY($1) ORDER BY created_at, id',
        [ACTIVE_STATUSES]
      );
      return r.rows.map(purchaseRow);
    },
    async purchaseBy(column, value) {
      const r = await pool.query(`SELECT * FROM sponsor_purchases WHERE ${lookupCol(column)} = $1`, [value]);
      return purchaseRow(r.rows[0]);
    },
    async updatePurchase(id, fields, whereStatusIn) {
      const keys = updateParts(fields);
      const params = [id, ...keys.map((k) => fields[k])];
      let sql = `UPDATE sponsor_purchases SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`;
      if (whereStatusIn) {
        params.push(whereStatusIn);
        sql += ` AND status = ANY($${params.length})`;
      }
      const r = await pool.query(sql, params);
      return r.rowCount;
    },
    async purchasesForAdmin(limit) {
      const r = await pool.query(
        'SELECT * FROM sponsor_purchases ORDER BY created_at DESC LIMIT $1',
        [limit]
      );
      return r.rows.map(purchaseRow);
    },
    async addSponsorClick(slotId, surface, country, ts) {
      await pool.query(
        'INSERT INTO sponsor_clicks (slot_id, surface, country, created_at) VALUES ($1, $2, $3, $4)',
        [slotId, surface, country, ts]
      );
    },
    async sponsorClickRows(sinceMs) {
      const r = await pool.query(
        `SELECT slot_id, surface, country, created_at FROM sponsor_clicks
         WHERE created_at >= $1 ORDER BY created_at DESC`,
        [sinceMs]
      );
      return r.rows.map((x) => ({ ...x, created_at: Number(x.created_at) }));
    },
    async bumpImpressions(entries) {
      for (const e of entries) {
        await pool.query(
          `INSERT INTO sponsor_impressions (slot_id, day, count) VALUES ($1, $2, $3)
           ON CONFLICT (slot_id, day)
           DO UPDATE SET count = sponsor_impressions.count + EXCLUDED.count`,
          [e.slot_id, e.day, e.count]
        );
      }
    },
    async impressionRows(sinceDay) {
      const r = await pool.query(
        'SELECT slot_id, day, count FROM sponsor_impressions WHERE day >= $1 ORDER BY day',
        [sinceDay]
      );
      return r.rows.map((x) => ({ ...x, count: Number(x.count) }));
    },
    async addSearch(query, hits, country, ts) {
      await pool.query(
        'INSERT INTO searches (query, hits, country, created_at) VALUES ($1, $2, $3, $4)',
        [query, hits, country, ts]
      );
    },
    async searchRows(afterId, limit) {
      const r = await pool.query(
        'SELECT id, query, hits, country, created_at FROM searches WHERE id > $1 ORDER BY id LIMIT $2',
        [afterId, limit]
      );
      return r.rows.map((x) => ({ ...x, id: Number(x.id), created_at: Number(x.created_at) }));
    },
    async stackAdd(userId, slug) {
      const r = await pool.query(
        'INSERT INTO stack (user_id, app_slug, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [userId, slug, Date.now()]
      );
      return r.rowCount > 0;
    },
    async stackRemove(userId, slug) {
      const r = await pool.query('DELETE FROM stack WHERE user_id = $1 AND app_slug = $2', [userId, slug]);
      return r.rowCount > 0;
    },
    async stackSlugs(userId) {
      const r = await pool.query(
        'SELECT app_slug FROM stack WHERE user_id = $1 ORDER BY created_at DESC, app_slug',
        [userId]
      );
      return r.rows.map((x) => x.app_slug);
    },
    async stackClear(userId) {
      await pool.query('DELETE FROM stack WHERE user_id = $1', [userId]);
    },
    async setUserNewsletter(userId, on) {
      await pool.query('UPDATE "user" SET "newsletter" = $2 WHERE "id" = $1', [userId, on]);
    },
    async removeFromWaitlist(email) {
      await pool.query('DELETE FROM waitlist WHERE email = $1', [email]);
    },
    async sponsorTotals() {
      const [imp, clk] = await Promise.all([
        pool.query('SELECT COALESCE(SUM(count), 0) AS n, MIN(day) AS since FROM sponsor_impressions'),
        pool.query('SELECT COUNT(*) AS n, MIN(created_at) AS since FROM sponsor_clicks'),
      ]);
      return {
        impressions: Number(imp.rows[0].n),
        impressionsSince: imp.rows[0].since ?? null,
        clicks: Number(clk.rows[0].n),
        clicksSince: clk.rows[0].since == null ? null : Number(clk.rows[0].since),
      };
    },
    async insertSubmission(s) {
      await pool.query(
        `INSERT INTO submissions (id, slug, app_name, app_url, take, submitter, user_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
        [s.id, s.slug, s.app_name, s.app_url, s.take, s.submitter, s.user_id, s.status, s.created_at]
      );
    },
    async insertArticle(a) {
      await pool.query(
        `INSERT INTO articles (id, title, author, email, link, summary, body, status, user_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
        [a.id, a.title, a.author, a.email, a.link, a.summary, a.body, a.status, a.user_id, a.created_at]
      );
    },
    async articleById(id) {
      return (await pool.query('SELECT * FROM articles WHERE id = $1', [id])).rows[0] ?? null;
    },
    async articlesByStatus(status) {
      return (
        await pool.query('SELECT * FROM articles WHERE status = $1 ORDER BY created_at DESC LIMIT 200', [status])
      ).rows;
    },
    async updateArticle(id, status, note) {
      await pool.query('UPDATE articles SET status = $2, note = $3, updated_at = $4 WHERE id = $1', [
        id, status, note ?? null, Date.now(),
      ]);
    },
    async updateSubmission(id, fields) {
      const keys = submissionParts(fields);
      const params = [id, ...keys.map((k) => fields[k])];
      await pool.query(
        `UPDATE submissions SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
        params
      );
    },
    async submissionById(id) {
      const r = await pool.query('SELECT * FROM submissions WHERE id = $1', [id]);
      return r.rows[0] ?? null;
    },
    async openSubmissionBySlug(slug) {
      const r = await pool.query(
        'SELECT * FROM submissions WHERE slug = $1 AND status = ANY($2) AND updated_at > $3 LIMIT 1',
        [slug, SUBMISSION_OPEN_STATUSES, Date.now() - SUBMISSION_STALL_MS]
      );
      return r.rows[0] ?? null;
    },
    async insertBuild(b) {
      await pool.query(
        `INSERT INTO builds
           (id, user_id, app_slug, name, slug, one_liner, goes, prompt, story,
            where_broke, tool, model, model_norm, demo_url, repo_url, chat_url,
            media, affiliation, by_owner, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                 $17, $18, $19, $20, $21, $21)`,
        [b.id, b.user_id, b.app_slug, b.name, b.slug, b.one_liner, b.goes, b.prompt,
         b.story, b.where_broke, b.tool, b.model, b.model_norm, b.demo_url, b.repo_url,
         b.chat_url, b.media, b.affiliation, b.by_owner, b.status, b.created_at]
      );
    },
    async updateBuild(id, fields) {
      const keys = buildParts(fields);
      const params = [id, ...keys.map((k) => fields[k])];
      const r = await pool.query(
        `UPDATE builds SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
        params
      );
      return r.rowCount;
    },
    async buildById(id) {
      const r = await pool.query('SELECT * FROM builds WHERE id = $1', [id]);
      return buildRow(r.rows[0]);
    },
    async liveBuilds() {
      const r = await pool.query(
        "SELECT * FROM builds WHERE status = 'live' ORDER BY created_at DESC"
      );
      return r.rows.map(buildRow);
    },
    async pendingBuilds() {
      const r = await pool.query(
        "SELECT * FROM builds WHERE status = 'pending' ORDER BY created_at ASC"
      );
      return r.rows.map(buildRow);
    },
    async buildUserNames(ids) {
      if (!ids.length) return [];
      const r = await pool.query(
        'SELECT "id", "name", "handle" FROM "user" WHERE "id" = ANY($1)',
        [ids]
      );
      return r.rows;
    },
    async userHandle(userId) {
      const r = await pool.query('SELECT "handle" FROM "user" WHERE "id" = $1', [userId]);
      return r.rows[0]?.handle ?? null;
    },
    // Set-once: only fills a NULL handle; the unique index turns a race for
    // the same handle into a caught error -> false.
    async setUserHandle(userId, handle) {
      try {
        const r = await pool.query(
          'UPDATE "user" SET "handle" = $2 WHERE "id" = $1 AND "handle" IS NULL',
          [userId, handle]
        );
        return r.rowCount > 0;
      } catch (err) {
        if (/unique|duplicate/i.test(err.message)) return false;
        throw err;
      }
    },
    async userByHandle(handle) {
      const r = await pool.query(
        'SELECT "id", "name", "handle" FROM "user" WHERE lower("handle") = lower($1)',
        [handle]
      );
      return r.rows[0] ?? null;
    },
    async insertChallengeEntry(e) {
      await pool.query(
        `INSERT INTO challenge_entries
           (id, challenge_id, x_handle, url, page_title, og_image, email_opted,
            kind, status, held_reason, country, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [e.id, e.challenge_id, e.x_handle, e.url, e.page_title, e.og_image,
         e.email_opted, e.kind, e.status, e.held_reason, e.country, e.created_at]
      );
    },
    async updateChallengeEntry(id, fields) {
      const keys = chParts(fields);
      const params = [id, ...keys.map((k) => fields[k])];
      const r = await pool.query(
        `UPDATE challenge_entries SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
        params
      );
      return r.rowCount;
    },
    async challengeEntryById(id) {
      const r = await pool.query('SELECT * FROM challenge_entries WHERE id = $1', [id]);
      return chRow(r.rows[0]);
    },
    async challengeEntryByUrl(challengeId, url) {
      const r = await pool.query(
        'SELECT * FROM challenge_entries WHERE challenge_id = $1 AND url = $2',
        [challengeId, url]
      );
      return chRow(r.rows[0]);
    },
    async challengeEntries(challengeId, statuses) {
      const r = await pool.query(
        'SELECT * FROM challenge_entries WHERE challenge_id = $1 AND status = ANY($2) ORDER BY created_at DESC',
        [challengeId, statuses]
      );
      return r.rows.map(chRow);
    },
    async challengeEntriesForCheck() {
      const r = await pool.query(
        "SELECT * FROM challenge_entries WHERE status IN ('live', 'held') ORDER BY created_at ASC"
      );
      return r.rows.map(chRow);
    },
    async liveEntryCount(challengeId) {
      const r = await pool.query(
        "SELECT COUNT(*) AS n FROM challenge_entries WHERE challenge_id = $1 AND status = 'live' AND kind != 'demo'",
        [challengeId]
      );
      return Number(r.rows[0].n);
    },
    async bumpEntryBadge(id) {
      const r = await pool.query(
        "UPDATE challenge_entries SET badge_hits = badge_hits + 1 WHERE id = $1 AND status = 'live'",
        [id]
      );
      return r.rowCount;
    },
    // Records the report if this reporter hasn't already flagged this entry;
    // returns the resulting DISTINCT reporter count, or null if it was a
    // duplicate (so a repeat report from one IP moves nothing).
    async addEntryReport(entryId, reporterHash, ts) {
      const ins = await pool.query(
        'INSERT INTO challenge_reports (entry_id, reporter_hash, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [entryId, reporterHash, ts]
      );
      if (ins.rowCount === 0) return null;
      const c = await pool.query('SELECT COUNT(*) AS n FROM challenge_reports WHERE entry_id = $1', [entryId]);
      const n = Number(c.rows[0].n);
      await pool.query('UPDATE challenge_entries SET report_count = $2 WHERE id = $1', [entryId, n]);
      return n;
    },
    async blockHost(host, reason, ts) {
      await pool.query(
        'INSERT INTO challenge_blocked_hosts (host, reason, created_at) VALUES ($1, $2, $3) ON CONFLICT (host) DO NOTHING',
        [host, reason, ts]
      );
    },
    async isHostBlocked(host) {
      const r = await pool.query('SELECT 1 FROM challenge_blocked_hosts WHERE host = $1', [host]);
      return r.rowCount > 0;
    },
    async unblockHost(host) {
      await pool.query('DELETE FROM challenge_blocked_hosts WHERE host = $1', [host]);
    },

    /* ---- The Build Games ---- */
    // ON CONFLICT (link) DO NOTHING: two concurrent first submits for one link
    // both succeed — whichever insert lost re-reads the winner's row (H4.4).
    async insertBgSponsor(s) {
      await pool.query(
        `INSERT INTO buildgames_sponsors (id, link, host, tagline, icon_url, status, held_reason, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (link) DO NOTHING`,
        [s.id, s.link, s.host, s.tagline, s.icon_url, s.status, s.held_reason, s.created_at]
      );
    },
    async bgSponsorByLink(link) {
      const r = await pool.query('SELECT * FROM buildgames_sponsors WHERE link = $1', [link]);
      return r.rows[0] ? bgSponsorRow(r.rows[0]) : null;
    },
    // M4 residual: a host that already has a PAID identity can't be split
    // into more board slots via a different path/URL. Unpaid rows never block
    // (or a free squat submission could lock a brand out of bidding).
    async bgClearedSponsorByHost(host, excludeLink) {
      const r = await pool.query(
        `SELECT * FROM buildgames_sponsors
         WHERE host = $1 AND link <> $2 AND first_cleared_at IS NOT NULL AND status IN ('active','held') LIMIT 1`,
        [host, excludeLink]
      );
      return r.rows[0] ? bgSponsorRow(r.rows[0]) : null;
    },
    async bgSponsorById(id) {
      const r = await pool.query('SELECT * FROM buildgames_sponsors WHERE id = $1', [id]);
      return r.rows[0] ? bgSponsorRow(r.rows[0]) : null;
    },
    async updateBgSponsor(id, fields) {
      const keys = bgSponsorParts(fields);
      const r = await pool.query(
        `UPDATE buildgames_sponsors SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [id, ...keys.map((k) => fields[k])]
      );
      return r.rowCount;
    },
    async insertBgPayment(p) {
      await pool.query(
        `INSERT INTO buildgames_payments (id, sponsor_id, amount_cents, status, processor_ref, proposed_tagline, proposed_icon_src, proposed_status, proposed_reason, contact_email, details_token, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [p.id, p.sponsor_id, p.amount_cents, p.status, p.processor_ref, p.proposed_tagline ?? null, p.proposed_icon_src ?? null, p.proposed_status ?? null, p.proposed_reason ?? null, p.contact_email ?? null, p.details_token ?? null, p.created_at]
      );
    },
    async bgPaymentById(id) {
      const r = await pool.query('SELECT * FROM buildgames_payments WHERE id = $1', [id]);
      return r.rows[0] ? { ...r.rows[0], amount_cents: Number(r.rows[0].amount_cents), created_at: Number(r.rows[0].created_at) } : null;
    },
    // Post-checkout details page: the payer is identified by TOKEN ONLY.
    async bgPaymentByDetailsToken(token) {
      const r = await pool.query('SELECT * FROM buildgames_payments WHERE details_token = $1', [token]);
      return r.rows[0] ? { ...r.rows[0], amount_cents: Number(r.rows[0].amount_cents), created_at: Number(r.rows[0].created_at) } : null;
    },
    // The payment that won the identity claim: the earliest CLEARED payment
    // that carried a screen. Deterministic proxy used by the details gate.
    async bgFirstClearedScreenedPayment(sponsorId) {
      const r = await pool.query(
        "SELECT * FROM buildgames_payments WHERE sponsor_id = $1 AND status = 'cleared' AND proposed_status IS NOT NULL ORDER BY created_at ASC, id ASC LIMIT 1",
        [sponsorId]
      );
      return r.rows[0] ? { ...r.rows[0], amount_cents: Number(r.rows[0].amount_cents), created_at: Number(r.rows[0].created_at) } : null;
    },
    // Atomic pending→cleared: only the FIRST concurrent caller wins (returns 1);
    // a retry-storm or double webhook gets 0 and must not act (audit H4.3).
    async clearBgPaymentAtomic(id) {
      const r = await pool.query("UPDATE buildgames_payments SET status = 'cleared' WHERE id = $1 AND status = 'pending'", [id]);
      return r.rowCount;
    },
    // Processor clear (H4.1/H4.2): one atomic statement stamps CLEARED with the
    // amount the processor actually CAPTURED (the recorded/claimed amount is
    // never trusted for money) and the capture's unique ref. The partial
    // unique index makes a reused ref THROW rather than double-credit.
    async clearBgPaymentCaptured(id, capturedCents, processorRef) {
      const r = await pool.query(
        "UPDATE buildgames_payments SET status = 'cleared', amount_cents = $2, processor_ref = $3 WHERE id = $1 AND status = 'pending'",
        [id, capturedCents, processorRef]
      );
      return r.rowCount;
    },
    // Expired/abandoned checkout: retire a PENDING payment only — an expired
    // event must never touch a payment that has already cleared.
    async expireBgPaymentAtomic(id) {
      const r = await pool.query("UPDATE buildgames_payments SET status = 'reversed' WHERE id = $1 AND status = 'pending'", [id]);
      return r.rowCount;
    },
    // Refund/dispute lookup: which payment did this processor capture clear?
    async bgPaymentByProcessorRef(ref) {
      const r = await pool.query('SELECT * FROM buildgames_payments WHERE processor_ref = $1', [ref]);
      return r.rows[0] ? { ...r.rows[0], amount_cents: Number(r.rows[0].amount_cents), created_at: Number(r.rows[0].created_at) } : null;
    },
    async bgIncrementClicks(id) {
      const r = await pool.query('UPDATE buildgames_sponsors SET click_count = click_count + 1 WHERE id = $1', [id]);
      return r.rowCount;
    },
    // Atomic reverse: only a currently pending/cleared payment reverses (1);
    // reversing an already-reversed one is a no-op (0).
    async reverseBgPaymentAtomic(id) {
      const r = await pool.query("UPDATE buildgames_payments SET status = 'reversed' WHERE id = $1 AND status IN ('pending','cleared')", [id]);
      return r.rowCount;
    },
    // Atomic first-clear claim: freezes tagline + status + first_cleared_at
    // ONLY if not already frozen. Exactly one concurrent clear wins (1); the
    // rest add money without touching identity (0). Status comes from THIS
    // payment's screen, closing held-poisoning.
    async claimFirstClear(sponsorId, tagline, status, heldReason, contactEmail, ts, paymentId) {
      // status <> 'removed': an admin-removed sponsor's in-flight session must
      // never force it back onto the board (B1) — the money still clears, the
      // identity stays unclaimed. claimed_by records the ACTUAL winner so edit
      // authorisation never needs a time-ordering proxy.
      const r = await pool.query(
        `UPDATE buildgames_sponsors SET tagline = $2, status = $3, held_reason = $4, contact_email = $5, first_cleared_at = $6, claimed_by = $7
         WHERE id = $1 AND first_cleared_at IS NULL AND status <> 'removed'`,
        [sponsorId, tagline, status, heldReason, contactEmail, ts, paymentId ?? null]
      );
      return r.rowCount;
    },
    // Cumulative cleared, non-reversed total for a sponsor.
    async bgSponsorClearedTotal(sponsorId) {
      const r = await pool.query(
        "SELECT COALESCE(SUM(amount_cents),0) AS t FROM buildgames_payments WHERE sponsor_id = $1 AND status = 'cleared'",
        [sponsorId]
      );
      return Number(r.rows[0].t);
    },
    // Board: active sponsors with cleared money, ranked totals attached.
    async bgLeaderboard() {
      const r = await pool.query(
        `SELECT s.*, COALESCE(SUM(p.amount_cents) FILTER (WHERE p.status='cleared'),0) AS cleared_total
         FROM buildgames_sponsors s LEFT JOIN buildgames_payments p ON p.sponsor_id = s.id
         WHERE s.status = 'active'
         GROUP BY s.id HAVING COALESCE(SUM(p.amount_cents) FILTER (WHERE p.status='cleared'),0) > 0`
      );
      return r.rows.map(bgSponsorRow);
    },
    // Admin view: every sponsor with cleared + pending totals.
    async bgSponsorsForAdmin() {
      const r = await pool.query(
        `SELECT s.*,
           COALESCE(SUM(p.amount_cents) FILTER (WHERE p.status='cleared'),0) AS cleared_total,
           COALESCE(SUM(p.amount_cents) FILTER (WHERE p.status='pending'),0) AS pending_total
         FROM buildgames_sponsors s LEFT JOIN buildgames_payments p ON p.sponsor_id = s.id
         GROUP BY s.id ORDER BY cleared_total DESC, s.created_at ASC`
      );
      return r.rows.map(bgSponsorRow);
    },
    // Pot: all cleared, non-reversed money across every sponsor (removed too).
    async bgPotCents() {
      const r = await pool.query("SELECT COALESCE(SUM(amount_cents),0) AS t FROM buildgames_payments WHERE status = 'cleared'");
      return Number(r.rows[0].t);
    },
    async addBgReport(sponsorId, reporterHash, ts) {
      const ins = await pool.query(
        'INSERT INTO buildgames_reports (sponsor_id, reporter_hash, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [sponsorId, reporterHash, ts]
      );
      if (ins.rowCount === 0) return null;
      const c = await pool.query('SELECT COUNT(*) AS n FROM buildgames_reports WHERE sponsor_id = $1', [sponsorId]);
      const n = Number(c.rows[0].n);
      await pool.query('UPDATE buildgames_sponsors SET report_count = $2 WHERE id = $1', [sponsorId, n]);
      return n;
    },
    async bgFirstReportAt(sponsorId) {
      const r = await pool.query('SELECT MIN(created_at) AS t FROM buildgames_reports WHERE sponsor_id = $1', [sponsorId]);
      return r.rows[0]?.t != null ? Number(r.rows[0].t) : null;
    },
    async bgBlockHost(host, reason, ts) {
      await pool.query(
        'INSERT INTO buildgames_blocked_hosts (host, reason, created_at) VALUES ($1,$2,$3) ON CONFLICT (host) DO NOTHING',
        [host, reason, ts]
      );
    },
    async bgUnblockHost(host) {
      await pool.query('DELETE FROM buildgames_blocked_hosts WHERE host = $1', [host]);
    },
    async bgIsHostBlocked(host) {
      const r = await pool.query('SELECT 1 FROM buildgames_blocked_hosts WHERE host = $1', [host]);
      return r.rowCount > 0;
    },
    async bgSponsorsForRecheck() {
      const r = await pool.query("SELECT * FROM buildgames_sponsors WHERE status IN ('active','held')");
      return r.rows.map(bgSponsorRow);
    },
    /* ---- Build Games entries ---- */
    async insertBgEntry(e) {
      await pool.query(
        `INSERT INTO buildgames_entries (id, name, handle, demo_url, repo_url, blurb, contact_email, edit_token, newsletter_optin, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [e.id, e.name, e.handle ?? null, e.demo_url, e.repo_url, e.blurb ?? null, e.contact_email, e.edit_token, e.newsletter_optin ? 1 : 0, e.status, e.created_at, e.updated_at]
      );
    },
    // Edit page: the entrant is identified by TOKEN ONLY (unique index).
    async bgEntryByEditToken(token) {
      const r = await pool.query('SELECT * FROM buildgames_entries WHERE edit_token = $1', [token]);
      return bgEntryRow(r.rows[0]);
    },
    async bgEntryByEmail(email) {
      const r = await pool.query('SELECT * FROM buildgames_entries WHERE contact_email = $1 LIMIT 1', [email]);
      return bgEntryRow(r.rows[0]);
    },
    async bgEntryByRepo(repoUrl) {
      const r = await pool.query('SELECT * FROM buildgames_entries WHERE repo_url = $1 LIMIT 1', [repoUrl]);
      return bgEntryRow(r.rows[0]);
    },
    async updateBgEntry(id, fields) {
      const keys = bgEntryParts(fields);
      const r = await pool.query(
        `UPDATE buildgames_entries SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [id, ...keys.map((k) => fields[k])]
      );
      return r.rowCount;
    },
    async bgEntryCount() {
      const r = await pool.query("SELECT COUNT(*) AS n FROM buildgames_entries WHERE status = 'submitted'");
      return Number(r.rows[0].n);
    },
    async bgRecClick(rec) {
      await pool.query(
        'INSERT INTO buildgames_rec_clicks (rec, count) VALUES ($1, 1) ON CONFLICT (rec) DO UPDATE SET count = buildgames_rec_clicks.count + 1',
        [rec]
      );
    },
    async recClick(src, day) {
      await pool.query(
        'INSERT INTO rec_clicks (src, day, count) VALUES ($1, $2, 1) ON CONFLICT (src, day) DO UPDATE SET count = rec_clicks.count + 1',
        [src, day]
      );
    },
    async recClickRows(sinceDay) {
      const r = await pool.query('SELECT src, day, count FROM rec_clicks WHERE day >= $1 ORDER BY day, src', [sinceDay]);
      return r.rows.map((x) => ({ ...x, count: Number(x.count) }));
    },
    async recImpression(src, day) {
      await pool.query(
        'INSERT INTO rec_impressions (src, day, count) VALUES ($1, $2, 1) ON CONFLICT (src, day) DO UPDATE SET count = rec_impressions.count + 1',
        [src, day]
      );
    },
    async recImpressionRows(sinceDay) {
      const r = await pool.query('SELECT src, day, count FROM rec_impressions WHERE day >= $1 ORDER BY day, src', [sinceDay]);
      return r.rows.map((x) => ({ ...x, count: Number(x.count) }));
    },
    /* ---- model demos ---- */
    async insertModelDemo(d) {
      await pool.query(
        `INSERT INTO model_demos (${MD_COLS.join(', ')}) VALUES (${MD_COLS.map((_, i) => `$${i + 1}`).join(', ')})`,
        MD_COLS.map((c) => d[c] ?? null)
      );
    },
    async updateModelDemo(id, fields) {
      const keys = mdParts(fields);
      const r = await pool.query(
        `UPDATE model_demos SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [id, ...keys.map((k) => fields[k])]
      );
      return r.rowCount;
    },
    async modelDemoBySource(modelSlug, source, sourceId) {
      const r = await pool.query('SELECT * FROM model_demos WHERE model_slug = $1 AND source = $2 AND source_id = $3', [modelSlug, source, sourceId]);
      return mdRow(r.rows[0]);
    },
    async modelDemoById(id) {
      const r = await pool.query('SELECT * FROM model_demos WHERE id = $1', [id]);
      return mdRow(r.rows[0]);
    },
    async modelDemos(modelSlug, statuses) {
      const r = await pool.query(
        'SELECT * FROM model_demos WHERE model_slug = $1 AND status = ANY($2) ORDER BY featured_order ASC, created_at ASC',
        [modelSlug, statuses]
      );
      return r.rows.map(mdRow);
    },
    async buildByUserSlug(userId, slug) {
      const r = await pool.query(
        'SELECT * FROM builds WHERE user_id = $1 AND slug = $2',
        [userId, slug]
      );
      return buildRow(r.rows[0]);
    },
    async userBuildSlugs(userId) {
      const r = await pool.query('SELECT slug FROM builds WHERE user_id = $1', [userId]);
      return r.rows.map((x) => x.slug);
    },
    async githubAccountOf(userId) {
      const r = await pool.query(
        `SELECT "accountId" FROM "account" WHERE "userId" = $1 AND "providerId" = 'github' LIMIT 1`,
        [userId]
      );
      return r.rows[0]?.accountId ?? null;
    },
    async insertBuildMedia(m) {
      await pool.query(
        'INSERT INTO build_media (id, user_id, key, created_at) VALUES ($1, $2, $3, $4)',
        [m.id, m.user_id, m.key, m.created_at]
      );
    },
    async mediaOwnedBy(ids, userId) {
      if (!ids.length) return [];
      const r = await pool.query(
        'SELECT id, key FROM build_media WHERE id = ANY($1) AND user_id = $2 AND build_id IS NULL',
        [ids, userId]
      );
      return r.rows;
    },
    async claimBuildMedia(ids, buildId, userId) {
      if (!ids.length) return;
      await pool.query(
        'UPDATE build_media SET build_id = $2 WHERE id = ANY($1) AND user_id = $3 AND build_id IS NULL',
        [ids, buildId, userId]
      );
    },
  };
}

async function sqliteDriver() {
  const db = await rawSqliteDb();
  db.exec(SCHEMA_SQLITE);
  // A NULL source means the row predates per-placement tracking: scanner era.
  try {
    db.exec('ALTER TABLE waitlist ADD COLUMN source TEXT');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
  // Quarter deals: how many 30-day runs one payment covers (NULL = 1).
  try {
    db.exec('ALTER TABLE sponsor_purchases ADD COLUMN months INTEGER');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
  // What the slot's NEXT run is doing: pending | open | reserved.
  try {
    db.exec('ALTER TABLE sponsor_slots ADD COLUMN next_state TEXT');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
  // The slot's private next-run offer price for its current occupant (cents).
  try {
    db.exec('ALTER TABLE sponsor_slots ADD COLUMN renewal_price_cents INTEGER');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
  // When the automated next-run offer email went out for a purchase.
  try {
    db.exec('ALTER TABLE sponsor_purchases ADD COLUMN reminder_offer_at INTEGER');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
  // Maker handle: claimed once at first build post, unique case-insensitive,
  // shown (and used in /builds URLs) instead of the OAuth display name.
  try {
    db.exec('ALTER TABLE "user" ADD COLUMN "handle" TEXT');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS user_handle_unique ON "user" (lower("handle"))');
  // Share card for an approved build, generated at approval and stored on R2.
  try {
    db.exec('ALTER TABLE builds ADD COLUMN og_image TEXT');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
  // Moderation: a pinned row's count is frozen. Votes still get a normal 200
  // so vote-stuffers see nothing, but nothing is written.
  try {
    db.exec('ALTER TABLE votes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
  // Build Games columns added after the tables first shipped (N1): a table
  // created by an earlier schema is missing them and every bid would 500.
  const addBgColumn = (sql) => {
    try {
      db.exec(sql);
    } catch (err) {
      if (!/duplicate column/i.test(err.message)) throw err;
    }
  };
  addBgColumn('ALTER TABLE buildgames_sponsors ADD COLUMN last_checked_at INTEGER');
  addBgColumn('ALTER TABLE buildgames_sponsors ADD COLUMN check_result TEXT');
  addBgColumn('ALTER TABLE buildgames_sponsors ADD COLUMN contact_email TEXT');
  addBgColumn('ALTER TABLE buildgames_payments ADD COLUMN proposed_tagline TEXT');
  addBgColumn('ALTER TABLE buildgames_payments ADD COLUMN proposed_icon_src TEXT');
  addBgColumn('ALTER TABLE buildgames_payments ADD COLUMN proposed_status TEXT');
  addBgColumn('ALTER TABLE buildgames_payments ADD COLUMN proposed_reason TEXT');
  addBgColumn('ALTER TABLE buildgames_payments ADD COLUMN contact_email TEXT');
  addBgColumn('ALTER TABLE buildgames_payments ADD COLUMN details_token TEXT');
  addBgColumn('ALTER TABLE buildgames_sponsors ADD COLUMN name TEXT');
  addBgColumn('ALTER TABLE buildgames_sponsors ADD COLUMN claimed_by TEXT');
  // Public click counter for board rows (social proof for buyers).
  addBgColumn('ALTER TABLE buildgames_sponsors ADD COLUMN click_count INTEGER NOT NULL DEFAULT 0');
  // H4.2: one processor capture clears exactly one payment — a replayed or
  // cross-wired webhook citing an already-used ref must fail loudly, not
  // double-credit. Legacy 'admin' refs are first made unique so the index can
  // build; NULL refs (pending rows) stay exempt.
  db.exec("UPDATE buildgames_payments SET processor_ref = 'admin:' || id WHERE processor_ref = 'admin'");
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS buildgames_payments_ref ON buildgames_payments (processor_ref) WHERE processor_ref IS NOT NULL'
  );
  db.exec("UPDATE waitlist SET source = 'scanner' WHERE source IS NULL");
  const seedSlot = db.prepare('INSERT OR IGNORE INTO sponsor_slots (id, price_cents) VALUES (?, ?)');
  for (const [id, cents] of SLOT_SEED) seedSlot.run(id, cents);
  const stmts = {
    getVote: db.prepare('SELECT count FROM votes WHERE slug = ?'),
    allVotes: db.prepare('SELECT slug, count FROM votes'),
    addVote: db.prepare(`
      INSERT INTO votes (slug, count) VALUES (?, 1)
      ON CONFLICT(slug) DO UPDATE SET count = CASE WHEN pinned = 1 THEN count ELSE count + 1 END
    `),
    addEmail: db.prepare('INSERT OR IGNORE INTO waitlist (email, source) VALUES (?, ?)'),
    addSponsor: db.prepare('INSERT INTO sponsors (email, message) VALUES (?, ?)'),
    getLimit: db.prepare('SELECT count, window_start FROM rate_limits WHERE key = ?'),
    setLimit: db.prepare(`
      INSERT INTO rate_limits (key, count, window_start) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET count = excluded.count, window_start = excluded.window_start
    `),
    bumpLimit: db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?'),
  };
  return {
    async voteCount(slug) {
      return stmts.getVote.get(slug)?.count ?? 0;
    },
    async allVotes() {
      return stmts.allVotes.all();
    },
    async addVote(slug) {
      stmts.addVote.run(slug);
      return stmts.getVote.get(slug).count;
    },
    async removeVote(slug) {
      db.prepare('UPDATE votes SET count = max(count - 1, 0) WHERE slug = ? AND pinned = 0').run(slug);
      return stmts.getVote.get(slug)?.count ?? 0;
    },
    // Atomically spend a live rate-limit key: true only for the one caller
    // that got to delete it. Checking and clearing as two statements let two
    // concurrent unvotes both see the same key and both decrement.
    async consumeRateLimit(key, windowMs) {
      const r = db
        .prepare('DELETE FROM rate_limits WHERE key = ? AND window_start >= ?')
        .run(key, Date.now() - windowMs);
      return r.changes > 0;
    },
    async addEmail(email, source) {
      return stmts.addEmail.run(email, source).changes > 0;
    },
    async addSponsor(email, message) {
      stmts.addSponsor.run(email, message);
    },
    async rateLimit(key, max, windowMs) {
      const now = Date.now();
      const row = stmts.getLimit.get(key);
      if (!row || now - row.window_start > windowMs) {
        stmts.setLimit.run(key, 1, now);
        return true;
      }
      if (row.count >= max) return false;
      stmts.bumpLimit.run(key);
      return true;
    },
    async sponsorSlots() {
      return db
        .prepare('SELECT id, price_cents, next_state, renewal_price_cents FROM sponsor_slots ORDER BY id')
        .all();
    },
    async waitlistEmails(source) {
      return db.prepare('SELECT email FROM waitlist WHERE source = ? ORDER BY created_at').all(source)
        .map((x) => x.email);
    },
    async setSlotPrice(id, cents) {
      return db.prepare('UPDATE sponsor_slots SET price_cents = ? WHERE id = ?').run(cents, id).changes > 0;
    },
    async setSlotNextState(id, state) {
      return db.prepare('UPDATE sponsor_slots SET next_state = ? WHERE id = ?').run(state, id).changes > 0;
    },
    async insertPurchase(p) {
      db.prepare(
        `INSERT INTO sponsor_purchases
           (id, slot_id, status, amount_cents, months, details_token, created_at, hold_expires_at, stripe_session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(p.id, p.slot_id, p.status, p.amount_cents, p.months ?? 1, p.details_token, p.created_at, p.hold_expires_at, p.stripe_session_id ?? null);
    },
    async activePurchases() {
      const marks = ACTIVE_STATUSES.map(() => '?').join(', ');
      return db
        .prepare(`SELECT * FROM sponsor_purchases WHERE status IN (${marks}) ORDER BY created_at, id`)
        .all(...ACTIVE_STATUSES)
        .map(purchaseRow);
    },
    async purchaseBy(column, value) {
      return purchaseRow(db.prepare(`SELECT * FROM sponsor_purchases WHERE ${lookupCol(column)} = ?`).get(value));
    },
    async updatePurchase(id, fields, whereStatusIn) {
      const keys = updateParts(fields);
      const params = [...keys.map((k) => fields[k]), id];
      let sql = `UPDATE sponsor_purchases SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
      if (whereStatusIn) {
        sql += ` AND status IN (${whereStatusIn.map(() => '?').join(', ')})`;
        params.push(...whereStatusIn);
      }
      return db.prepare(sql).run(...params).changes;
    },
    async purchasesForAdmin(limit) {
      return db
        .prepare('SELECT * FROM sponsor_purchases ORDER BY created_at DESC LIMIT ?')
        .all(limit)
        .map(purchaseRow);
    },
    async addSponsorClick(slotId, surface, country, ts) {
      db.prepare(
        'INSERT INTO sponsor_clicks (slot_id, surface, country, created_at) VALUES (?, ?, ?, ?)'
      ).run(slotId, surface, country, ts);
    },
    async sponsorClickRows(sinceMs) {
      return db
        .prepare(
          `SELECT slot_id, surface, country, created_at FROM sponsor_clicks
           WHERE created_at >= ? ORDER BY created_at DESC`
        )
        .all(sinceMs);
    },
    async bumpImpressions(entries) {
      const stmt = db.prepare(
        `INSERT INTO sponsor_impressions (slot_id, day, count) VALUES (?, ?, ?)
         ON CONFLICT (slot_id, day) DO UPDATE SET count = count + excluded.count`
      );
      for (const e of entries) stmt.run(e.slot_id, e.day, e.count);
    },
    async impressionRows(sinceDay) {
      return db
        .prepare('SELECT slot_id, day, count FROM sponsor_impressions WHERE day >= ? ORDER BY day')
        .all(sinceDay);
    },
    async addSearch(query, hits, country, ts) {
      db.prepare(
        'INSERT INTO searches (query, hits, country, created_at) VALUES (?, ?, ?, ?)'
      ).run(query, hits, country, ts);
    },
    async searchRows(afterId, limit) {
      return db
        .prepare(
          'SELECT id, query, hits, country, created_at FROM searches WHERE id > ? ORDER BY id LIMIT ?'
        )
        .all(afterId, limit);
    },
    async stackAdd(userId, slug) {
      return db
        .prepare('INSERT OR IGNORE INTO stack (user_id, app_slug, created_at) VALUES (?, ?, ?)')
        .run(userId, slug, Date.now()).changes > 0;
    },
    async stackRemove(userId, slug) {
      return db.prepare('DELETE FROM stack WHERE user_id = ? AND app_slug = ?').run(userId, slug).changes > 0;
    },
    async stackSlugs(userId) {
      return db
        .prepare('SELECT app_slug FROM stack WHERE user_id = ? ORDER BY created_at DESC, app_slug')
        .all(userId)
        .map((x) => x.app_slug);
    },
    async stackClear(userId) {
      db.prepare('DELETE FROM stack WHERE user_id = ?').run(userId);
    },
    async setUserNewsletter(userId, on) {
      db.prepare('UPDATE "user" SET "newsletter" = ? WHERE "id" = ?').run(on ? 1 : 0, userId);
    },
    async removeFromWaitlist(email) {
      db.prepare('DELETE FROM waitlist WHERE email = ?').run(email);
    },
    async sponsorTotals() {
      const imp = db
        .prepare('SELECT COALESCE(SUM(count), 0) AS n, MIN(day) AS since FROM sponsor_impressions')
        .get();
      const clk = db
        .prepare('SELECT COUNT(*) AS n, MIN(created_at) AS since FROM sponsor_clicks')
        .get();
      return {
        impressions: Number(imp.n),
        impressionsSince: imp.since ?? null,
        clicks: Number(clk.n),
        clicksSince: clk.since == null ? null : Number(clk.since),
      };
    },
    async insertSubmission(s) {
      db.prepare(
        `INSERT INTO submissions (id, slug, app_name, app_url, take, submitter, user_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(s.id, s.slug, s.app_name, s.app_url, s.take, s.submitter, s.user_id, s.status, s.created_at, s.created_at);
    },
    async insertArticle(a) {
      db.prepare(
        `INSERT INTO articles (id, title, author, email, link, summary, body, status, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(a.id, a.title, a.author, a.email, a.link, a.summary, a.body, a.status, a.user_id, a.created_at, a.created_at);
    },
    async articleById(id) {
      return db.prepare('SELECT * FROM articles WHERE id = ?').get(id) ?? null;
    },
    async articlesByStatus(status) {
      return db
        .prepare('SELECT * FROM articles WHERE status = ? ORDER BY created_at DESC LIMIT 200')
        .all(status);
    },
    async updateArticle(id, status, note) {
      db.prepare('UPDATE articles SET status = ?, note = ?, updated_at = ? WHERE id = ?')
        .run(status, note ?? null, Date.now(), id);
    },
    async updateSubmission(id, fields) {
      const keys = submissionParts(fields);
      db.prepare(
        `UPDATE submissions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`
      ).run(...keys.map((k) => fields[k]), id);
    },
    async submissionById(id) {
      return db.prepare('SELECT * FROM submissions WHERE id = ?').get(id) ?? null;
    },
    async openSubmissionBySlug(slug) {
      const marks = SUBMISSION_OPEN_STATUSES.map(() => '?').join(', ');
      return (
        db
          .prepare(
            `SELECT * FROM submissions WHERE slug = ? AND status IN (${marks}) AND updated_at > ? LIMIT 1`
          )
          .get(slug, ...SUBMISSION_OPEN_STATUSES, Date.now() - SUBMISSION_STALL_MS) ?? null
      );
    },
    async insertBuild(b) {
      db.prepare(
        `INSERT INTO builds
           (id, user_id, app_slug, name, slug, one_liner, goes, prompt, story,
            where_broke, tool, model, model_norm, demo_url, repo_url, chat_url,
            media, affiliation, by_owner, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        b.id, b.user_id, b.app_slug, b.name, b.slug, b.one_liner, b.goes, b.prompt,
        b.story, b.where_broke, b.tool, b.model, b.model_norm, b.demo_url, b.repo_url,
        b.chat_url, b.media, b.affiliation, b.by_owner, b.status, b.created_at,
        b.created_at
      );
    },
    async updateBuild(id, fields) {
      const keys = buildParts(fields);
      return db
        .prepare(`UPDATE builds SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map((k) => fields[k]), id).changes;
    },
    async buildById(id) {
      return buildRow(db.prepare('SELECT * FROM builds WHERE id = ?').get(id));
    },
    async liveBuilds() {
      return db
        .prepare("SELECT * FROM builds WHERE status = 'live' ORDER BY created_at DESC")
        .all()
        .map(buildRow);
    },
    async pendingBuilds() {
      return db
        .prepare("SELECT * FROM builds WHERE status = 'pending' ORDER BY created_at ASC")
        .all()
        .map(buildRow);
    },
    async buildUserNames(ids) {
      if (!ids.length) return [];
      const marks = ids.map(() => '?').join(', ');
      return db
        .prepare(`SELECT "id", "name", "handle" FROM "user" WHERE "id" IN (${marks})`)
        .all(...ids);
    },
    async userHandle(userId) {
      return db.prepare('SELECT "handle" FROM "user" WHERE "id" = ?').get(userId)?.handle ?? null;
    },
    async setUserHandle(userId, handle) {
      try {
        return (
          db.prepare('UPDATE "user" SET "handle" = ? WHERE "id" = ? AND "handle" IS NULL')
            .run(handle, userId).changes > 0
        );
      } catch (err) {
        if (/unique|constraint/i.test(err.message)) return false;
        throw err;
      }
    },
    async userByHandle(handle) {
      return (
        db.prepare('SELECT "id", "name", "handle" FROM "user" WHERE lower("handle") = lower(?)')
          .get(handle) ?? null
      );
    },
    async buildByUserSlug(userId, slug) {
      return buildRow(
        db.prepare('SELECT * FROM builds WHERE user_id = ? AND slug = ?').get(userId, slug)
      );
    },
    async insertChallengeEntry(e) {
      db.prepare(
        `INSERT INTO challenge_entries
           (id, challenge_id, x_handle, url, page_title, og_image, email_opted,
            kind, status, held_reason, country, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        e.id, e.challenge_id, e.x_handle, e.url, e.page_title, e.og_image,
        e.email_opted, e.kind, e.status, e.held_reason, e.country, e.created_at
      );
    },
    async updateChallengeEntry(id, fields) {
      const keys = chParts(fields);
      return db
        .prepare(`UPDATE challenge_entries SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map((k) => fields[k]), id).changes;
    },
    async challengeEntryById(id) {
      return chRow(db.prepare('SELECT * FROM challenge_entries WHERE id = ?').get(id));
    },
    async challengeEntryByUrl(challengeId, url) {
      return chRow(
        db.prepare('SELECT * FROM challenge_entries WHERE challenge_id = ? AND url = ?')
          .get(challengeId, url)
      );
    },
    async challengeEntries(challengeId, statuses) {
      const marks = statuses.map(() => '?').join(', ');
      return db
        .prepare(
          `SELECT * FROM challenge_entries WHERE challenge_id = ? AND status IN (${marks}) ORDER BY created_at DESC`
        )
        .all(challengeId, ...statuses)
        .map(chRow);
    },
    async challengeEntriesForCheck() {
      return db
        .prepare("SELECT * FROM challenge_entries WHERE status IN ('live', 'held') ORDER BY created_at ASC")
        .all()
        .map(chRow);
    },
    async liveEntryCount(challengeId) {
      return db
        .prepare("SELECT COUNT(*) AS n FROM challenge_entries WHERE challenge_id = ? AND status = 'live' AND kind != 'demo'")
        .get(challengeId).n;
    },
    async bumpEntryBadge(id) {
      return db
        .prepare("UPDATE challenge_entries SET badge_hits = badge_hits + 1 WHERE id = ? AND status = 'live'")
        .run(id).changes;
    },
    async addEntryReport(entryId, reporterHash, ts) {
      const ins = db
        .prepare('INSERT OR IGNORE INTO challenge_reports (entry_id, reporter_hash, created_at) VALUES (?, ?, ?)')
        .run(entryId, reporterHash, ts);
      if (ins.changes === 0) return null;
      const n = db.prepare('SELECT COUNT(*) AS n FROM challenge_reports WHERE entry_id = ?').get(entryId).n;
      db.prepare('UPDATE challenge_entries SET report_count = ? WHERE id = ?').run(n, entryId);
      return n;
    },
    async blockHost(host, reason, ts) {
      db.prepare(
        'INSERT OR IGNORE INTO challenge_blocked_hosts (host, reason, created_at) VALUES (?, ?, ?)'
      ).run(host, reason, ts);
    },
    async isHostBlocked(host) {
      return !!db.prepare('SELECT 1 FROM challenge_blocked_hosts WHERE host = ?').get(host);
    },
    async unblockHost(host) {
      db.prepare('DELETE FROM challenge_blocked_hosts WHERE host = ?').run(host);
    },

    /* ---- The Build Games ---- */
    // INSERT OR IGNORE: two concurrent first submits for one link both
    // succeed — whichever insert lost re-reads the winner's row (H4.4).
    async insertBgSponsor(s) {
      db.prepare(
        `INSERT OR IGNORE INTO buildgames_sponsors (id, link, host, tagline, icon_url, status, held_reason, created_at)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(s.id, s.link, s.host, s.tagline, s.icon_url, s.status, s.held_reason, s.created_at);
    },
    async bgSponsorByLink(link) {
      return bgSponsorRow(db.prepare('SELECT * FROM buildgames_sponsors WHERE link = ?').get(link));
    },
    // M4 residual: one PAID identity per host (see pg driver comment).
    async bgClearedSponsorByHost(host, excludeLink) {
      return bgSponsorRow(
        db
          .prepare(
            "SELECT * FROM buildgames_sponsors WHERE host = ? AND link <> ? AND first_cleared_at IS NOT NULL AND status IN ('active','held') LIMIT 1"
          )
          .get(host, excludeLink)
      );
    },
    async bgSponsorById(id) {
      return bgSponsorRow(db.prepare('SELECT * FROM buildgames_sponsors WHERE id = ?').get(id));
    },
    async updateBgSponsor(id, fields) {
      const keys = bgSponsorParts(fields);
      return db
        .prepare(`UPDATE buildgames_sponsors SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map((k) => fields[k]), id).changes;
    },
    async insertBgPayment(p) {
      db.prepare(
        `INSERT INTO buildgames_payments (id, sponsor_id, amount_cents, status, processor_ref, proposed_tagline, proposed_icon_src, proposed_status, proposed_reason, contact_email, details_token, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(p.id, p.sponsor_id, p.amount_cents, p.status, p.processor_ref, p.proposed_tagline ?? null, p.proposed_icon_src ?? null, p.proposed_status ?? null, p.proposed_reason ?? null, p.contact_email ?? null, p.details_token ?? null, p.created_at);
    },
    async bgPaymentById(id) {
      return db.prepare('SELECT * FROM buildgames_payments WHERE id = ?').get(id) ?? null;
    },
    // Post-checkout details page: the payer is identified by TOKEN ONLY.
    async bgPaymentByDetailsToken(token) {
      return db.prepare('SELECT * FROM buildgames_payments WHERE details_token = ?').get(token) ?? null;
    },
    // The payment that won the identity claim (earliest cleared + screened).
    async bgFirstClearedScreenedPayment(sponsorId) {
      return (
        db
          .prepare(
            "SELECT * FROM buildgames_payments WHERE sponsor_id = ? AND status = 'cleared' AND proposed_status IS NOT NULL ORDER BY created_at ASC, id ASC LIMIT 1"
          )
          .get(sponsorId) ?? null
      );
    },
    async clearBgPaymentAtomic(id) {
      return db.prepare("UPDATE buildgames_payments SET status = 'cleared' WHERE id = ? AND status = 'pending'").run(id).changes;
    },
    // Processor clear (H4.1/H4.2): CLEARED with the amount the processor
    // actually CAPTURED + the capture's unique ref, in one atomic statement.
    // The partial unique index makes a reused ref THROW, never double-credit.
    async clearBgPaymentCaptured(id, capturedCents, processorRef) {
      return db
        .prepare("UPDATE buildgames_payments SET status = 'cleared', amount_cents = ?, processor_ref = ? WHERE id = ? AND status = 'pending'")
        .run(capturedCents, processorRef, id).changes;
    },
    // Expired/abandoned checkout: retire a PENDING payment only.
    async expireBgPaymentAtomic(id) {
      return db.prepare("UPDATE buildgames_payments SET status = 'reversed' WHERE id = ? AND status = 'pending'").run(id).changes;
    },
    async bgPaymentByProcessorRef(ref) {
      return db.prepare('SELECT * FROM buildgames_payments WHERE processor_ref = ?').get(ref) ?? null;
    },
    async bgIncrementClicks(id) {
      return db.prepare('UPDATE buildgames_sponsors SET click_count = click_count + 1 WHERE id = ?').run(id).changes;
    },
    async reverseBgPaymentAtomic(id) {
      return db.prepare("UPDATE buildgames_payments SET status = 'reversed' WHERE id = ? AND status IN ('pending','cleared')").run(id).changes;
    },
    async claimFirstClear(sponsorId, tagline, status, heldReason, contactEmail, ts, paymentId) {
      // See pg driver: refuses removed rows (B1) and records the winner.
      return db
        .prepare(
          `UPDATE buildgames_sponsors SET tagline = ?, status = ?, held_reason = ?, contact_email = ?, first_cleared_at = ?, claimed_by = ?
           WHERE id = ? AND first_cleared_at IS NULL AND status <> 'removed'`
        )
        .run(tagline, status, heldReason, contactEmail, ts, paymentId ?? null, sponsorId).changes;
    },
    async bgSponsorClearedTotal(sponsorId) {
      return db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS t FROM buildgames_payments WHERE sponsor_id = ? AND status = 'cleared'").get(sponsorId).t;
    },
    async bgLeaderboard() {
      return db
        .prepare(
          `SELECT s.*, COALESCE(SUM(CASE WHEN p.status='cleared' THEN p.amount_cents ELSE 0 END),0) AS cleared_total
           FROM buildgames_sponsors s LEFT JOIN buildgames_payments p ON p.sponsor_id = s.id
           WHERE s.status = 'active'
           GROUP BY s.id HAVING cleared_total > 0`
        )
        .all()
        .map(bgSponsorRow);
    },
    async bgSponsorsForAdmin() {
      return db
        .prepare(
          `SELECT s.*,
             COALESCE(SUM(CASE WHEN p.status='cleared' THEN p.amount_cents ELSE 0 END),0) AS cleared_total,
             COALESCE(SUM(CASE WHEN p.status='pending' THEN p.amount_cents ELSE 0 END),0) AS pending_total
           FROM buildgames_sponsors s LEFT JOIN buildgames_payments p ON p.sponsor_id = s.id
           GROUP BY s.id ORDER BY cleared_total DESC, s.created_at ASC`
        )
        .all()
        .map(bgSponsorRow);
    },
    async bgPotCents() {
      return db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS t FROM buildgames_payments WHERE status = 'cleared'").get().t;
    },
    async addBgReport(sponsorId, reporterHash, ts) {
      const ins = db
        .prepare('INSERT OR IGNORE INTO buildgames_reports (sponsor_id, reporter_hash, created_at) VALUES (?,?,?)')
        .run(sponsorId, reporterHash, ts);
      if (ins.changes === 0) return null;
      const n = db.prepare('SELECT COUNT(*) AS n FROM buildgames_reports WHERE sponsor_id = ?').get(sponsorId).n;
      db.prepare('UPDATE buildgames_sponsors SET report_count = ? WHERE id = ?').run(n, sponsorId);
      return n;
    },
    async bgFirstReportAt(sponsorId) {
      const r = db.prepare('SELECT MIN(created_at) AS t FROM buildgames_reports WHERE sponsor_id = ?').get(sponsorId);
      return r?.t != null ? Number(r.t) : null;
    },
    async bgBlockHost(host, reason, ts) {
      db.prepare('INSERT OR IGNORE INTO buildgames_blocked_hosts (host, reason, created_at) VALUES (?,?,?)').run(host, reason, ts);
    },
    async bgUnblockHost(host) {
      db.prepare('DELETE FROM buildgames_blocked_hosts WHERE host = ?').run(host);
    },
    async bgIsHostBlocked(host) {
      return !!db.prepare('SELECT 1 FROM buildgames_blocked_hosts WHERE host = ?').get(host);
    },
    async bgSponsorsForRecheck() {
      return db.prepare("SELECT * FROM buildgames_sponsors WHERE status IN ('active','held')").all().map(bgSponsorRow);
    },
    /* ---- Build Games entries ---- */
    async insertBgEntry(e) {
      db.prepare(
        `INSERT INTO buildgames_entries (id, name, handle, demo_url, repo_url, blurb, contact_email, edit_token, newsletter_optin, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(e.id, e.name, e.handle ?? null, e.demo_url, e.repo_url, e.blurb ?? null, e.contact_email, e.edit_token, e.newsletter_optin ? 1 : 0, e.status, e.created_at, e.updated_at);
    },
    // Edit page: the entrant is identified by TOKEN ONLY (unique index).
    async bgEntryByEditToken(token) {
      return bgEntryRow(db.prepare('SELECT * FROM buildgames_entries WHERE edit_token = ?').get(token));
    },
    async bgEntryByEmail(email) {
      return bgEntryRow(db.prepare('SELECT * FROM buildgames_entries WHERE contact_email = ? LIMIT 1').get(email));
    },
    async bgEntryByRepo(repoUrl) {
      return bgEntryRow(db.prepare('SELECT * FROM buildgames_entries WHERE repo_url = ? LIMIT 1').get(repoUrl));
    },
    async updateBgEntry(id, fields) {
      const keys = bgEntryParts(fields);
      return db
        .prepare(`UPDATE buildgames_entries SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map((k) => fields[k]), id).changes;
    },
    async bgEntryCount() {
      return db.prepare("SELECT COUNT(*) AS n FROM buildgames_entries WHERE status = 'submitted'").get().n;
    },
    async bgRecClick(rec) {
      db.prepare(
        'INSERT INTO buildgames_rec_clicks (rec, count) VALUES (?, 1) ON CONFLICT(rec) DO UPDATE SET count = count + 1'
      ).run(rec);
    },
    async recClick(src, day) {
      db.prepare(
        'INSERT INTO rec_clicks (src, day, count) VALUES (?, ?, 1) ON CONFLICT(src, day) DO UPDATE SET count = count + 1'
      ).run(src, day);
    },
    async recClickRows(sinceDay) {
      return db.prepare('SELECT src, day, count FROM rec_clicks WHERE day >= ? ORDER BY day, src').all(sinceDay);
    },
    async recImpression(src, day) {
      db.prepare(
        'INSERT INTO rec_impressions (src, day, count) VALUES (?, ?, 1) ON CONFLICT(src, day) DO UPDATE SET count = count + 1'
      ).run(src, day);
    },
    async recImpressionRows(sinceDay) {
      return db.prepare('SELECT src, day, count FROM rec_impressions WHERE day >= ? ORDER BY day, src').all(sinceDay);
    },
    /* ---- model demos ---- */
    async insertModelDemo(d) {
      db.prepare(`INSERT INTO model_demos (${MD_COLS.join(', ')}) VALUES (${MD_COLS.map(() => '?').join(', ')})`)
        .run(...MD_COLS.map((c) => d[c] ?? null));
    },
    async updateModelDemo(id, fields) {
      const keys = mdParts(fields);
      return db
        .prepare(`UPDATE model_demos SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map((k) => fields[k]), id).changes;
    },
    async modelDemoBySource(modelSlug, source, sourceId) {
      return mdRow(db.prepare('SELECT * FROM model_demos WHERE model_slug = ? AND source = ? AND source_id = ?').get(modelSlug, source, sourceId));
    },
    async modelDemoById(id) {
      return mdRow(db.prepare('SELECT * FROM model_demos WHERE id = ?').get(id));
    },
    async modelDemos(modelSlug, statuses) {
      const marks = statuses.map(() => '?').join(', ');
      return db
        .prepare(`SELECT * FROM model_demos WHERE model_slug = ? AND status IN (${marks}) ORDER BY featured_order ASC, created_at ASC`)
        .all(modelSlug, ...statuses)
        .map(mdRow);
    },
    async userBuildSlugs(userId) {
      return db.prepare('SELECT slug FROM builds WHERE user_id = ?').all(userId).map((x) => x.slug);
    },
    async githubAccountOf(userId) {
      return (
        db.prepare(
          `SELECT "accountId" FROM "account" WHERE "userId" = ? AND "providerId" = 'github' LIMIT 1`
        ).get(userId)?.accountId ?? null
      );
    },
    async insertBuildMedia(m) {
      db.prepare(
        'INSERT INTO build_media (id, user_id, key, created_at) VALUES (?, ?, ?, ?)'
      ).run(m.id, m.user_id, m.key, m.created_at);
    },
    async mediaOwnedBy(ids, userId) {
      if (!ids.length) return [];
      const marks = ids.map(() => '?').join(', ');
      return db
        .prepare(
          `SELECT id, key FROM build_media WHERE id IN (${marks}) AND user_id = ? AND build_id IS NULL`
        )
        .all(...ids, userId);
    },
    async claimBuildMedia(ids, buildId, userId) {
      if (!ids.length) return;
      const marks = ids.map(() => '?').join(', ');
      db.prepare(
        `UPDATE build_media SET build_id = ? WHERE id IN (${marks}) AND user_id = ? AND build_id IS NULL`
      ).run(buildId, ...ids, userId);
    },
  };
}

async function getDriver() {
  // A rejected init must not be cached: clear it so the next request retries
  // (a Postgres blip would otherwise take the DB layer down until restart).
  if (!driver) {
    driver = (PG_URL ? pgDriver() : sqliteDriver()).catch((err) => {
      driver = null;
      throw err;
    });
  }
  return driver;
}

export async function voteCount(slug) {
  return (await getDriver()).voteCount(slug);
}

export async function voteCounts() {
  const rows = await (await getDriver()).allVotes();
  const map = new Map(rows.map((r) => [r.slug, Number(r.count)]));
  return (slug) => map.get(slug) ?? 0;
}

export async function addVote(slug) {
  return (await getDriver()).addVote(slug);
}

export async function removeVote(slug) {
  return (await getDriver()).removeVote(slug);
}

export async function consumeRateLimit(key, windowMs) {
  return (await getDriver()).consumeRateLimit(key, windowMs);
}

export async function addToWaitlist(email, source) {
  return (await getDriver()).addEmail(email, source);
}

export async function addSponsorInquiry(email, message) {
  return (await getDriver()).addSponsor(email, message?.slice(0, 2000) ?? null);
}

export async function rateLimit(key, max, windowMs) {
  return (await getDriver()).rateLimit(key, max, windowMs);
}

export async function sponsorSlots() {
  return (await getDriver()).sponsorSlots();
}

export async function setSlotPrice(id, priceCents) {
  return (await getDriver()).setSlotPrice(id, priceCents);
}

export async function setSlotNextState(id, state) {
  return (await getDriver()).setSlotNextState(id, state);
}

export async function waitlistEmails(source) {
  return (await getDriver()).waitlistEmails(source);
}

export async function insertPurchase(purchase) {
  return (await getDriver()).insertPurchase(purchase);
}

export async function activePurchases() {
  return (await getDriver()).activePurchases();
}

export async function purchaseById(id) {
  return (await getDriver()).purchaseBy('id', id);
}

export async function purchaseBySession(sessionId) {
  return (await getDriver()).purchaseBy('stripe_session_id', sessionId);
}

export async function purchaseByToken(token) {
  return (await getDriver()).purchaseBy('details_token', token);
}

/* The idempotency primitive: every state transition is a conditional update and
   the row count says whether this caller was the one that made it. A duplicate
   webhook gets 0 and does nothing. */
export async function updatePurchase(id, fields, whereStatusIn) {
  return (await getDriver()).updatePurchase(id, fields, whereStatusIn);
}

export async function addSponsorClick(slotId, surface, country, ts = Date.now()) {
  return (await getDriver()).addSponsorClick(slotId, surface, country, ts);
}

export async function sponsorClickRows(sinceMs = 0) {
  return (await getDriver()).sponsorClickRows(sinceMs);
}

export async function bumpImpressions(entries) {
  return (await getDriver()).bumpImpressions(entries);
}

export async function impressionRows(sinceDay = '0000-00-00') {
  return (await getDriver()).impressionRows(sinceDay);
}

// All-time aggregates across every slot: the public /stats page shows only
// these sums, never per-slot numbers. Cached briefly: the page renders per
// request and two table scans per pageview would be pure waste.
let totalsCache = { at: 0, data: null };
export async function sponsorTotals() {
  const now = Date.now();
  if (now - totalsCache.at < 60_000) return totalsCache.data;
  totalsCache = { at: now, data: await (await getDriver()).sponsorTotals() };
  return totalsCache.data;
}

export async function addSearch(query, hits, country, ts = Date.now()) {
  return (await getDriver()).addSearch(query, hits, country, ts);
}

// Incremental export for the off-site audit log: rows strictly after `afterId`,
// oldest first, so the puller can resume from the last id it has seen.
export async function searchRows(afterId = 0, limit = 5000) {
  return (await getDriver()).searchRows(afterId, limit);
}

export async function purchasesForAdmin(limit = 60) {
  return (await getDriver()).purchasesForAdmin(limit);
}

export async function stackAdd(userId, slug) {
  return (await getDriver()).stackAdd(userId, slug);
}

export async function stackRemove(userId, slug) {
  return (await getDriver()).stackRemove(userId, slug);
}

export async function stackSlugs(userId) {
  return (await getDriver()).stackSlugs(userId);
}

// GDPR delete-account cascade. SQLite doesn't enforce FKs by default, so this
// is the delete path on both drivers rather than trusting ON DELETE CASCADE.
export async function stackClear(userId) {
  return (await getDriver()).stackClear(userId);
}

export async function setUserNewsletter(userId, on) {
  return (await getDriver()).setUserNewsletter(userId, on);
}

export async function removeFromWaitlist(email) {
  return (await getDriver()).removeFromWaitlist(email);
}

export async function insertSubmission(s) {
  return (await getDriver()).insertSubmission(s);
}

export async function updateSubmission(id, fields) {
  return (await getDriver()).updateSubmission(id, { ...fields, updated_at: Date.now() });
}

export async function submissionById(id) {
  return (await getDriver()).submissionById(id);
}

export async function openSubmissionBySlug(slug) {
  return (await getDriver()).openSubmissionBySlug(slug);
}

/* ---------- reader-submitted guides ---------- */

export async function insertArticle(a) {
  return (await getDriver()).insertArticle(a);
}

export async function articleById(id) {
  return (await getDriver()).articleById(id);
}

export async function articlesByStatus(status) {
  return (await getDriver()).articlesByStatus(status);
}

export async function updateArticle(id, status, note) {
  return (await getDriver()).updateArticle(id, status, note);
}

/* ---------- builds ---------- */

export async function insertBuild(b) {
  return (await getDriver()).insertBuild(b);
}

export async function insertChallengeEntry(e) {
  return (await getDriver()).insertChallengeEntry(e);
}

export async function updateChallengeEntry(id, fields) {
  return (await getDriver()).updateChallengeEntry(id, fields);
}

export async function challengeEntryById(id) {
  return (await getDriver()).challengeEntryById(id);
}

export async function challengeEntryByUrl(challengeId, url) {
  return (await getDriver()).challengeEntryByUrl(challengeId, url);
}

export async function challengeEntries(challengeId, statuses = ['live']) {
  return (await getDriver()).challengeEntries(challengeId, statuses);
}

export async function challengeEntriesForCheck() {
  return (await getDriver()).challengeEntriesForCheck();
}

export async function liveEntryCount(challengeId) {
  return (await getDriver()).liveEntryCount(challengeId);
}

export async function bumpEntryBadge(id) {
  return (await getDriver()).bumpEntryBadge(id);
}

export async function addEntryReport(entryId, reporterHash, ts = Date.now()) {
  return (await getDriver()).addEntryReport(entryId, reporterHash, ts);
}

export async function blockHost(host, reason, ts = Date.now()) {
  return (await getDriver()).blockHost(host, reason, ts);
}

export async function isHostBlocked(host) {
  return (await getDriver()).isHostBlocked(host);
}

export async function unblockHost(host) {
  return (await getDriver()).unblockHost(host);
}

/* ---- The Build Games ---- */
export async function insertBgSponsor(s) { return (await getDriver()).insertBgSponsor(s); }
export async function bgSponsorByLink(link) { return (await getDriver()).bgSponsorByLink(link); }
export async function bgSponsorById(id) { return (await getDriver()).bgSponsorById(id); }
export async function updateBgSponsor(id, fields) { return (await getDriver()).updateBgSponsor(id, fields); }
export async function insertBgPayment(p) { return (await getDriver()).insertBgPayment(p); }
export async function bgPaymentById(id) { return (await getDriver()).bgPaymentById(id); }
export async function bgPaymentByDetailsToken(token) { return (await getDriver()).bgPaymentByDetailsToken(token); }
export async function bgFirstClearedScreenedPayment(sponsorId) { return (await getDriver()).bgFirstClearedScreenedPayment(sponsorId); }
export async function clearBgPaymentAtomic(id) { return (await getDriver()).clearBgPaymentAtomic(id); }
export async function clearBgPaymentCaptured(id, capturedCents, processorRef) { return (await getDriver()).clearBgPaymentCaptured(id, capturedCents, processorRef); }
export async function expireBgPaymentAtomic(id) { return (await getDriver()).expireBgPaymentAtomic(id); }
export async function bgPaymentByProcessorRef(ref) { return (await getDriver()).bgPaymentByProcessorRef(ref); }
export async function bgIncrementClicks(id) { return (await getDriver()).bgIncrementClicks(id); }
export async function bgClearedSponsorByHost(host, excludeLink) { return (await getDriver()).bgClearedSponsorByHost(host, excludeLink); }
export async function reverseBgPaymentAtomic(id) { return (await getDriver()).reverseBgPaymentAtomic(id); }
export async function claimFirstClear(sponsorId, tagline, status, heldReason, contactEmail, ts, paymentId) { return (await getDriver()).claimFirstClear(sponsorId, tagline, status, heldReason, contactEmail, ts, paymentId); }
export async function bgSponsorClearedTotal(sponsorId) { return (await getDriver()).bgSponsorClearedTotal(sponsorId); }
export async function bgLeaderboard() { return (await getDriver()).bgLeaderboard(); }
export async function bgSponsorsForAdmin() { return (await getDriver()).bgSponsorsForAdmin(); }
export async function bgPotCents() { return (await getDriver()).bgPotCents(); }
export async function addBgReport(sponsorId, reporterHash, ts = Date.now()) { return (await getDriver()).addBgReport(sponsorId, reporterHash, ts); }
export async function bgFirstReportAt(sponsorId) { return (await getDriver()).bgFirstReportAt(sponsorId); }
export async function bgBlockHost(host, reason, ts = Date.now()) { return (await getDriver()).bgBlockHost(host, reason, ts); }
export async function bgUnblockHost(host) { return (await getDriver()).bgUnblockHost(host); }
export async function bgIsHostBlocked(host) { return (await getDriver()).bgIsHostBlocked(host); }
export async function bgSponsorsForRecheck() { return (await getDriver()).bgSponsorsForRecheck(); }

/* ---- Build Games entries ---- */
export async function insertBgEntry(e) { return (await getDriver()).insertBgEntry(e); }
export async function bgEntryByEditToken(token) { return (await getDriver()).bgEntryByEditToken(token); }
export async function bgEntryByEmail(email) { return (await getDriver()).bgEntryByEmail(email); }
export async function bgEntryByRepo(repoUrl) { return (await getDriver()).bgEntryByRepo(repoUrl); }
export async function updateBgEntry(id, fields) { return (await getDriver()).updateBgEntry(id, { ...fields, updated_at: Date.now() }); }
export async function bgEntryCount() { return (await getDriver()).bgEntryCount(); }
export async function bgRecClick(rec) { return (await getDriver()).bgRecClick(rec); }
export async function recClick(src, day) { return (await getDriver()).recClick(src, day); }
export async function recClickRows(sinceDay = '0000-00-00') { return (await getDriver()).recClickRows(sinceDay); }
export async function recImpression(src, day) { return (await getDriver()).recImpression(src, day); }
export async function recImpressionRows(sinceDay = '0000-00-00') { return (await getDriver()).recImpressionRows(sinceDay); }

/* ---- model demos (/built-with) ---- */
export async function insertModelDemo(d) { return (await getDriver()).insertModelDemo(d); }
export async function updateModelDemo(id, fields) { return (await getDriver()).updateModelDemo(id, { ...fields, updated_at: Date.now() }); }
export async function modelDemoBySource(modelSlug, source, sourceId) { return (await getDriver()).modelDemoBySource(modelSlug, source, sourceId); }
export async function modelDemoById(id) { return (await getDriver()).modelDemoById(id); }
export async function modelDemos(modelSlug, statuses = ['live']) { return (await getDriver()).modelDemos(modelSlug, statuses); }

export async function updateBuild(id, fields) {
  return (await getDriver()).updateBuild(id, { ...fields, updated_at: Date.now() });
}

export async function buildById(id) {
  return (await getDriver()).buildById(id);
}

// All live builds, newest first. The pages filter/sort in JS — the whole
// table is small and one query keeps both drivers trivial.
export async function liveBuilds() {
  return (await getDriver()).liveBuilds();
}

// The admin approval queue, oldest first.
export async function pendingBuilds() {
  return (await getDriver()).pendingBuilds();
}

// Maker identities for build pages, one round trip per page: the claimed
// handle (display + URLs) with the OAuth name as fallback.
export async function buildUserNames(ids) {
  const rows = await (await getDriver()).buildUserNames([...new Set(ids)]);
  return new Map(rows.map((r) => [r.id, { name: r.name, handle: r.handle ?? null }]));
}

export async function userHandle(userId) {
  return (await getDriver()).userHandle(userId);
}

// Set-once, unique case-insensitive; false = already set or already taken.
export async function setUserHandle(userId, handle) {
  return (await getDriver()).setUserHandle(userId, handle);
}

export async function userByHandle(handle) {
  return (await getDriver()).userByHandle(handle);
}

export async function buildByUserSlug(userId, slug) {
  return (await getDriver()).buildByUserSlug(userId, slug);
}

// Existing slugs for one maker, so a repeat name gets -2, -3, … at insert.
export async function userBuildSlugs(userId) {
  return (await getDriver()).userBuildSlugs(userId);
}

// The linked GitHub account's numeric user id (Better Auth stores no login),
// or null when the user never connected GitHub.
export async function githubAccountOf(userId) {
  return (await getDriver()).githubAccountOf(userId);
}

export async function insertBuildMedia(m) {
  return (await getDriver()).insertBuildMedia(m);
}

export async function mediaOwnedBy(ids, userId) {
  return (await getDriver()).mediaOwnedBy(ids, userId);
}

export async function claimBuildMedia(ids, buildId, userId) {
  return (await getDriver()).claimBuildMedia(ids, buildId, userId);
}

// The headline number: total monthly cost of every subscription on the death list.
export function mrrDestroyed(apps) {
  return Math.round(apps.reduce((sum, a) => sum + (a.priceMonthly ?? 0), 0));
}
