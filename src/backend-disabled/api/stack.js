// My stack: save/unsave apps. Session comes from middleware (locals.user);
// anonymous requests get a 401 and the client opens the signup surface.
import { rateLimit, stackAdd, stackRemove, stackSlugs } from '../../lib/db.js';
import { getApp } from '../../lib/apps.js';
import { crossOrigin, json, readBody } from '../../lib/request.js';

async function guard(request, locals) {
  if (!locals.user) return json({ error: 'sign in first' }, 401);
  if (crossOrigin(request)) return json({ error: 'bad origin' }, 403);
  if (!(await rateLimit(`stack:${locals.user.id}`, 60, 60 * 1000))) {
    return json({ error: 'slow down' }, 429);
  }
  return null;
}

async function slugFromBody(request) {
  try {
    const body = await readBody(request);
    return typeof body.slug === 'string' ? body.slug : null;
  } catch {
    return null;
  }
}

export async function GET({ request, locals }) {
  const denied = await guard(request, locals);
  if (denied) return denied;
  return json({ slugs: await stackSlugs(locals.user.id) });
}

export async function POST({ request, locals }) {
  const denied = await guard(request, locals);
  if (denied) return denied;
  const slug = await slugFromBody(request);
  if (!slug || !getApp(slug)) return json({ error: 'unknown app' }, 404);
  await stackAdd(locals.user.id, slug);
  return json({ ok: true, saved: true });
}

export async function DELETE({ request, locals }) {
  const denied = await guard(request, locals);
  if (denied) return denied;
  const slug = await slugFromBody(request);
  if (!slug || !getApp(slug)) return json({ error: 'unknown app' }, 404);
  await stackRemove(locals.user.id, slug);
  return json({ ok: true, saved: false });
}
