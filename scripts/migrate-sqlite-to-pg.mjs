/* One-shot, idempotent migration: copies votes, waitlist, and sponsors from a
   local SQLite file into the Postgres pointed at by DATABASE_URL.

   Run with Railway CLI so DATABASE_URL is injected:
     SQLITE_PATH=/srv/http/vibecodeit-data/site.db railway run node scripts/migrate-sqlite-to-pg.mjs

   Idempotent: votes take the MAX of both sides, emails/sponsors upsert-ignore,
   so running it twice can never lose or double anything. */
import Database from 'better-sqlite3';
import pg from 'pg';
import path from 'node:path';

const sqlitePath =
  process.env.SQLITE_PATH || path.join(process.env.DATA_DIR || 'data/private', 'site.db');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL not set');

const src = new Database(sqlitePath, { readonly: true });
const dst = new pg.Pool({ connectionString: url, max: 2 });

const votes = src.prepare('SELECT slug, count FROM votes').all();
const waitlist = src.prepare('SELECT email, created_at FROM waitlist').all();
const sponsors = src.prepare('SELECT email, message, created_at FROM sponsors').all();

for (const v of votes) {
  await dst.query(
    `INSERT INTO votes (slug, count) VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET count = GREATEST(votes.count, EXCLUDED.count)`,
    [v.slug, v.count]
  );
}
for (const w of waitlist) {
  await dst.query(
    `INSERT INTO waitlist (email, created_at) VALUES ($1, $2::timestamptz)
     ON CONFLICT (email) DO NOTHING`,
    [w.email, w.created_at + 'Z']
  );
}
for (const s of sponsors) {
  await dst.query(
    `INSERT INTO sponsors (email, message, created_at)
     SELECT $1, $2, $3::timestamptz
     WHERE NOT EXISTS (
       SELECT 1 FROM sponsors WHERE email = $1 AND created_at = $3::timestamptz
     )`,
    [s.email, s.message, s.created_at + 'Z']
  );
}

const [pv, pw, ps] = await Promise.all([
  dst.query('SELECT count(*) n, coalesce(sum(count),0) total FROM votes'),
  dst.query('SELECT count(*) n FROM waitlist'),
  dst.query('SELECT count(*) n FROM sponsors'),
]);
console.log(`sqlite  → votes rows ${votes.length} (sum ${votes.reduce((s, v) => s + v.count, 0)}), waitlist ${waitlist.length}, sponsors ${sponsors.length}`);
console.log(`postgres → votes rows ${pv.rows[0].n} (sum ${pv.rows[0].total}), waitlist ${pw.rows[0].n}, sponsors ${ps.rows[0].n}`);
await dst.end();
console.log('migration complete — verify the two lines above match or exceed.');
