import { globeStats } from '../../lib/analytics.js';
import { json } from '../../lib/request.js';

// Polled by the homepage globe. globeStats() holds a 30s cache, so gentle
// polling never hammers PostHog. `age` is how old the snapshot is in seconds,
// computed here because the client's clock can't be trusted against `at`.
export async function GET() {
  const data = await globeStats();
  if (!data) return json({ unavailable: true });
  return json({ ...data, age: Math.max(0, Math.round((Date.now() - data.at) / 1000)) });
}
