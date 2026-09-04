// The Build Games post-entry rec card's link. Kept at this URL for existing
// pages; it now rides the shared How to AI redirect and counts into
// rec_clicks as src=entry_card like every other placement (see lib/rec.js).
import { buildGamesLive } from '../../../lib/flags.js';
import { redirectToRec } from '../../../lib/rec.js';

export async function GET({ request, clientAddress }) {
  if (!buildGamesLive()) return new Response(null, { status: 404 });
  return redirectToRec({ request, clientAddress, src: 'entry_card', email: '' });
}
