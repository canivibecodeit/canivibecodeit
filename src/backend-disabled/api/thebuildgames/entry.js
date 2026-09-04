// Edit a Build Games entry. Authorisation is the edit TOKEN alone — the
// unguessable per-entry secret emailed at submission (same token-only
// mechanic as the payment details token). No entry id is ever accepted from
// the request: the token resolves the entry. Edits close with the window.
import { bgEntryByEditToken, bgEntryByRepo, rateLimit, updateBgEntry } from '../../../lib/db.js';
import { buildGamesLive } from '../../../lib/flags.js';
import { clientIp, crossOrigin, json, readBody } from '../../../lib/request.js';
import { parsePublicUrl } from '../../../lib/builds.js';
import {
  BLURB_MAX,
  NAME_MAX,
  cleanBlurb,
  cleanHandle,
  cleanName,
  gamesEndAt,
  parseGithubRepo,
} from '../../../lib/buildgames.js';

export async function POST({ request, clientAddress }) {
  if (!buildGamesLive()) return new Response(null, { status: 404 });
  if (crossOrigin(request)) return json({ error: 'bad origin' }, 403);

  const ip = clientIp(request, clientAddress);
  if (!(await rateLimit(`bgentryedit:${ip}`, 15, 15 * 60 * 1000))) {
    return json({ error: 'slow down' }, 429);
  }

  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  const token = typeof body.token === 'string' ? body.token : '';
  // newToken() values are long; anything short is noise, not a lookup.
  if (token.length < 20 || token.length > 128) return json({ error: 'not found' }, 404);

  const entry = await bgEntryByEditToken(token);
  if (!entry) return json({ error: 'not found' }, 404);
  if (Date.now() >= gamesEndAt()) return json({ error: 'the build window has closed — entries are locked for judging' }, 409);

  const name = cleanName(body.name);
  if (!name) return json({ error: `name: 2 to ${NAME_MAX} characters` }, 400);

  let handle = null;
  if (typeof body.handle === 'string' && body.handle.trim() !== '') {
    handle = cleanHandle(body.handle);
    if (!handle) return json({ error: 'handle: letters, numbers, _ . - only' }, 400);
  }

  const demo = parsePublicUrl(body.demo_url);
  if (!demo) return json({ error: 'demo: a public https:// URL anyone can open' }, 400);

  const repo = parseGithubRepo(parsePublicUrl(body.repo_url));
  if (!repo) return json({ error: 'repo: a public github.com/you/your-repo URL' }, 400);

  // A repo change can't collide with someone else's entry.
  if (repo !== entry.repo_url) {
    const other = await bgEntryByRepo(repo);
    if (other && other.id !== entry.id) return json({ error: 'that repo is already entered' }, 409);
  }

  let blurb = null;
  if (typeof body.blurb === 'string' && body.blurb.trim() !== '') {
    blurb = cleanBlurb(body.blurb);
    if (!blurb) return json({ error: `blurb: 2 to ${BLURB_MAX} characters` }, 400);
  }

  await updateBgEntry(entry.id, { name, handle, demo_url: demo.href, repo_url: repo, blurb });
  return json({ ok: true, message: 'saved' });
}
