// Guide moderation: accept (pending -> accepted, goes into a sunday issue) or
// reject (pending -> rejected, with an optional note to remember why). Token
// gated like the sponsor and build admins; form posts bounce back to
// /admin/articles with a message, JSON callers get JSON.
import { articleById, updateArticle } from '../../../lib/db.js';
import { cleanLine } from '../../../lib/articles.js';
import { json, readBody } from '../../../lib/request.js';
import { isAdmin } from '../../../lib/sponsors.js';

const ID_RE = /^[0-9a-f-]{36}$/;

export async function POST({ request }) {
  const wantsJson = (request.headers.get('content-type') || '').includes('application/json');

  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  // A wrong or missing token looks exactly like a route that does not exist.
  if (!isAdmin(body.token)) return json({ error: 'not found' }, 404);

  // Same-origin paths only: "//evil.com" and "/\evil.com" are both absolute to
  // a browser, so a leading slash on its own proves nothing.
  const backTo = (message) => {
    const back = String(body.return_to || '');
    const target = /^\/(?![/\\])/.test(back) ? back : '/';
    const sep = target.includes('?') ? '&' : '?';
    return new Response(null, {
      status: 303,
      headers: { Location: `${target}${sep}msg=${encodeURIComponent(message)}` },
    });
  };
  const done = (message) => (wantsJson ? json({ ok: true, message }) : backTo(message));
  const fail = (error, status) => (wantsJson ? json({ error }, status) : backTo(error));

  const action = String(body.action ?? '');
  const id = String(body.id ?? '');
  if (!ID_RE.test(id)) return fail('bad id', 400);

  const article = await articleById(id);
  if (!article) return fail('unknown guide', 404);

  const note = cleanLine(body.note, 300) || null;

  if (action === 'accept') {
    await updateArticle(id, 'accepted', note);
    return done(`accepted: ${article.title}`);
  }
  if (action === 'reject') {
    await updateArticle(id, 'rejected', note);
    return done(`rejected: ${article.title}`);
  }
  if (action === 'reopen') {
    await updateArticle(id, 'pending', note);
    return done(`back in the queue: ${article.title}`);
  }
  return fail('unknown action', 400);
}
