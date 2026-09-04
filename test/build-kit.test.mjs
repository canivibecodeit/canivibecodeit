/* Build kits: the validator's rejection paths, the mode filter, and the two
   pack generators. The fixture is deliberately small and complete. Run: npm test */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { genericPack, kitCounts, kitPack, packFiles, phasesFor, validateKit } from '../src/lib/build-kit.js';

const KIT = {
  slug: 'demo',
  version: 1,
  summary: 'A small thing that works.',
  time: 'one sitting',
  stack: [{ part: 'Runtime', choice: 'Node 22', why: 'one binary' }],
  prerequisites: [
    { id: 'node', kind: 'tool', name: 'Node.js 22', why: 'runs it', get: 'nodejs.org', verify: 'node --version', cost: 'free' },
    { id: 'stripe', kind: 'key', name: 'Stripe test key', why: 'checkout', get: 'dashboard', cost: 'free in test mode', optional: true, url: 'https://dashboard.stripe.com/test/apikeys' },
  ],
  env: [
    { name: 'PORT', example: '3000', required: true, secret: false, where: 'any free port' },
    { name: 'STRIPE_SECRET_KEY', example: 'sk_test_...', required: false, secret: true, where: 'Stripe dashboard' },
  ],
  phases: [
    {
      id: 'p1', title: 'Scaffold', goal: 'Have it run.',
      steps: [
        { id: 'p1s1', do: 'Create the project', commands: ['mkdir demo && cd demo', 'npm init -y'], files: ['package.json'] },
        { id: 'p1s2', do: 'Add the server file', detail: 'One file, no framework.' },
      ],
      check: ['npm start prints a URL'],
      traps: ['Do not add Express.'],
    },
    {
      id: 'p2', title: 'Observability', goal: 'Know when it breaks.', productOnly: true,
      steps: [{ id: 'p2s1', do: 'Add /healthz' }, { id: 'p2s2', do: 'Add structured logs' }],
      check: ['/healthz returns 200'],
    },
  ],
  product: {
    outcome: 'A product you can run for others.',
    architecture: [{ module: 'Server', owns: 'HTTP', swap: 'Any Node http server' }],
    operations: { backup: 'Copy the db nightly.', restore: 'Copy it back.', monitoring: 'Ping /healthz.', incident: 'Rotate keys first.' },
    releaseGate: ['Clean install passes'],
  },
  notIncluded: ['Teams'],
  after: ['A mobile app'],
};

const APP = { name: 'Demo / Alias', slug: 'demo', prompt: 'Build me a demo.', requirements: ['a laptop'], whatYouLose: ['sync'], verdictSummary: 'Easy.' };

test('a complete kit validates clean', () => {
  assert.deepEqual(validateKit(KIT), []);
});

test('the validator names the exact field for each rejection', () => {
  const clone = () => JSON.parse(JSON.stringify(KIT));
  let k = clone(); k.time = 'forever';
  assert.match(validateKit(k).join('\n'), /time must be one of/);
  k = clone(); k.prerequisites[1].id = 'node';
  assert.match(validateKit(k).join('\n'), /duplicate id "pre:node"/);
  k = clone(); k.phases[0].steps[1].id = 'p1s1';
  assert.match(validateKit(k).join('\n'), /duplicate id "p1s1"/);
  k = clone(); k.env[0].name = 'port';
  assert.match(validateKit(k).join('\n'), /UPPER_SNAKE_CASE/);
  k = clone(); k.phases[0].check = [];
  assert.match(validateKit(k).join('\n'), /check must be a non-empty array/);
  k = clone(); k.phases.forEach((p) => (p.productOnly = true));
  assert.match(validateKit(k).join('\n'), /at least one phase must be available in indie mode/);
  k = clone(); k.summary = 'Fast — really.';
  assert.match(validateKit(k).join('\n'), /em dash/);
  k = clone(); delete k.product.operations.restore;
  assert.match(validateKit(k).join('\n'), /product\.operations\.restore is required/);
  k = clone(); k.prerequisites[0].url = 'nodejs.org';
  assert.match(validateKit(k).join('\n'), /url must be an http\(s\) URL/);
});

test('indie mode hides production-only phases, product mode shows all', () => {
  assert.deepEqual(phasesFor(KIT, 'indie').map((p) => p.id), ['p1']);
  assert.deepEqual(phasesFor(KIT, 'product').map((p) => p.id), ['p1', 'p2']);
  assert.deepEqual(kitCounts(KIT, 'indie'), { prerequisites: 2, phases: 1, steps: 2 });
  assert.deepEqual(kitCounts(KIT, 'product'), { prerequisites: 2, phases: 2, steps: 4 });
});

test('indie pack: five files, prerequisites and commands land in the right ones', () => {
  const files = kitPack(APP, KIT, 'indie');
  assert.deepEqual(files.map((f) => f.path), ['README.md', 'BRIEF.md', 'AGENTS.md', 'BUILD_PLAN.md', '.env.example']);
  assert.match(files[1].content, /Build me a demo\./);
  const readme = files[0].content;
  assert.match(readme, /# Demo · indie build/);
  assert.match(readme, /\*\*Stripe test key\*\* \(optional\) · free in test mode/);
  assert.match(readme, /Verify: node --version/);
  assert.match(readme, /npm init -y/); // quick start lifts the first commands
  const plan = files[3].content;
  assert.match(plan, /## Phase 1 · Scaffold/);
  assert.doesNotMatch(plan, /Observability/); // production-only phase excluded
  assert.match(plan, /- \[ \] npm start prints a URL/);
  assert.match(plan, /### Watch out\n\n- Do not add Express\./);
  assert.match(plan, /## After v1, if you want it\n\n- A mobile app/);
  const env = files[4].content;
  assert.match(env, /# Required\. any free port\nPORT=3000/);
  assert.match(env, /# Optional · secret\. Stripe dashboard\nSTRIPE_SECRET_KEY=sk_test_\.\.\./);
});

test('product pack: seven files including the production-only milestone and operations', () => {
  const files = kitPack(APP, KIT, 'product');
  assert.deepEqual(files.map((f) => f.path), ['PRODUCT.md', 'BRIEF.md', 'ARCHITECTURE.md', 'AGENTS.md', 'MILESTONES.md', 'OPERATIONS.md', '.env.example']);
  assert.match(files[2].content, /\| Server \| HTTP \| Any Node http server \|/);
  assert.match(files[4].content, /## M2 · Observability \(production only\)/);
  assert.match(files[5].content, /## Restore\n\nCopy it back\./);
  assert.match(files[5].content, /- \[ \] Clean install passes/);
});

test('packFiles falls back to the generic templates without a kit', () => {
  const indie = packFiles(APP, null, 'indie');
  assert.deepEqual(indie.map((f) => f.path), ['README.md', 'AGENTS.md', 'BUILD_PLAN.md', '.env.example']);
  assert.match(indie[2].content, /## Original build brief\n\nBuild me a demo\./);
  const product = packFiles(APP, null, 'product');
  assert.equal(product.length, 5);
  assert.deepEqual(genericPack(APP, 'product').map((f) => f.path), product.map((f) => f.path));
});

test('an empty env still produces a useful .env.example', () => {
  const k = { ...KIT, env: [] };
  const env = kitPack(APP, k, 'indie').find((f) => f.path === '.env.example').content;
  assert.match(env, /needs no environment variables/);
});
