/* Static deployment data. These replace database-backed counters and community
   content while the site is deployed as a pure frontend. */
export async function voteCount() {
  return 0;
}

export async function voteCounts() {
  return () => 0;
}

export function mrrDestroyed(apps) {
  return Math.round(apps.reduce((sum, app) => sum + (app.priceMonthly ?? 0), 0));
}

export async function bgPotCents() {
  return 0;
}

export async function liveBuilds() {
  return [];
}

export async function modelDemos() {
  return [];
}
