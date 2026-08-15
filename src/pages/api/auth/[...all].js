// Better Auth catch-all: OAuth start/callback, session, sign-out, etc.
// All logic lives in src/lib/auth.js; this file just hands over the request.
// A failed auth init answers 503 here and nowhere else: the rest of the site
// must keep rendering.
import { getAuth } from '../../../lib/auth.js';
import { json } from '../../../lib/request.js';

export async function ALL({ request }) {
  let auth;
  try {
    auth = await getAuth();
  } catch (err) {
    console.error(`auth unavailable: ${err?.message || err}`);
    return json({ error: 'sign-in is briefly unavailable, try again in a minute' }, 503);
  }
  return auth.handler(request);
}
