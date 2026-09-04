/* Every app entry is a PR, so the schema check has to be the reviewer that never
   gets tired. Run with `npm run validate`. The per-entry rules live in
   src/lib/validate-app.js (shared with the submission pipeline); this script
   adds the file-level check the API caller can't have: slug matches filename. */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateApp } from '../src/lib/validate-app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'data/apps');

const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const problems = [];

for (const file of files) {
  const bad = (msg) => problems.push(`${file}: ${msg}`);
  let app;
  try {
    app = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
  } catch (err) {
    bad(`invalid JSON — ${err.message}`);
    continue;
  }

  if (app.slug !== path.basename(file, '.json')) {
    bad(`slug "${app.slug}" does not match the filename`);
  }
  validateApp(app).forEach(bad);
}

if (problems.length) {
  console.error(`✗ ${problems.length} problem(s) in ${files.length} app files:\n`);
  problems.forEach((p) => console.error(`  ${p}`));
  process.exit(1);
}

console.log(`✓ ${files.length} app files pass`);
