// One-tap build moderation: approve (pending -> live, instantly public),
// reject (pending -> rejected), unpublish (live -> rejected), and the
// featured toggle for the verdict-page strip. Token-gated like the sponsor
// admin; form posts bounce back to /admin/builds with a message, JSON
// callers get JSON. Works with the flag off — the queue must stay reachable
// even if the public surface is dark.
import { buildById, updateBuild } from '../../../lib/db.js';
import { json, readBody } from '../../../lib/request.js';
import { isAdmin } from '../../../lib/sponsors.js';
import { BUILD_ID_RE } from '../../../lib/builds.js';
import { generateBuildOg } from '../../../lib/build-og.js';

export async function POST({ request }) {
  const wantsJson = (request.headers.get('content-type') || '').includes('application/json');

  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  if (!isAdmin(body.token)) return json({ error: 'not found' }, 404);

  // Same-origin paths only: "//evil.com" and "/\evil.com" are both absolute
  // to a browser, so a leading slash on its own proves nothing.
  const backTo = (message) => {
    const back = String(body.return_to || '');
    const target = /^\/(?![/\\])/.test(back) ? back : '/builds';
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
  if (!BUILD_ID_RE.test(id)) return fail('bad id', 400);
  const build = await buildById(id);
  if (!build) return fail('unknown build', 404);

  if (action === 'approve') {
    if (build.status !== 'pending') return fail('not in the queue', 409);
    await updateBuild(id, { status: 'live' });
    generateBuildOg(id).catch((err) => console.error(`build og ${id}: ${err.message}`));
    return done(`live: ${build.name}`);
  }

  if (action === 'reject') {
    if (build.status !== 'pending') return fail('not in the queue', 409);
    await updateBuild(id, { status: 'rejected' });
    return done(`rejected: ${build.name}`);
  }

  if (action === 'unpublish') {
    if (build.status !== 'live') return fail('not live', 409);
    await updateBuild(id, { status: 'rejected', featured: 0 });
    return done(`unpublished: ${build.name}`);
  }

  if (action === 'feature') {
    if (build.status !== 'live') return fail('not live', 409);
    const note = String(body.note ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 120);
    await updateBuild(id, { featured: 1, featured_note: note || null });
    return done(`featured: ${build.name}`);
  }

  if (action === 'unfeature') {
    await updateBuild(id, { featured: 0 });
    return done(`unfeatured: ${build.name}`);
  }

  return fail('unknown action', 400);
}
