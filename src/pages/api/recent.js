/* Recent verdicts (last 7 days) for agents and feeds.
   GET /api/recent — reads the build-time generated list
   (scripts/recent-verdicts.mjs, git-log based: data/apps files added
   in the last 7 days). Empty when the generator has not run (fresh clone). */
import { readFileSync } from 'node:fs';
import { json } from '../../lib/request.js';

export function GET() {
  let apps = [];
  try {
    apps = JSON.parse(readFileSync('src/generated/recent.json', 'utf8'));
  } catch {
    // not built yet — empty list is a valid response
  }
  return json({
    count: apps.length,
    window: 'last 7 days (git history of data/apps)',
    note: 'empty when the build-time generator has not run',
    apps,
  });
}
