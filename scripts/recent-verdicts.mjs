/* Build-time: which app verdicts landed in the last week, newest first.
   Read from git history so it stays true without a second source of truth.
   No git (or nothing new) → empty list, and the digest card hides its chip row. */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src/generated');
const outFile = path.join(outDir, 'recent.json');

const collect = () => {
  const out = execSync(
    'git log --diff-filter=A --since="7 days ago" --name-only --format="" -- data/apps',
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );
  const seen = new Set();
  const apps = [];
  for (const line of out.split('\n')) {
    const file = line.trim();
    if (!file.endsWith('.json') || seen.has(file)) continue;
    seen.add(file);
    try {
      const app = JSON.parse(readFileSync(path.join(root, file), 'utf8'));
      if (app.slug && app.name && app.verdict) {
        apps.push({ slug: app.slug, name: app.name, verdict: app.verdict });
      }
    } catch {}
  }
  return apps;
};

let apps = [];
try {
  apps = collect();
} catch {}

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, JSON.stringify(apps));
console.log(`recent verdicts: ${apps.length}`);
