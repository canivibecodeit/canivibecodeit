/* CSP violation reports, browser-POSTed. Private by design: one truncated
   line into the server log (Railway, token-gated), nothing stored, nothing
   rendered anywhere. Every field is attacker-suppliable (anyone can POST
   here), so: URLs are logged as pathname only (admin/sponsor/signed-action
   URLs carry secret tokens in the query string, and browsers put the full
   query in reports), everything is control-stripped and length-capped, and
   the endpoint never echoes anything back.

   NEVER widen the policy from a report alone: reports are forgeable and a
   line here proves nothing. Reproduce the violation in a real browser first. */
import { rateLimit } from '../../lib/db.js';
import { clientIp } from '../../lib/request.js';

// [kebab report-uri key, camel Reporting-API key] pairs; URL-ish fields get
// reduced to a pathname.
const FIELDS = [
  ['violated-directive', 'effectiveDirective', false],
  ['blocked-uri', 'blockedURL', false],
  ['document-uri', 'documentURL', true],
  ['source-file', 'sourceFile', true],
  ['line-number', 'lineNumber', false],
  ['script-sample', 'sample', false],
];
const STRIP = /[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e]/g;

const clean = (v) => String(v ?? '').replace(STRIP, ' ').slice(0, 120);

const pathOnly = (v) => {
  const s = String(v ?? '');
  if (!/^https?:/i.test(s)) return s; // "inline", "eval", "data" pass through
  try {
    return new URL(s).pathname;
  } catch {
    return '';
  }
};

/* In-memory pre-limit ahead of the DB-backed one: reports are browser-
   automatic, so a systemic violation (or a flood) would otherwise turn every
   visitor into a DB load generator against the pool that renders pages. */
let bucketStart = 0;
let bucketCount = 0;

export async function POST({ request, clientAddress }) {
  const done = new Response(null, { status: 204 });
  try {
    const now = Date.now();
    if (now - bucketStart > 60 * 1000) {
      bucketStart = now;
      bucketCount = 0;
    }
    if (++bucketCount > 60) return done;
    const ip = clientIp(request, clientAddress);
    if (!(await rateLimit(`csp:${ip}`, 20, 10 * 60 * 1000))) return done;
    if (Number(request.headers.get('content-length') || 0) > 16384) {
      console.warn('csp-report: oversized report dropped');
      return done;
    }
    let body;
    try {
      body = JSON.parse((await request.text()) || '{}');
    } catch {
      console.warn('csp-report: unparseable report dropped');
      return done;
    }
    // Classic report-uri wraps the report in "csp-report"; the Reporting API
    // sends an array of {body} entries. Take the first thing that looks real.
    const report = body['csp-report'] || (Array.isArray(body) ? body[0]?.body : body) || {};
    const line = FIELDS.map(([kebab, camel, isUrl]) => {
      const raw = report[kebab] ?? report[camel];
      return `${kebab}=${clean(isUrl ? pathOnly(raw) : raw)}`;
    }).join(' ');
    console.warn(`csp-report: ${line}`);
  } catch {
    // A malformed report is not our problem.
  }
  return done;
}
