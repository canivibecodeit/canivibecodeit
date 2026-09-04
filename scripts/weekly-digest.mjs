/* Weekly digest: collect the week from git history + the votes table, have a model
   write the copy, render the email, and broadcast it through Resend.

   Modes:
     (no flag)  dry run: render only, write the HTML preview, print a summary
     --test     dry run + send the rendered issue to DIGEST_TEST_EMAIL
     --send     create and send the real broadcast, then update the state file

   Config comes from the environment (real env wins over the local .env file):
   OPENROUTER_API_KEY, RESEND_API_KEY, RESEND_AUDIENCE_ID, DATABASE_PUBLIC_URL,
   DIGEST_ALERT_EMAIL, DIGEST_TEST_EMAIL. Nothing secret belongs in this file. */

import { execFileSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, mkdirSync, openSync, closeSync, renameSync,
  unlinkSync, statSync, truncateSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = '/srv/http/vibecodeit-data/digest';
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOCK_FILE = path.join(STATE_DIR, 'digest.lock');
const LOG_FILE = path.join(STATE_DIR, 'digest.log');
const LOCK_STALE_MS = 30 * 60 * 1000;
const LOG_MAX_BYTES = 1024 * 1024;

const SITE = 'https://vibecodeit.com';
const MODEL = 'anthropic/claude-opus-5';
const FROM = 'Faizan at vibecodeit <hello@send.vibecodeit.com>';
const REPLY_TO = 'hello@vibecodeit.com';
const MAX_ROWS = 8;
const MAX_QUIP = 45;

const MODE = process.argv.includes('--send') ? 'send'
  : process.argv.includes('--test') ? 'test'
    : 'dry';

const VERDICT_LABEL = { yes: 'YES', kinda: 'KINDA', no: 'NOT REALLY' };
const VERDICT_ORDER = ['yes', 'kinda', 'no'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const label = (verdict) => (Object.hasOwn(VERDICT_LABEL, verdict) ? VERDICT_LABEL[verdict] : String(verdict || ''));

/* ---------- env ---------- */

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
    // An empty env var is not a value: the .env entry still wins.
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
}

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name} in the environment`);
  return v;
}

/* ---------- small helpers ---------- */

/* stderr is captured, not inherited: expected misses (a slug with no JSON file)
   must not spam the cron log, and real failures still carry git's message. */
const git = (args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* House style: commas, never em dashes. Links belong on the site, not in copy. */
const deDash = (s) => String(s ?? '').replace(/\s*[—–]\s*/g, ', ');
const stripUrls = (s) =>
  String(s ?? '')
    .replace(/\bhttps?:\/\/\S+/gi, '')
    .replace(/\bwww\.\S+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

function truncate(s, max) {
  const clean = stripUrls(String(s ?? '').replace(/\s+/g, ' ')).trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '');
}

function isoWeekKey(date) {
  const t = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/* ---------- state, lock, log ---------- */

function readState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, STATE_FILE);
}

function acquireLock() {
  mkdirSync(STATE_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK_FILE, 'wx');
      closeSync(fd);
      writeFileSync(LOCK_FILE, `${process.pid} ${new Date().toISOString()}\n`);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age = 0;
      try {
        age = Date.now() - statSync(LOCK_FILE).mtimeMs;
      } catch {
        continue;
      }
      if (age < LOCK_STALE_MS) return false;
      console.error(`stale lock (${Math.round(age / 60000)} min old), taking it over`);
      try {
        unlinkSync(LOCK_FILE);
      } catch {}
    }
  }
  return false;
}

function releaseLock() {
  try {
    unlinkSync(LOCK_FILE);
  } catch {}
}

function rollLog() {
  try {
    if (statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      truncateSync(LOG_FILE, 0);
      console.log('digest.log passed 1 MB, truncated');
    }
  } catch {}
}

/* ---------- collection (reads origin/main only, never the working tree) ---------- */

function fetchOrigin() {
  try {
    git(['fetch', 'origin', 'main']);
    return true;
  } catch {
    return false;
  }
}

function showJson(ref, file) {
  try {
    return JSON.parse(git(['show', `${ref}:${file}`]));
  } catch {
    return null;
  }
}

/* Files added in the window, newest first. Topology range, not --since, so a merge
   of older work still counts as landing this week. */
function addedInWindow(range) {
  const args = ['log', '--diff-filter=A', '--name-only', '--format=', ...range, '--', 'data/apps'];
  const files = [];
  const seen = new Set();
  for (const line of git(args).split('\n')) {
    const file = line.trim();
    if (!file.endsWith('.json') || seen.has(file)) continue;
    seen.add(file);
    files.push(file);
  }
  return files;
}

/* Every live verdict on origin/main in one grep. This is the single source for what
   still exists and what it says, so the hero, the breakdown and the rows can never
   disagree, and files added then deleted inside the window drop out on their own. */
function verdictsByFile() {
  let out = '';
  try {
    out = git(['grep', '-E', '^\\s*"verdict": "(yes|kinda|no)"', 'origin/main', '--', 'data/apps']);
  } catch {
    console.error('git grep found no verdicts on origin/main');
    return new Map();
  }
  const map = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^origin\/main:(data\/apps\/[^:]+):\s*"verdict":\s*"(yes|kinda|no)"/);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

/* Files whose "verdict" value differs between the window-start commit and now.
   One diff beats one `git show` per changed file, and adds are excluded so a
   file that did not exist at window start can never look like a change. */
function verdictChanges(baseCommit) {
  if (!baseCommit) return [];
  const diff = git([
    'diff', '--unified=0', '--diff-filter=M', baseCommit, 'origin/main', '--', 'data/apps',
  ]);
  const changes = [];
  let file = null;
  let before = null;
  let after = null;
  const flush = () => {
    if (file && before && after && before !== after) changes.push({ file, before, after });
    before = null;
    after = null;
  };
  for (const line of diff.split('\n')) {
    const head = line.match(/^diff --git a\/(\S+) b\/(\S+)$/);
    if (head) {
      flush();
      file = head[2];
      continue;
    }
    const m = line.match(/^([+-])\s*"verdict":\s*"(yes|kinda|no)"/);
    if (!m) continue;
    if (m[1] === '-') before = m[2];
    else after = m[2];
  }
  flush();
  return changes;
}

/* Newest first, but every verdict present in the week keeps at least one row. */
function selectRows(candidates, max) {
  const picked = [];
  const taken = new Set();
  for (const verdict of VERDICT_ORDER) {
    if (picked.length >= max) break;
    const first = candidates.find((c) => c.verdict === verdict);
    if (first) {
      picked.push(first);
      taken.add(first.file);
    }
  }
  for (const c of candidates) {
    if (picked.length >= max) break;
    if (!taken.has(c.file)) {
      picked.push(c);
      taken.add(c.file);
    }
  }
  return picked;
}

async function topVotes(limit) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: need('DATABASE_PUBLIC_URL'), max: 1 });
  try {
    const r = await pool.query('SELECT slug, count FROM votes ORDER BY count DESC LIMIT $1', [limit]);
    return r.rows.map((row) => ({ slug: row.slug, count: Number(row.count) }));
  } finally {
    await pool.end().catch(() => {});
  }
}

/* ---------- copy ---------- */

function breakdownFrom(counts) {
  const parts = [];
  if (counts.yes) parts.push(`${counts.yes} you could replace by Friday`);
  if (counts.kinda) parts.push(`${counts.kinda} depends`);
  if (counts.no) parts.push(`${counts.no} keep paying`);
  return parts.join(' · ');
}

function fallbackCopy(data) {
  const quips = {};
  for (const app of data.rows) {
    quips[app.slug] = truncate(app.tagline || app.verdictSummary || '', MAX_QUIP);
  }
  const subject = data.lead === 'changes'
    ? `${data.changes.length} verdict${data.changes.length === 1 ? '' : 's'} changed this week, vibecodeit digest #${data.issueLabel}`
    : `${data.newCount} new verdicts this week, vibecodeit digest #${data.issueLabel}`;
  return {
    subject,
    greeting_line: 'hey,',
    breakdown_line: data.lead === 'changes' ? '' : breakdownFrom(data.counts),
    quips,
    most_wanted_aside: '',
  };
}

function buildPrompt(data) {
  const rows = data.rows.map((a) => ({
    slug: a.slug,
    name: a.name,
    verdict: a.verdict,
    tagline: a.tagline,
    why: truncate(a.verdictSummary, 240),
  }));
  const changes = data.changes.map((c) => ({ name: c.name, from: c.before, to: c.after }));
  const wanted = data.wanted.map((w) => ({ name: w.name, votes: w.count, verdict: w.verdict }));
  const leadNote = data.lead === 'changes'
    ? 'This issue has NO new verdicts. It leads on verdict changes, so "breakdown_line" must be an empty string and "quips" an empty object.'
    : `This issue leads on the ${data.newCount} new verdicts.`;
  return [
    'You write the weekly email for vibecodeit, a site that rules on whether a paid',
    'SaaS app is worth building yourself instead of paying for it. Verdicts are YES (build it),',
    'KINDA (depends), NOT REALLY (keep paying).',
    '',
    'Voice: dry, honest, slightly irreverent, engineer to engineer. No marketing-speak,',
    'no hype, no exclamation marks, no emoji, no URLs. The brand is written lowercase:',
    'vibecodeit. Use commas, NEVER em dashes or en dashes.',
    '',
    leadNote,
    '',
    'Data for this issue:',
    JSON.stringify({
      issue: data.issueLabel,
      newVerdictsTotal: data.newCount,
      newVerdictsByOutcome: data.counts,
      shown: rows,
      verdictChanges: changes,
      mostWantedDead: wanted,
      totalApps: data.totalApps,
    }, null, 1),
    '',
    'Return ONLY a JSON object, no prose, no code fences, with exactly these keys:',
    '  "subject": email subject line, under 60 characters, factual, curiosity without clickbait',
    '  "greeting_line": a short opener, two to five words, lowercase, e.g. "hey,"',
    `  "breakdown_line": one line splitting the ${data.newCount} new verdicts by outcome, using`,
    '      the exact numbers in "newVerdictsByOutcome", segments joined with " · ",',
    '      e.g. "2 you could replace by Friday · 3 depends · 2 keep paying"',
    '  "quips": an object keyed by the slugs in "shown", each value a single line of at most',
    `      ${MAX_QUIP} characters saying why that verdict landed where it did`,
    '  "most_wanted_aside": one short line, at most 90 characters, about what people are voting',
    '      to see replaced (empty string if there is nothing worth saying)',
  ].join('\n');
}

function parseCopy(text, data) {
  let raw = String(text || '').trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  if (!raw.startsWith('{')) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    raw = raw.slice(start, end + 1);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.subject !== 'string' || !parsed.subject.trim()) return null;
  if (data.rows.length && (!parsed.quips || typeof parsed.quips !== 'object')) return null;

  const fb = fallbackCopy(data);
  const quips = {};
  for (const app of data.rows) {
    const given = parsed.quips && typeof parsed.quips[app.slug] === 'string' ? parsed.quips[app.slug] : '';
    quips[app.slug] = truncate(deDash(given), MAX_QUIP) || fb.quips[app.slug];
  }
  const breakdown = data.lead === 'changes'
    ? ''
    : truncate(deDash(parsed.breakdown_line) || fb.breakdown_line, 140);
  return {
    subject: truncate(deDash(parsed.subject), 120) || fb.subject,
    greeting_line: truncate(deDash(parsed.greeting_line) || fb.greeting_line, 60),
    breakdown_line: breakdown,
    quips,
    most_wanted_aside: truncate(deDash(parsed.most_wanted_aside), 120),
  };
}

async function openrouterCopy(data) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const prompt = buildPrompt(data);
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = attempt === 0
      ? prompt
      : `${prompt}\n\nYour previous reply was not valid JSON. Reply with the JSON object and nothing else.`;
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1500,
          messages: [{ role: 'user', content }],
        }),
        signal: AbortSignal.timeout(180000),
      });
      if (!res.ok) {
        console.error(`openrouter: HTTP ${res.status}`);
        continue;
      }
      const body = await res.json();
      const copy = parseCopy(body?.choices?.[0]?.message?.content, data);
      if (copy) return copy;
      console.error('openrouter: reply was not usable JSON');
    } catch (err) {
      console.error(`openrouter: ${err.message}`);
    }
  }
  return null;
}

/* ---------- render ---------- */

const MONO = "font-family:'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace;";
const PILL_STYLE = {
  yes: 'background-color:#0e9c47; color:#ffffff;',
  kinda: 'background-color:#f5b300; color:#241800;',
  no: 'background-color:#e03131; color:#ffffff;',
};

function pillCell(verdict) {
  const style = Object.hasOwn(PILL_STYLE, verdict) ? PILL_STYLE[verdict] : PILL_STYLE.kinda;
  return `<td width="84" valign="top" style="width:84px; padding:0 12px 0 0;">`
    + `<span style="display:inline-block; width:84px; ${MONO} font-size:10px; font-weight:700;`
    + ` letter-spacing:.08em; line-height:18px; text-align:center; border-radius:4px;`
    + ` ${style}">${esc(label(verdict))}</span></td>`;
}

function nameCell(app, icons) {
  const icon = icons.has(app.slug)
    ? `<img src="${SITE}/icons/${esc(app.slug)}.png" width="18" height="18" alt=""`
      + ` style="width:18px; height:18px; border-radius:4px; vertical-align:middle; border:0;">&nbsp;&nbsp;`
    : '';
  return `<td width="150" valign="top" style="width:150px; padding:0 12px 0 0;">`
    + `${icon}<a href="${SITE}/${esc(app.slug)}" style="${MONO} font-size:13px; font-weight:700;`
    + ` color:#111111; text-decoration:none; vertical-align:middle;">${esc(app.name)}</a></td>`;
}

function quipCell(text) {
  return `<td valign="top" style="${MONO} font-size:12px; line-height:18px; color:#6e6e67;">${esc(text)}</td>`;
}

function sectionHead(text, color, extra) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"`
    + ` style="border-bottom:1px solid #e0e0db;"><tr><td style="padding:0 0 12px 0; ${MONO}`
    + ` font-size:11px; font-weight:700; letter-spacing:.14em; color:${color};">${text}`
    + `${extra ? `<span style="color:#6e6e67;"> ${extra}</span>` : ''}</td></tr></table>`;
}

function verdictRow(cells) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"`
    + ` style="border-bottom:1px solid #f0f0ec;"><tr><td style="padding:12px 0;">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table>`
    + `</td></tr></table>`;
}

function render(data, copy, icons) {
  const sent = data.sentAt;
  const meta = `WEEKLY DIGEST &middot; #${data.issueLabel} &middot; ${sent.getUTCDate()} `
    + `${MONTHS[sent.getUTCMonth()]} ${sent.getUTCFullYear()}`;

  const grouped = [];
  for (const verdict of VERDICT_ORDER) {
    for (const app of data.rows) if (app.verdict === verdict) grouped.push(app);
  }

  /* No rows to show means no hero number and no empty section: the changes lead. */
  const leadNumber = data.lead === 'changes' ? data.changes.length : data.newCount;
  const leadWords = data.lead === 'changes'
    ? `&nbsp;verdict${data.changes.length === 1 ? '' : 's'} changed this week`
    : '&nbsp;new verdicts this week';

  let newVerdictsHtml = '';
  if (grouped.length) {
    let rowsHtml = '';
    for (const app of grouped) {
      rowsHtml += verdictRow(pillCell(app.verdict) + nameCell(app, icons) + quipCell(copy.quips[app.slug] || ''));
    }
    const extra = data.newCount - grouped.length;
    const moreLine = extra > 0
      ? `<p style="margin:14px 0 0 0; ${MONO} font-size:12px; line-height:18px; color:#6e6e67;">`
        + `<a href="${SITE}" style="color:#6e6e67; text-decoration:none;">`
        + `+${extra} more on the site</a></p>`
      : '';
    newVerdictsHtml = `${sectionHead('NEW VERDICTS', '#111111', '')}${rowsHtml}${moreLine}`;
  }

  let changesHtml = '';
  if (data.changes.length) {
    let inner = '';
    for (const c of data.changes) {
      const was = `was ${label(c.before)}, now ${label(c.after)}`;
      inner += verdictRow(pillCell(c.after) + nameCell(c, icons) + quipCell(was));
    }
    const pad = newVerdictsHtml ? '32px 0 0 0' : '0';
    changesHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>`
      + `<td style="padding:${pad};">${sectionHead('VERDICT CHANGES', '#111111', '')}${inner}</td></tr></table>`;
  }

  let wantedHtml = '';
  if (data.wanted.length) {
    let inner = '';
    data.wanted.forEach((w, i) => {
      const delta = typeof w.delta === 'number' && w.delta > 0 ? `, +${w.delta} this week` : '';
      const line = `${w.count} votes &middot; verdict: ${esc(label(w.verdict))}${esc(delta)}`;
      const rank = `<td width="24" valign="top" style="width:24px; ${MONO} font-size:12px;`
        + ` font-weight:700; line-height:18px; color:#6e6e67;">${String(i + 1).padStart(2, '0')}</td>`;
      const meta2 = `<td valign="top" style="${MONO} font-size:12px; line-height:18px; color:#6e6e67;">${line}</td>`;
      inner += verdictRow(rank + nameCell(w, icons) + meta2);
    });
    const aside = copy.most_wanted_aside
      ? `<p style="margin:14px 0 0 0; ${MONO} font-size:12px; line-height:18px; color:#6e6e67;">`
        + `${esc(copy.most_wanted_aside)}</p>`
      : '';
    wantedHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>`
      + `<td style="padding:32px 0 0 0;">${sectionHead('MOST WANTED DEAD', '#e03131', 'BY YOUR VOTES')}`
      + `${inner}${aside}</td></tr></table>`;
  }

  const breakdownHtml = copy.breakdown_line
    ? `<p style="margin:0 0 30px 0; ${MONO} font-size:13px; line-height:20px; color:#6e6e67;">${esc(copy.breakdown_line)}</p>`
    : `<div style="height:30px; line-height:30px;">&nbsp;</div>`;

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0; padding:0; background-color:#f2f2f0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f2f2f0;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background-color:#ffffff; border:1px solid #e0e0db; border-radius:8px;">
          <tr>
            <td style="padding:40px 48px;">
              <!-- logo lockup -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding:4px 0 14px 0;">
                    <span style="display:inline-block; vertical-align:middle; width:30px; height:30px; line-height:28px; border:3px solid #0e9c47; border-radius:8px; text-align:center; ${MONO} font-size:18px; font-weight:700; color:#0e9c47;">?|</span>
                    <span style="display:inline-block; vertical-align:middle; margin-left:10px; ${MONO} font-size:17px; font-weight:500; color:#111111;">vibecode<span style="color:#0e9c47;">it</span></span>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:0 0 28px 0; ${MONO} font-size:11px; letter-spacing:.14em; color:#6e6e67;">${meta}</td>
                </tr>
              </table>
              <!-- greeting + hero -->
              <p style="margin:0 0 18px 0; ${MONO} font-size:14px; line-height:23px; color:#222222;">${esc(copy.greeting_line)}</p>
              <p style="margin:0 0 6px 0; ${MONO} font-size:64px; line-height:70px;"><span style="font-size:64px; font-weight:800; letter-spacing:-0.03em; color:#111111;">${leadNumber}</span><span style="font-size:20px; font-weight:500; color:#111111;">${leadWords}</span></p>
              ${breakdownHtml}
              ${newVerdictsHtml}
              ${changesHtml}
              ${wantedHtml}
              <!-- cta -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding:34px 0 30px 0;">
                    <a href="${SITE}" style="display:inline-block; background-color:#0e9c47; border-radius:6px; padding:12px 26px; ${MONO} font-size:13px; font-weight:700; color:#ffffff; text-decoration:none;">browse all ${data.totalApps} verdicts &rarr;</a>
                  </td>
                </tr>
              </table>
              <!-- footer -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e0e0db;">
                <tr>
                  <td align="center" style="padding:18px 0 0 0;">
                    <p style="margin:0 0 6px 0; ${MONO} font-size:11.5px; line-height:18px; color:#6e6e67;">You're getting this because you signed up on vibecodeit.com.</p>
                    <p style="margin:0; ${MONO} font-size:11.5px; line-height:18px; color:#6e6e67;"><a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#0e9c47; text-decoration:underline;">Unsubscribe</a>, one click, no hard feelings.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/* ---------- resend ---------- */

async function resend(pathname, body) {
  const res = await fetch(`https://api.resend.com${pathname}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${need('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`resend ${pathname}: HTTP ${res.status} ${json?.message || ''}`.trim());
  return json;
}

async function resendGet(pathname) {
  const res = await fetch(`https://api.resend.com${pathname}`, {
    headers: { Authorization: `Bearer ${need('RESEND_API_KEY')}` },
    signal: AbortSignal.timeout(60000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`resend GET ${pathname}: HTTP ${res.status} ${json?.message || ''}`.trim());
    err.status = res.status;
    throw err;
  }
  return json;
}

/* Resend refuses the whole broadcast (HTTP 422) while any RFC 2606 reserved
   address sits in the audience, so sweep them out before every send. The signup
   endpoint blocks these too; this covers dashboard imports and older rows. */
async function sweepFakeContacts() {
  const aud = need('RESEND_AUDIENCE_ID');
  const body = await resendGet(`/audiences/${aud}/contacts`);
  const fakes = (body?.data ?? []).filter((c) => {
    const domain = String(c.email || '').toLowerCase().split('@').pop();
    return ['example.com', 'example.org', 'example.net', 'example.edu'].includes(domain)
      || ['.test', '.invalid', '.example', '.localhost'].some((t) => domain.endsWith(t));
  });
  for (const c of fakes) {
    const res = await fetch(`https://api.resend.com/audiences/${aud}/contacts/${c.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${need('RESEND_API_KEY')}` },
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`could not delete fake contact ${c.email}: HTTP ${res.status}`);
    console.log(`removed fake contact ${c.email} from the audience`);
    await new Promise((r) => setTimeout(r, 650));
  }
}

async function alert(subject, text) {
  const to = process.env.DIGEST_ALERT_EMAIL;
  if (!to || !process.env.RESEND_API_KEY) return;
  await resend('/emails', { from: FROM, to, reply_to: REPLY_TO, subject, text });
}

/* A run that died between "broadcast created" and "broadcast sent" leaves a pending
   id. Resolve it against Resend rather than risk creating a second broadcast. */
async function reconcilePending(state) {
  const id = state.pendingBroadcastId;
  if (!id) return state;

  const clearPending = (next) => {
    delete next.pendingBroadcastId;
    delete next.prevIssue;
    delete next.prevLastSentAt;
    return next;
  };

  let broadcast;
  try {
    broadcast = await resendGet(`/broadcasts/${id}`);
  } catch (err) {
    if (err.status !== 404) throw err;
    // Deleted in the dashboard: roll the pre-send write back and carry on.
    const rolled = clearPending({ ...state });
    if (state.prevLastSentAt) rolled.lastSentAt = state.prevLastSentAt;
    else delete rolled.lastSentAt;
    if (Number.isFinite(Number(state.prevIssue))) rolled.issue = Number(state.prevIssue);
    else delete rolled.issue;
    writeState(rolled);
    console.error(`pending broadcast ${id} no longer exists, rolled state back to issue ${rolled.issue ?? 0}`);
    return rolled;
  }

  const status = String(broadcast?.status || '').toLowerCase();
  if (status && status !== 'draft') {
    const resolved = clearPending({ ...state, lastBroadcastId: id });
    writeState(resolved);
    console.error(`pending broadcast ${id} reports "${status}", treating it as sent`);
    return resolved;
  }
  throw new Error(
    `broadcast ${id} was created but never sent (status "${status || 'unknown'}"). `
    + 'In the Resend dashboard, either send that draft, then clear only pendingBroadcastId in '
    + 'state.json, or delete the draft, then clear pendingBroadcastId AND lastSentAt and set '
    + `issue back to ${state.prevIssue ?? 0} so issue #${String((Number(state.issue) || 0)).padStart(3, '0')} is reused.`
  );
}

/* ---------- main ---------- */

async function main() {
  loadEnvFile(path.join(root, '.env'));
  rollLog();

  let state = readState();
  const sentAt = new Date();

  if (state.pendingBroadcastId) {
    if (MODE === 'send') state = await reconcilePending(state);
    else console.error(`note: state.json holds pending broadcast ${state.pendingBroadcastId}`);
  }

  const lastSentAt = state.lastSentAt ? new Date(state.lastSentAt) : null;
  const lastSentBad = state.lastSentAt !== undefined && state.lastSentAt !== null
    && (!lastSentAt || Number.isNaN(lastSentAt.getTime()));
  if (lastSentBad) {
    // Unreadable history: assume a send already happened rather than send twice.
    console.error(`state.json has an unusable lastSentAt (${JSON.stringify(state.lastSentAt)})`);
    if (MODE === 'send') {
      console.error('refusing: fix or remove lastSentAt in state.json before sending');
      process.exit(1);
    }
  }
  if (MODE === 'send' && lastSentAt && !lastSentBad && isoWeekKey(lastSentAt) === isoWeekKey(sentAt)) {
    console.error(`refusing: a digest already went out in ${isoWeekKey(sentAt)} (${state.lastSentAt})`);
    process.exit(1);
  }

  const issue = (Number(state.issue) || 0) + 1;
  const issueLabel = String(issue).padStart(3, '0');

  const online = fetchOrigin();
  if (!online) console.error('git fetch failed, using the local origin/main ref');
  git(['rev-parse', '--verify', 'origin/main']);

  const since = (lastSentAt && !lastSentBad)
    ? lastSentAt.toISOString()
    : new Date(Date.now() - 7 * 86400000).toISOString();
  let baseCommit = git(['rev-list', '-1', `--before=${since}`, 'origin/main']).trim();
  let windowRange = [`${baseCommit}..origin/main`];
  if (!baseCommit) {
    baseCommit = git(['rev-list', '--max-parents=0', 'origin/main']).trim().split('\n')[0] || '';
    windowRange = ['origin/main'];
    console.error(`no commit predates ${since}, base synthesized as the root commit (${baseCommit.slice(0, 7)}), window covers all history`);
  }

  /* One source of truth for what exists and what it says. */
  const byFile = verdictsByFile();
  const addedFiles = addedInWindow(windowRange);
  if (addedFiles.length && byFile.size === 0) {
    // Files landed but the grep saw no verdicts anywhere: that is a broken read,
    // not a quiet week, and it must not skip the issue silently.
    throw new Error(
      `git grep returned no verdicts on origin/main while ${addedFiles.length} app files were added in the window`
    );
  }
  const candidates = addedFiles
    .filter((file) => byFile.has(file))
    .map((file) => ({ file, verdict: byFile.get(file) }));
  const newCount = candidates.length;

  const counts = { yes: 0, kinda: 0, no: 0 };
  for (const c of candidates) if (Object.hasOwn(counts, c.verdict)) counts[c.verdict]++;

  const rows = [];
  for (const c of selectRows(candidates, MAX_ROWS)) {
    const app = showJson('origin/main', c.file);
    if (app?.slug && app?.name && VERDICT_ORDER.includes(c.verdict)) {
      rows.push({
        slug: app.slug,
        name: app.name,
        verdict: c.verdict,
        tagline: app.tagline || '',
        verdictSummary: app.verdictSummary || '',
      });
    }
  }

  const changes = [];
  for (const c of verdictChanges(baseCommit)) {
    const app = showJson('origin/main', c.file);
    if (app?.slug && app?.name) {
      changes.push({ slug: app.slug, name: app.name, verdict: app.verdict, before: c.before, after: c.after });
    }
  }

  const totalApps = git(['ls-tree', '-r', '--name-only', 'origin/main', 'data/apps'])
    .split('\n').filter((f) => f.endsWith('.json')).length;

  const icons = new Set(
    git(['ls-tree', '-r', '--name-only', 'origin/main', 'public/icons'])
      .split('\n').filter((f) => f.endsWith('.png')).map((f) => path.basename(f, '.png'))
  );

  const snapshot = state.votes && typeof state.votes === 'object' ? state.votes : null;
  const wanted = [];
  let voteRows = [];
  try {
    voteRows = await topVotes(3);
  } catch (err) {
    // Votes are a section, not the point: a database miss must not stop the digest.
    console.error(`votes unavailable, MOST WANTED DEAD omitted: ${err.message}`);
  }
  for (const v of voteRows) {
    const app = showJson('origin/main', `data/apps/${v.slug}.json`);
    if (!app?.name) continue;
    const prev = snapshot && typeof snapshot[v.slug] === 'number' ? snapshot[v.slug] : null;
    wanted.push({
      slug: v.slug,
      name: app.name,
      verdict: app.verdict,
      count: v.count,
      delta: prev === null ? null : v.count - prev,
    });
  }

  if (rows.length === 0 && changes.length === 0) {
    const note = newCount === 0
      ? `Quiet week: no new verdicts and no verdict changes since ${since}. No digest sent.`
      : `Nothing renderable: ${newCount} new verdict files could not be read and no verdict changes since ${since}. No digest sent.`;
    console.log(note);
    if (MODE === 'send') await alert('vibecodeit digest skipped, quiet week', note);
    return;
  }

  const lead = rows.length ? 'new' : 'changes';
  const data = { rows, changes, wanted, counts, newCount, totalApps, issueLabel, sentAt, lead };
  const ai = await openrouterCopy(data);
  const copy = ai || fallbackCopy(data);
  const html = render(data, copy, icons);

  mkdirSync(STATE_DIR, { recursive: true });
  const previewPath = path.join(STATE_DIR, `preview-issue-${issueLabel}.html`);
  writeFileSync(previewPath, html);

  console.log(`issue #${issueLabel} (${MODE}), leading on ${lead}`);
  console.log(`window since: ${since}`);
  console.log(`new verdicts: ${newCount} (${counts.yes} yes, ${counts.kinda} kinda, ${counts.no} no), showing ${rows.length}`);
  console.log(`verdict changes: ${changes.length}`);
  console.log(`most wanted dead: ${wanted.map((w) => `${w.slug}=${w.count}`).join(', ') || 'none'}`);
  console.log(`total apps: ${totalApps}`);
  console.log(`copy: ${ai ? 'model' : 'fallback'}`);
  console.log(`subject: ${copy.subject}`);
  console.log(`preview: ${previewPath}`);

  if (MODE === 'test') {
    await resend('/emails', {
      from: FROM,
      to: need('DIGEST_TEST_EMAIL'),
      reply_to: REPLY_TO,
      subject: `[TEST] ${copy.subject}`,
      html,
    });
    console.log('test email sent');
    return;
  }

  if (MODE === 'send') {
    await sweepFakeContacts();
    const created = await resend('/broadcasts', {
      audience_id: need('RESEND_AUDIENCE_ID'),
      from: FROM,
      reply_to: REPLY_TO,
      subject: copy.subject,
      preview_text: truncate(copy.breakdown_line || copy.subject, 140),
      html,
    });
    if (!created?.id) throw new Error('resend /broadcasts: no broadcast id returned');
    // Written before the send call: a timeout after acceptance must not double-send.
    const votes = Object.fromEntries(voteRows.map((v) => [v.slug, v.count]));
    const sentState = {
      issue,
      lastSentAt: sentAt.toISOString(),
      lastBroadcastId: created.id,
      votes: voteRows.length ? votes : (snapshot || {}),
    };
    writeState({
      ...sentState,
      pendingBroadcastId: created.id,
      prevIssue: Number(state.issue) || 0,
      prevLastSentAt: state.lastSentAt || null,
    });
    await resend(`/broadcasts/${created.id}/send`, {});
    writeState(sentState);
    console.log(`broadcast sent: ${created.id}`);
  }
}

let locked = false;
// An exit hook, because the refusal paths call process.exit and must still free it.
process.on('exit', () => {
  if (locked) releaseLock();
});

try {
  locked = acquireLock();
  if (!locked) {
    console.error('another digest run holds the lock, exiting');
    process.exit(1);
  }
  await main();
} catch (err) {
  const message = err?.message || String(err);
  console.error(`digest failed: ${message}`);
  if (MODE !== 'dry') {
    try {
      await alert('vibecodeit digest FAILED', `Weekly digest failed: ${message}`);
    } catch (alertErr) {
      console.error(`alert failed: ${alertErr?.message || alertErr}`);
    }
  }
  process.exit(1);
}
