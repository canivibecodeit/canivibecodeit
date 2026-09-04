// Submit an app: POST validates + dedupes, inserts a submissions row, kicks
// the AI-draft → PR pipeline off in the background and returns 202 with an id.
// The page then polls GET ?id= until the row hits a terminal status. Async on
// purpose: the draft takes about a minute, longer than Cloudflare will hold a
// proxied request open.
import { randomUUID } from 'node:crypto';
import { getApp } from '../../lib/apps.js';
import {
  insertSubmission,
  openSubmissionBySlug,
  rateLimit,
  submissionById,
} from '../../lib/db.js';
import { alertAdmin } from '../../lib/mail.js';
import { clientIp, crossOrigin, json, readBody } from '../../lib/request.js';
import {
  appByDomain,
  findOpenPr,
  githubConfigured,
  processSubmission,
  slugify,
} from '../../lib/submissions.js';

const OPEN_STATUSES = ['queued', 'drafting', 'opening'];
const STALL_MS = 10 * 60 * 1000;

const clean = (v, max) =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

function parseAppUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u;
  try {
    u = new URL(withProto);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  // Real public product domains only: no bare hosts, no IP literals, nothing
  // that could point the pipeline's favicon fetch at internal services.
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(host)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.endsWith('.local') || host.endsWith('.internal')) return null;
  return u;
}

export async function POST({ request, locals, clientAddress }) {
  if (crossOrigin(request)) return json({ error: 'bad origin' }, 403);
  if (!githubConfigured() || !process.env.OPENROUTER_API_KEY) {
    return json({ error: 'submissions are warming up, try again soon (or open a PR directly)' }, 503);
  }

  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  // Honeypot: a real visitor never fills this hidden field.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return json({ ok: true, id: randomUUID() }, 202);
  }

  const name = clean(body.name, 80);
  const take = clean(body.take, 1000);
  const submitter = clean(body.submitter, 60);
  const url = parseAppUrl(clean(body.url, 300));
  if (!name || name.length < 2) return json({ error: 'give the app a name' }, 400);
  if (!url) return json({ error: 'that URL does not look like a public product site' }, 400);

  const ip = clientIp(request, clientAddress);
  if (!(await rateLimit(`submit:${ip}`, 3, 60 * 60 * 1000))) {
    return json({ error: 'three submissions an hour is plenty. back soon.' }, 429);
  }
  // Global caps: every submission is an AI draft, so a flood is a bill — but
  // a viral day is the point of this form, so the ceiling is sized for one
  // (~$0.10 worst case per draft; 200/day tops out around $20). The hourly
  // fuse keeps a bot from burning the whole day's budget in one burst, and
  // Faizan gets one email per day when either cap trips so a genuine rush can
  // be answered by bumping the numbers.
  if (
    !(await rateLimit('submit:all:hour', 40, 60 * 60 * 1000)) ||
    !(await rateLimit('submit:all', 200, 24 * 60 * 60 * 1000))
  ) {
    if (await rateLimit('submit:cap-alert', 1, 24 * 60 * 60 * 1000)) {
      alertAdmin(
        '[cvci] submission rate cap tripped',
        '<p>The global /submit cap (40/hr or 200/day) just tripped. Viral day or bot flood — check Railway logs and the submissions table. Caps live in src/pages/api/submit.js.</p>'
      ).catch((err) => console.error(`submit cap alert failed: ${err.message}`));
    }
    return json({ error: 'the submission queue is full right now, try again in a bit (or open a PR directly)' }, 429);
  }

  const slug = slugify(name);
  if (!slug) return json({ error: 'give the app a name' }, 400);

  const existing = getApp(slug) || appByDomain(url.hostname);
  if (existing) {
    return json({ error: 'already on the list', existingSlug: existing.slug }, 409);
  }
  if (await openSubmissionBySlug(slug)) {
    return json({ error: 'someone is submitting this app right now, give it a minute' }, 409);
  }
  // Best-effort: an open PR for this slug means it's already in review.
  const openPr = await findOpenPr(slug).catch(() => null);
  if (openPr) return json({ error: 'a PR for this app is already open', prUrl: openPr }, 409);

  const id = randomUUID();
  await insertSubmission({
    id,
    slug,
    app_name: name,
    app_url: url.href,
    take: take || null,
    submitter: submitter || null,
    user_id: locals.user?.id ?? null,
    status: 'queued',
    created_at: Date.now(),
  });

  // Fire and forget: the Node adapter keeps the process alive, the row is the
  // source of truth, and the client polls. Never await this.
  processSubmission(id, { name, url: url.href, take, submitter, slug }).catch((err) =>
    console.error(`submit ${id}: ${err.message}`)
  );

  return json({ ok: true, id }, 202);
}

export async function GET({ request, url, clientAddress }) {
  const ip = clientIp(request, clientAddress);
  if (!(await rateLimit(`submitpoll:${ip}`, 120, 60 * 1000))) {
    return json({ error: 'slow down' }, 429);
  }
  const id = url.searchParams.get('id') ?? '';
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: 'bad id' }, 400);
  const row = await submissionById(id);
  if (!row) return json({ error: 'unknown submission' }, 404);

  let status = row.status;
  if (OPEN_STATUSES.includes(status) && Date.now() - Number(row.updated_at) > STALL_MS) {
    status = 'stalled';
  }
  return json({
    status,
    prUrl: row.pr_url ?? null,
    // Only rejection/failure reasons are meant for the visitor's eyes.
    message: status === 'rejected' || status === 'failed' ? (row.error ?? null) : null,
  });
}
