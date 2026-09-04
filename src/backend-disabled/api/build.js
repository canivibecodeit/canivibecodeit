// Post a build: name + one-liner + link + screenshots + tool + one
// self-declared "how many goes?" answer. The answer decides what else is
// owed: one go / a few -> the exact prompt; weeks -> what actually got it
// done; never got there -> the link requirement bends. Every build owes one
// line on where it broke. Builds land as status 'pending' and go live when
// Faizan taps approve on /admin/builds.
import { buildsLive } from '../../lib/flags.js';
import { getApp } from '../../lib/apps.js';
import {
  claimBuildMedia,
  githubAccountOf,
  insertBuild,
  mediaOwnedBy,
  rateLimit,
  setUserHandle,
  userBuildSlugs,
  userHandle,
} from '../../lib/db.js';
import { alertAdmin, esc } from '../../lib/mail.js';
import { clientIp, crossOrigin, json, readBody } from '../../lib/request.js';
import {
  GOES,
  HANDLE_RE,
  RESERVED_HANDLES,
  linkRequired,
  newId,
  parsePublicUrl,
  promptRequired,
  slugifyBuildName,
  storyRequired,
} from '../../lib/builds.js';
import { r2PublicUrl } from '../../lib/r2.js';
import { aiReviewOn, reviewBuild } from '../../lib/build-review.js';

const clean = (v, max) =>
  typeof v === 'string'
    ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';

// Prompts and stories keep their line breaks; other control chars stripped.
const cleanBlock = (v, max) =>
  typeof v === 'string'
    ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, max)
    : '';

export async function POST({ request, locals, clientAddress }) {
  if (!buildsLive()) return new Response(null, { status: 404 });
  if (!locals.user) return json({ error: 'sign in first' }, 401);
  if (crossOrigin(request)) return json({ error: 'bad origin' }, 403);

  const ip = clientIp(request, clientAddress);
  if (!(await rateLimit(`build:${locals.user.id}`, 5, 60 * 60 * 1000))) {
    return json({ error: 'five builds an hour is plenty. back soon.' }, 429);
  }
  if (!(await rateLimit(`build-ip:${ip}`, 10, 60 * 60 * 1000))) {
    return json({ error: 'slow down' }, 429);
  }
  if (!(await rateLimit('build:all', 1000, 24 * 60 * 60 * 1000))) {
    if (await rateLimit('build:cap-alert', 1, 24 * 60 * 60 * 1000)) {
      alertAdmin(
        '[cvci] build post cap tripped',
        '<p>The global build cap (1000/day) tripped. Model day or a flood, check the builds table. Caps live in src/pages/api/build.js.</p>'
      ).catch((err) => console.error(`build cap alert failed: ${err.message}`));
    }
    return json({ error: 'the queue is full right now, try again in a bit' }, 429);
  }

  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  // Honeypot: a real visitor never fills this hidden field.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return json({ ok: true, id: newId('b'), url: '/builds' }, 201);
  }

  const name = clean(body.name, 80);
  if (name.length < 2) return json({ error: 'give the build a name' }, 400);
  const oneLiner = clean(body.one_liner, 140);
  if (oneLiner.length < 5) return json({ error: 'one line on what it is' }, 400);

  if (typeof body.goes !== 'string' || !Object.hasOwn(GOES, body.goes)) {
    return json({ error: 'how many goes did it take?' }, 400);
  }
  const goes = body.goes;

  const prompt = cleanBlock(body.prompt, 20000) || null;
  if (promptRequired(goes) && (prompt?.length ?? 0) < 10) {
    return json({ error: 'paste the prompt, exactly as sent · it is the whole point' }, 400);
  }
  const story = cleanBlock(body.story, 5000) || null;
  if (storyRequired(goes) && (story?.length ?? 0) < 10) {
    return json({ error: 'say what actually got it done' }, 400);
  }
  const whereBroke = clean(body.where_broke, 300);
  if (whereBroke.length < 3) return json({ error: 'one line on what broke or still bugs you · "nothing yet" counts' }, 400);

  const tool = clean(body.tool, 60);
  if (!tool) return json({ error: 'name the tool you built it with' }, 400);
  const model = clean(body.model, 60) || null;
  const affiliation = clean(body.affiliation, 200) || null;

  const demoUrl = typeof body.demo_url === 'string' && body.demo_url.trim() ? parsePublicUrl(body.demo_url) : null;
  if (typeof body.demo_url === 'string' && body.demo_url.trim() && !demoUrl) {
    return json({ error: 'the demo URL needs to be a public https address' }, 400);
  }
  const repoUrl = typeof body.repo_url === 'string' && body.repo_url.trim() ? parsePublicUrl(body.repo_url) : null;
  if (typeof body.repo_url === 'string' && body.repo_url.trim() && !repoUrl) {
    return json({ error: 'the repo URL needs to be a public https address' }, 400);
  }
  const chatUrl = typeof body.chat_url === 'string' && body.chat_url.trim() ? parsePublicUrl(body.chat_url) : null;
  if (typeof body.chat_url === 'string' && body.chat_url.trim() && !chatUrl) {
    return json({ error: 'the chat link needs to be a public https address' }, 400);
  }
  if (linkRequired(goes) && !demoUrl && !repoUrl) {
    return json({ error: 'a build needs a live demo or a public repo, ideally both' }, 400);
  }

  // Optional: attach to a listed app (the build then renders on that app's
  // verdict page too). Standalone is the default.
  let appSlug = null;
  if (typeof body.slug === 'string' && body.slug.trim()) {
    const app = getApp(body.slug);
    if (!app) return json({ error: 'that app is not on the list' }, 400);
    appSlug = app.slug;
  }

  // Screenshots are required: ids from /api/build/media, owned by this user,
  // not yet claimed by another build.
  let mediaIds = Array.isArray(body.media)
    ? body.media.filter((m) => typeof m === 'string' && /^bm_[a-z2-9]{10}$/.test(m)).slice(0, 3)
    : [];
  const owned = await mediaOwnedBy(mediaIds, locals.user.id);
  mediaIds = owned.map((m) => m.id);
  const mediaUrls = owned.map((m) => r2PublicUrl(m.key));
  if (mediaUrls.length < 1) {
    return json({ error: 'add at least one screenshot of the thing you built' }, 400);
  }

  // Maker handle: claimed on the first post (validations above all passed,
  // so a successful claim always rides a successful post). It names the
  // maker everywhere and owns the /builds/<handle>/ URL space.
  let handle = await userHandle(locals.user.id);
  if (!handle) {
    const wanted = typeof body.handle === 'string' ? body.handle.trim() : '';
    if (!HANDLE_RE.test(wanted)) {
      return json({ error: 'pick a handle: 3-20 letters, numbers, dashes' }, 400);
    }
    if (RESERVED_HANDLES.has(wanted.toLowerCase()) || /^b_/i.test(wanted)) {
      return json({ error: 'that handle is reserved · pick another' }, 400);
    }
    if (!(await setUserHandle(locals.user.id, wanted))) {
      return json({ error: 'that handle is taken · pick another' }, 409);
    }
    handle = wanted;
  }

  // URL slug from the build name, unique per maker (-2, -3 on repeats).
  const slugBase = slugifyBuildName(name);
  const taken = new Set(await userBuildSlugs(locals.user.id));
  let slug = slugBase;
  for (let n = 2; taken.has(slug); n += 1) slug = `${slugBase}-${n}`;

  const byOwner = repoUrl ? await repoOwnerMatch(repoUrl, locals.user.id) : 0;

  const id = newId('b');
  await insertBuild({
    id,
    user_id: locals.user.id,
    app_slug: appSlug,
    name,
    slug,
    one_liner: oneLiner,
    goes,
    prompt,
    story,
    where_broke: whereBroke,
    tool,
    model,
    model_norm: model ? model.toLowerCase() : null,
    demo_url: demoUrl?.href ?? null,
    repo_url: repoUrl?.href ?? null,
    chat_url: chatUrl?.href ?? null,
    media: JSON.stringify(mediaUrls),
    affiliation,
    by_owner: byOwner,
    status: 'pending',
    created_at: Date.now(),
  });

  await claimBuildMedia(mediaIds, id, locals.user.id);

  if (aiReviewOn()) {
    // Overnight mode: the AI reviewer owns the outcome email (approved-and-
    // live or held-for-you), so Faizan still gets exactly one mail per post.
    reviewBuild(id).catch((err) => console.error(`build review ${id}: ${err.message}`));
  } else {
    // Approve-first means the queue email IS the doorbell: without it a
    // build sits pending until Faizan happens to look. One mail per post.
    // Subject is a mail header, not HTML: name is already control-char
    // stripped by clean(), so no esc() (it would show literal entities).
    alertAdmin(
      `[cvci] build in the queue: ${name}`,
      `<p>New build waiting for approval:</p>
       <p><b>${esc(name)}</b> · ${esc(oneLiner)}</p>
       <p>${esc(GOES[goes])} · ${esc(tool)}${model ? ` · ${esc(model)}` : ''}${appSlug ? ` · on ${esc(appSlug)}` : ''}${affiliation ? ` · affiliation: ${esc(affiliation)}` : ''}</p>
       <p><a href="https://vibecodeit.com/admin/builds">open the queue and paste your token</a></p>`
    ).catch((err) => console.error(`build queue alert failed: ${err.message}`));
  }

  return json({ ok: true, id, url: `/builds/${handle}/${slug}` }, 201);
}

/* "posted by the repo owner": true when the repo lives on github.com and
   its owner is either the poster's linked GitHub login, or an org that
   login is a PUBLIC member of (private membership is invisible to us by
   GitHub's design, so it can't count). Resolved id -> login via the public
   API. Silent on any failure — no match is never an accusation, so it is
   never an error either. */
const GH_HEADERS = () => ({
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'vibecodeit-builds',
  ...(process.env.GITHUB_BOT_TOKEN
    ? { Authorization: `Bearer ${process.env.GITHUB_BOT_TOKEN}` }
    : {}),
});

async function repoOwnerMatch(repoUrl, userId) {
  try {
    if (repoUrl.hostname.toLowerCase() !== 'github.com') return 0;
    const owner = repoUrl.pathname.split('/').filter(Boolean)[0];
    if (!owner || !/^[A-Za-z0-9-]+$/.test(owner)) return 0;
    const accountId = await githubAccountOf(userId);
    if (!accountId || !/^\d+$/.test(String(accountId))) return 0;
    const res = await fetch(`https://api.github.com/user/${accountId}`, {
      headers: GH_HEADERS(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return 0;
    const login = (await res.json()).login;
    if (typeof login !== 'string' || !login) return 0;
    if (login.toLowerCase() === owner.toLowerCase()) return 1;
    // Org-owned repo: public membership in the owning org counts too.
    const org = await fetch(
      `https://api.github.com/orgs/${owner}/public_members/${login}`,
      { headers: GH_HEADERS(), signal: AbortSignal.timeout(8000) }
    );
    return org.status === 204 ? 1 : 0;
  } catch {
    return 0;
  }
}
