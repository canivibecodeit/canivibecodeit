// Impression beacon for client-shown rec surfaces (the co-reg card). POST,
// no body, src in the query; counted per (src, day) like clicks. Rate
// limited per IP so idle inflation costs effort; always answers 204.
import { impressionBeacon } from '../../../lib/rec.js';

export async function POST({ request, clientAddress, url }) {
  return impressionBeacon({ request, clientAddress, src: url.searchParams.get('src') ?? '' });
}
