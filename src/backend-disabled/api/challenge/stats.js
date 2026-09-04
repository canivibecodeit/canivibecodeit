// Live counter feed for the challenge page: the count of listed competing
// entries (the host's demo entry shows in the gallery but never counts).
// Polled gently by the page so the number moves without a reload.
import { liveEntryCount } from '../../../lib/db.js';
import { challengeLive } from '../../../lib/flags.js';
import { currentChallenge } from '../../../lib/challenge.js';
import { json } from '../../../lib/request.js';

export async function GET() {
  if (!challengeLive()) return new Response(null, { status: 404 });
  const challenge = currentChallenge();
  // One COUNT, not SELECT * then filter in JS — this is polled every 45s per
  // open tab (audit L4).
  const res = json({ count: await liveEntryCount(challenge.id) });
  res.headers.set('Cache-Control', 'public, max-age=30');
  return res;
}
