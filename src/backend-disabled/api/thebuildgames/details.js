// Save the tagline for a Build Games placement, post-checkout. Authorisation
// is the details TOKEN alone — an unguessable per-payment secret revealed only
// in the payer's success redirect. No sponsor_id/payment_id is ever accepted
// from the request: the token resolves the payment, the payment resolves the
// sponsor, and the edit is allowed only when that payment CLEARED and WON the
// sponsor's identity claim (earliest cleared screened payment). Same
// sanitisation as every other tagline path: cleanTagline + TAGLINE_MAX.
// Writes go live immediately — no approval step, per Faizan.
import { rateLimit, updateBgSponsor } from '../../../lib/db.js';
import { bgEditableByToken } from '../../../lib/buildgames-details.js';
import { buildGamesLive } from '../../../lib/flags.js';
import { alertAdmin, esc } from '../../../lib/mail.js';
import { clientIp, crossOrigin, json, readBody } from '../../../lib/request.js';
import { NAME_MAX, TAGLINE_MAX, cleanName, cleanTagline } from '../../../lib/buildgames.js';

export async function POST({ request, clientAddress }) {
  if (!buildGamesLive()) return new Response(null, { status: 404 });
  if (crossOrigin(request)) return json({ error: 'bad origin' }, 403);

  const ip = clientIp(request, clientAddress);
  if (!(await rateLimit(`bgdetails:${ip}`, 15, 15 * 60 * 1000))) {
    return json({ error: 'slow down' }, 429);
  }

  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  // Token -> payment -> sponsor, with the winner check (buildgames-details.js).
  const auth = await bgEditableByToken(body.token);
  if (auth.error) return json({ error: auth.error }, auth.status);
  const { sponsor } = auth;

  const tagline = cleanTagline(body.tagline);
  if (!tagline) {
    return json({ error: `tagline: 2 to ${TAGLINE_MAX} characters, no links` }, 400);
  }

  // Display name: optional. Provided + valid -> set; provided empty -> clear
  // (the row falls back to the host); invalid -> explicit 400.
  let nameUpdate;
  if (typeof body.name === 'string') {
    if (body.name.trim() === '') nameUpdate = null;
    else {
      nameUpdate = cleanName(body.name);
      if (!nameUpdate) return json({ error: `name: 2 to ${NAME_MAX} characters` }, 400);
    }
  }

  const before = { name: sponsor.name ?? null, tagline: sponsor.tagline ?? null };
  await updateBgSponsor(sponsor.id, { tagline, ...(nameUpdate !== undefined ? { name: nameUpdate } : {}) });

  // Post-clear edits bypass the first-clear alert, so they get their own —
  // a defacement AFTER clearing must be as visible as one at clearing.
  // Fire-and-forget; the save never waits on mail.
  alertAdmin(
    '[cvci] build games: placement details edited post-clear',
    `<p><b>${esc(sponsor.link)}</b></p>
     <p>name: ${esc(String(before.name))} → ${esc(String(nameUpdate === undefined ? before.name : nameUpdate))}<br>
        tagline: ${esc(String(before.tagline))} → ${esc(tagline)}</p>
     <p><a href="https://vibecodeit.com/admin/thebuildgames">the queue</a></p>`
  ).catch((err) => console.error(`bg details edit alert failed: ${err.message}`));

  return json({ ok: true, message: 'saved · live on the board' });
}
