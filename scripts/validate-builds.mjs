/* Every build kit in data/builds is checked here, the way validate-apps.mjs
   checks data/apps. Run with `npm run validate` (this runs after the app check).
   The per-kit rules live in src/lib/build-kit.js; this adds the cross-file
   checks a single kit cannot make: the slug matches the filename and names an
   app that exists. */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateKit } from '../src/lib/build-kit.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'data/builds');
const appsDir = path.join(root, 'data/apps');

if (!existsSync(dir)) {
  console.log('✓ no build kits yet (data/builds is absent)');
  process.exit(0);
}

const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const problems = [];

for (const file of files) {
  const bad = (msg) => problems.push(`${file}: ${msg}`);
  let kit;
  try {
    kit = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
  } catch (err) {
    bad(`invalid JSON · ${err.message}`);
    continue;
  }
  const slug = path.basename(file, '.json');
  if (kit.slug !== slug) bad(`slug "${kit.slug}" does not match filename`);
  if (!existsSync(path.join(appsDir, `${slug}.json`))) bad(`no app entry data/apps/${slug}.json for this kit`);
  validateKit(kit).forEach(bad);
}

if (problems.length) {
  console.error(`✗ ${problems.length} problem${problems.length === 1 ? '' : 's'} in ${files.length} build kits\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`✓ ${files.length} build kit${files.length === 1 ? '' : 's'} pass`);
