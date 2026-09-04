// Icon upload for a Build Games placement, post-checkout. Authorisation is
// the details token via bgEditableByToken (cleared payment that won the
// identity claim). Writes go live on the board immediately, like the
// tagline; a post-clear icon swap alerts Faizan the same way a text edit does.
import { updateBgSponsor } from '../../../lib/db.js';
import { buildGamesLive } from '../../../lib/flags.js';
import { bgEditableByToken } from '../../../lib/buildgames-details.js';
import { selfHostImage } from '../../../lib/challenge-image.js';
import { iconEndpoint } from '../../../lib/icon-upload.js';
import { alertAdmin, esc } from '../../../lib/mail.js';

const handler = iconEndpoint({
  surface: 'buildgames',
  resolve: async ({ token }) => {
    const r = await bgEditableByToken(token);
    if (r.error) return r;
    return { subject: r, keyStem: `buildgames/${r.sponsor.id}` };
  },
  apply: async ({ sponsor }, url) => {
    await updateBgSponsor(sponsor.id, { icon_url: url });
    alertAdmin(
      '[cvci] build games: placement icon replaced post-clear',
      `<p><b>${esc(sponsor.link)}</b></p><p><img src="${esc(url)}" width="56" height="56" alt="" /></p>
       <p><a href="https://vibecodeit.com/admin/thebuildgames">the queue</a></p>`
    ).catch((err) => console.error(`bg icon alert failed: ${err.message}`));
    return { icon_url: url };
  },
  // The default is what clearing computed: the favicon proposed with the
  // winning payment, re-hosted (versioned key, so the edge cache cannot
  // serve the uploaded icon over it). Without R2, or without a favicon,
  // icon_url goes null and the board falls back to faviconUrl(link).
  revert: async ({ sponsor, payment }) => {
    const src = payment.proposed_icon_src;
    const url = src
      ? await selfHostImage(src, `buildgames/${sponsor.id}-${Date.now()}.webp`, { w: 96, h: 96, fit: 'cover' })
      : null;
    await updateBgSponsor(sponsor.id, { icon_url: url });
    return { icon_url: url };
  },
});

export async function POST(ctx) {
  if (!buildGamesLive()) return new Response(null, { status: 404 });
  return handler(ctx);
}
