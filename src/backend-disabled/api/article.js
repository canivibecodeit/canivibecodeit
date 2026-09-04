// Submit a guide for the sunday newsletter: validate, store as pending, email
// Faizan. Synchronous on purpose, unlike /api/submit — there is no AI draft and
// no PR to open here, so the writer gets a real answer in one request instead of
// polling. Nothing this endpoint stores is ever rendered publicly; review
// happens at /admin/articles.
import { randomUUID } from 'node:crypto';
import { insertArticle, rateLimit } from '../../lib/db.js';
import { validateArticle, wordCount } from '../../lib/articles.js';
import { alertAdmin } from '../../lib/mail.js';
import { clientIp, crossOrigin, json, readBody } from '../../lib/request.js';

const escape = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export async function POST({ request, locals, clientAddress }) {
  if (crossOrigin(request)) return json({ error: 'bad origin' }, 403);

  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  // Honeypot: a real writer never fills this hidden field. Answer exactly like
  // a success so the bot has nothing to learn from the difference.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return json({ ok: true, id: randomUUID() }, 202);
  }

  const check = validateArticle(body);
  if (!check.ok) return json({ error: check.error }, 400);
  const article = check.value;

  const ip = clientIp(request, clientAddress);
  if (!(await rateLimit(`article:${ip}`, 3, 24 * 60 * 60 * 1000))) {
    return json({ error: 'three drafts a day is plenty · send the next one tomorrow' }, 429);
  }
  // Global fuse. Unlike /submit there is no per-submission cost here, so this
  // is only about keeping the review queue readable by a human.
  if (!(await rateLimit('article:all', 100, 24 * 60 * 60 * 1000))) {
    return json({ error: 'the queue is full for today, try again tomorrow' }, 429);
  }

  const id = randomUUID();
  await insertArticle({
    id,
    title: article.title,
    author: article.author,
    email: article.email,
    link: article.link,
    summary: article.summary,
    body: article.body,
    status: 'pending',
    user_id: locals.user?.id ?? null,
    created_at: Date.now(),
  });

  // Fire and forget: the row is the source of truth, and a mail outage must
  // never cost the writer their draft.
  alertAdmin(
    `[vibecodeit] guide submitted: ${article.title}`,
    `<p><b>${escape(article.title)}</b> by ${escape(article.author)} (${escape(article.email)})</p>
     <p>${wordCount(article.body).toLocaleString('en-US')} words${article.link ? ` · <a href="${escape(article.link)}">${escape(article.link)}</a>` : ''}</p>
     ${article.summary ? `<p>${escape(article.summary)}</p>` : ''}
     <p>Review it at /admin/articles.</p>`
  ).catch((err) => console.error(`article alert failed: ${err.message}`));

  return json({ ok: true, id }, 202);
}
