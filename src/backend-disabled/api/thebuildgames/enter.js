// Submit a Build Games entry: builder name + public demo URL + GitHub repo.
// Free, no account, no uploads. The entry is NOT publicly listed yet (judging
// renders entries later) — so links are validated for shape, not screened.
// Authorisation for later edits is a minted edit_token (same token-only
// mechanic as the sponsor details token), emailed to the entrant.
// Same open-submission protections as the bid form: honeypot, per-IP +
// global rate limits, origin check, server-side validation, NUL stripping.
import { bgEntryByEmail, bgEntryByRepo, insertBgEntry, addToWaitlist, rateLimit } from '../../../lib/db.js';
import { buildGamesLive } from '../../../lib/flags.js';
import { mirrorToResend } from '../../../lib/mail.js';
import { sendEntryEditLink } from '../../../lib/buildgames-mail.js';
import { clientIp, crossOrigin, json, readBody, unreachableEmail, validEmail } from '../../../lib/request.js';
import { parsePublicUrl } from '../../../lib/builds.js';
import { newToken, siteUrl } from '../../../lib/sponsors.js';
import {
  BLURB_MAX,
  NAME_MAX,
  cleanBlurb,
  cleanHandle,
  cleanName,
  entriesOpen,
  gamesStarted,
  newEntryId,
  parseGithubRepo,
} from '../../../lib/buildgames.js';

export async function POST({ request, clientAddress }) {
  if (!buildGamesLive()) return new Response(null, { status: 404 });
  if (crossOrigin(request)) return json({ error: 'bad origin' }, 403);
  if (!entriesOpen()) {
    return json({ error: gamesStarted() ? 'the build window has closed' : 'entries open when the games start' }, 409);
  }

  const ip = clientIp(request, clientAddress);
  if (!(await rateLimit(`bgentry:${ip}`, 5, 60 * 60 * 1000))) {
    return json({ error: 'a few tries an hour is plenty · back soon' }, 429);
  }
  if (!(await rateLimit('bgentry:all', 1000, 24 * 60 * 60 * 1000))) {
    return json({ error: 'entries are flooded right now, try again shortly' }, 429);
  }

  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ error: 'bad request' }, 400);
  }
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return json({ ok: true }, 202); // honeypot
  }

  // Required acceptance (operator rule): no ticked box, no entry — the
  // client checkbox is convenience, THIS is the gate.
  if (!['1', 'true', 'on', 'yes'].includes(String(body.accept_terms ?? '').toLowerCase())) {
    return json({ error: 'you have to accept the Build Games terms to enter — tick the box above the button' }, 400);
  }

  const name = cleanName(body.name);
  if (!name) return json({ error: `name: 2 to ${NAME_MAX} characters` }, 400);

  // Handle is optional — but a provided one that doesn't validate is a clear
  // 400, never a silent drop.
  let handle = null;
  if (typeof body.handle === 'string' && body.handle.trim() !== '') {
    handle = cleanHandle(body.handle);
    if (!handle) return json({ error: 'handle: letters, numbers, _ . - only' }, 400);
  }

  const demo = parsePublicUrl(body.demo_url);
  if (!demo) return json({ error: 'demo: a public https:// URL anyone can open' }, 400);

  const repo = parseGithubRepo(parsePublicUrl(body.repo_url));
  if (!repo) return json({ error: 'repo: a public github.com/you/your-repo URL' }, 400);

  let blurb = null;
  if (typeof body.blurb === 'string' && body.blurb.trim() !== '') {
    blurb = cleanBlurb(body.blurb);
    if (!blurb) return json({ error: `blurb: 2 to ${BLURB_MAX} characters` }, 400);
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!validEmail(email) || unreachableEmail(email)) {
    return json({ error: 'that email does not look sendable — the edit link goes there' }, 400);
  }

  // One entry per person or team: the email and the repo each key one entry.
  // The edit link (already in their inbox) is the way to change either.
  if (await bgEntryByEmail(email)) {
    return json({ error: 'that email already has an entry — use the edit link we emailed you' }, 409);
  }
  if (await bgEntryByRepo(repo)) {
    return json({ error: 'that repo is already entered' }, 409);
  }

  const optin = ['1', 'true', 'on', 'yes'].includes(String(body.newsletter_optin ?? '').toLowerCase());
  const editToken = newToken();
  const now = Date.now();
  await insertBgEntry({
    id: newEntryId(),
    name,
    handle,
    demo_url: demo.href,
    repo_url: repo,
    blurb,
    contact_email: email,
    edit_token: editToken,
    newsletter_optin: optin,
    status: 'submitted',
    created_at: now,
    updated_at: now,
  });

  // Opt-in list capture: same gates as every waitlist path (new rows only
  // mirror, reserved domains never enter the audience).
  if (optin && (await addToWaitlist(email, 'buildgames'))) mirrorToResend(email);

  // The edit link, emailed. Fire-and-forget: the entry stands even if mail is
  // down — the success screen carries the same link.
  sendEntryEditLink({ to: email, editUrl: `${siteUrl('/thebuildgames/entry')}?token=${editToken}` });

  return json({ ok: true, token: editToken }, 201);
}
