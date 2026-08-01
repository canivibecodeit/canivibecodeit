/* Data layer with two drivers:
   - DATABASE_URL set  → Postgres (Railway / any managed PG)
   - otherwise         → SQLite via better-sqlite3 (local dev, plain VPS)
   All exports are async so call sites don't care which driver is live. */

const PG_URL = process.env.DATABASE_URL;

const SCHEMA_SQLITE = `
  CREATE TABLE IF NOT EXISTS votes (
    slug TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0
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
    reminder_renew_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS sponsor_purchases_status ON sponsor_purchases (status);
`;

const SCHEMA_PG = `
  CREATE TABLE IF NOT EXISTS votes (
    slug TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0
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
    reminder_renew_at BIGINT
  );
  CREATE INDEX IF NOT EXISTS sponsor_purchases_status ON sponsor_purchases (status);
`;

/* Six fixed slots, three per rail side. Seed prices only — editable at runtime. */
const SLOT_SEED = [
  ['L1', 29900],
  ['R1', 39900],
  ['L2', 49900],
  ['R2', 59900],
  ['L3', 69900],
  ['R3', 79900],
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
  'reminder_renew_at',
];

const PURCHASE_LOOKUP_COLS = new Set(['id', 'stripe_session_id', 'details_token']);

const NUMERIC_COLUMNS = [
  'amount_cents', 'created_at', 'hold_expires_at', 'paid_at', 'submitted_at',
  'approved_at', 'starts_at', 'ends_at', 'reminder_details_at', 'reminder_renew_at',
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

let driver;

async function pgDriver() {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: PG_URL, max: 5 });
  await pool.query(SCHEMA_PG);
  // A NULL source means the row predates per-placement tracking: scanner era.
  await pool.query('ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS source TEXT');
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
         ON CONFLICT (slug) DO UPDATE SET count = votes.count + 1
         RETURNING count`,
        [slug]
      );
      return r.rows[0].count;
    },
    async removeVote(slug) {
      const r = await pool.query(
        `UPDATE votes SET count = GREATEST(count - 1, 0) WHERE slug = $1 RETURNING count`,
        [slug]
      );
      return r.rows[0]?.count ?? 0;
    },
    async clearRateLimit(key) {
      await pool.query('DELETE FROM rate_limits WHERE key = $1', [key]);
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
      const r = await pool.query('SELECT id, price_cents FROM sponsor_slots ORDER BY id');
      return r.rows.map((s) => ({ id: s.id, price_cents: Number(s.price_cents) }));
    },
    async setSlotPrice(id, cents) {
      const r = await pool.query('UPDATE sponsor_slots SET price_cents = $2 WHERE id = $1', [id, cents]);
      return r.rowCount > 0;
    },
    async insertPurchase(p) {
      await pool.query(
        `INSERT INTO sponsor_purchases
           (id, slot_id, status, amount_cents, details_token, created_at, hold_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [p.id, p.slot_id, p.status, p.amount_cents, p.details_token, p.created_at, p.hold_expires_at]
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
      if (!PURCHASE_LOOKUP_COLS.has(column)) throw new Error('purchaseBy: invalid column: ' + column);
      const r = await pool.query('SELECT * FROM sponsor_purchases WHERE ' + column + ' = $1', [value]);
      return purchaseRow(r.rows[0]);
    },
    async updatePurchase(id, fields, whereStatusIn) {
      const keys = updateParts(fields);
      const params = [id, ...keys.map((k) => fields[k])];
      let sql = 'UPDATE sponsor_purchases SET ' + keys.map((k, i) => k + ' = $' + (i + 2)).join(', ') + ' WHERE id = $1';
      if (whereStatusIn) {
        params.push(whereStatusIn);
        sql += ' AND status = ANY($' + params.length + ')';
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
  };
}

async function sqliteDriver() {
  const { default: Database } = await import('better-sqlite3');
  const { mkdirSync } = await import('node:fs');
  const path = await import('node:path');
  const dir = process.env.DATA_DIR || 'data/private';
  mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'site.db'));
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQLITE);
  // A NULL source means the row predates per-placement tracking: scanner era.
  try {
    db.exec('ALTER TABLE waitlist ADD COLUMN source TEXT');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
  db.exec("UPDATE waitlist SET source = 'scanner' WHERE source IS NULL");
  const seedSlot = db.prepare('INSERT OR IGNORE INTO sponsor_slots (id, price_cents) VALUES (?, ?)');
  for (const [id, cents] of SLOT_SEED) seedSlot.run(id, cents);
  const stmts = {
    getVote: db.prepare('SELECT count FROM votes WHERE slug = ?'),
    allVotes: db.prepare('SELECT slug, count FROM votes'),
    addVote: db.prepare(`
      INSERT INTO votes (slug, count) VALUES (?, 1)
      ON CONFLICT(slug) DO UPDATE SET count = count + 1
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
      db.prepare('UPDATE votes SET count = max(count - 1, 0) WHERE slug = ?').run(slug);
      return stmts.getVote.get(slug)?.count ?? 0;
    },
    async clearRateLimit(key) {
      db.prepare('DELETE FROM rate_limits WHERE key = ?').run(key);
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
      return db.prepare('SELECT id, price_cents FROM sponsor_slots ORDER BY id').all();
    },
    async setSlotPrice(id, cents) {
      return db.prepare('UPDATE sponsor_slots SET price_cents = ? WHERE id = ?').run(cents, id).changes > 0;
    },
    async insertPurchase(p) {
      db.prepare(
        `INSERT INTO sponsor_purchases
           (id, slot_id, status, amount_cents, details_token, created_at, hold_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(p.id, p.slot_id, p.status, p.amount_cents, p.details_token, p.created_at, p.hold_expires_at);
    },
    async activePurchases() {
      const marks = ACTIVE_STATUSES.map(() => '?').join(', ');
      return db
        .prepare('SELECT * FROM sponsor_purchases WHERE status IN (' + marks + ') ORDER BY created_at, id')
        .all(...ACTIVE_STATUSES)
        .map(purchaseRow);
    },
    async purchaseBy(column, value) {
      if (!PURCHASE_LOOKUP_COLS.has(column)) throw new Error('purchaseBy: invalid column: ' + column);
      return purchaseRow(db.prepare('SELECT * FROM sponsor_purchases WHERE ' + column + ' = ?').get(value));
    },
    async updatePurchase(id, fields, whereStatusIn) {
      const keys = updateParts(fields);
      const params = [...keys.map((k) => fields[k]), id];
      let sql = 'UPDATE sponsor_purchases SET ' + keys.map((k) => k + ' = ?').join(', ') + ' WHERE id = ?';
      if (whereStatusIn) {
        sql += ' AND status IN (' + whereStatusIn.map(() => '?').join(', ') + ')';
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
  };
}

async function getDriver() {
  if (!driver) driver = PG_URL ? pgDriver() : sqliteDriver();
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

export async function clearRateLimit(key) {
  return (await getDriver()).clearRateLimit(key);
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

export async function purchasesForAdmin(limit = 60) {
  return (await getDriver()).purchasesForAdmin(limit);
}

// The headline number: total monthly cost of every subscription on the death list.
export function mrrDestroyed(apps) {
  return Math.round(apps.reduce((sum, a) => sum + (a.priceMonthly ?? 0), 0));
}
