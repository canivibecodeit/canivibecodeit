import { dashboardStats } from '../../lib/analytics.js';
import { json } from '../../lib/request.js';

export async function GET() {
  const stats = await dashboardStats();
  return json(stats ?? { unavailable: true });
}
