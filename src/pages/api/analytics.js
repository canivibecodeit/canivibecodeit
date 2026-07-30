import { siteStats } from '../../lib/analytics.js';
import { json } from '../../lib/request.js';

export async function GET() {
  const stats = await siteStats();
  return json(stats ?? { unavailable: true });
}
