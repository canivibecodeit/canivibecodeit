// The one counting redirect for every How to AI placement (see lib/rec.js).
import { redirectToRec } from '../../../lib/rec.js';

export async function GET({ request, clientAddress, url }) {
  return redirectToRec({
    request,
    clientAddress,
    src: url.searchParams.get('src') ?? '',
    email: url.searchParams.get('email') ?? '',
  });
}
