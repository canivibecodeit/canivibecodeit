/* Nightly search-audit export: pulls new rows from the searches table and
   appends them to a plain-text file outside the repo, so the full history of
   what people typed into the search box survives independently of the
   database and of PostHog's one-year free-tier retention.

   Append-only TSV, one line per search:
     id  ISO-timestamp  country  hits  query
   The query is re-sanitised here (tabs, newlines, control chars stripped) so
   one line is always one search, no matter what the DB row contains.

   State: .last-id in the state dir remembers the highest exported row id, so
   every run is incremental and a re-run appends nothing twice.

   Modes:
     --sqlite   read the local dev database instead of the production Postgres

   Config from the environment (real env wins over the local .env file):
   DATABASE_PUBLIC_URL. Nothing secret belongs in this file. */

import { readFileSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = process.env.SEARCH_STATE_DIR || '/srv/http/vibecodeit-data/searches';
const AUDIT_FILE = path.join(STATE_DIR, 'search-audit.txt');
const STATE_FILE = path.join(STATE_DIR, '.last-id');
const BATCH = 5000;

const USE_SQLITE = process.argv.includes('--sqlite');

function loadEnvFile(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = (value.startsWith('"') && value.endsWith('"') && value.length > 1)
      || (value.startsWith("'") && value.endsWith("'") && value.length > 1);
    if (quoted) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
}

async function openDb() {
  if (USE_SQLITE || !process.env.DATABASE_PUBLIC_URL) {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(path.join(root, 'data/private/site.db'), { readonly: true });
    return {
      async rowsAfter(id, limit) {
        return db
          .prepare('SELECT id, query, hits, country, created_at FROM searches WHERE id > ? ORDER BY id LIMIT ?')
          .all(id, limit);
      },
      async close() {},
    };
  }
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_PUBLIC_URL, max: 1 });
  return {
    async rowsAfter(id, limit) {
      const r = await pool.query(
        'SELECT id, query, hits, country, created_at FROM searches WHERE id > $1 ORDER BY id LIMIT $2',
        [id, limit]
      );
      return r.rows.map((x) => ({ ...x, id: Number(x.id), created_at: Number(x.created_at) }));
    },
    async close() {
      await pool.end();
    },
  };
}

// One line must stay one line: strip anything that could fake or split rows.
const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();

function lastExportedId() {
  try {
    const n = Number(readFileSync(STATE_FILE, 'utf8').trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

loadEnvFile(path.join(root, '.env'));
mkdirSync(STATE_DIR, { recursive: true });

const db = await openDb();
let lastId = lastExportedId();
let exported = 0;

try {
  for (;;) {
    const rows = await db.rowsAfter(lastId, BATCH);
    if (rows.length === 0) break;
    const lines = rows
      .map((r) =>
        [
          r.id,
          new Date(Number(r.created_at)).toISOString(),
          clean(r.country) || '--',
          Number(r.hits) || 0,
          clean(r.query),
        ].join('\t')
      )
      .join('\n');
    appendFileSync(AUDIT_FILE, lines + '\n');
    lastId = rows[rows.length - 1].id;
    writeFileSync(STATE_FILE, String(lastId));
    exported += rows.length;
    if (rows.length < BATCH) break;
  }
  console.log(`${new Date().toISOString()} exported ${exported} searches (through id ${lastId})`);
} catch (err) {
  // The table appears on prod with the first deploy that ships it; until then
  // (or on a network blip) log and try again tomorrow.
  if (err.code === '42P01') {
    console.log(`${new Date().toISOString()} searches table not in production yet, nothing to export`);
  } else {
    console.error(`${new Date().toISOString()} export failed:`, err.message);
    process.exitCode = 1;
  }
} finally {
  await db.close();
}
