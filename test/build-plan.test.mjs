/* Phased-prompt parser. The regression that matters: a "Done when" check that
   spans several lines must come back whole. An earlier draft anchored the
   capture with a multiline lookahead and returned only the first line, which
   the tracker then presented as the entire acceptance check. Run: npm test */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DELIVERY_ORDER, buildSteps, parsePhases, promptSection } from '../src/lib/build-plan.js';

const PROMPT = `Build me a thing. Build it in phases.

### Stack (fixed, do not substitute)

- Node 22, no framework.

### Data model (create this before Phase 1)

- things: id, name

### Phase 1 · Identity and storage

Build: the smallest thing that stores a row. Use WAL mode.

Details that decide whether this works:
- one trap
- another trap

Done when: a row round-trips, the file survives a restart, and the
second line of this check is still here after parsing because the
check spans three lines.
Do not build yet: anything visible.

### Phase 2 · The surface

Build: the page.
Done when: it renders.

### Out of scope (and why)

- Multi-user. That is the paid product.

### README must contain

- The one-liner.
`;

test('parses every phase with label, title, build lead, and full done-when', () => {
  const phases = parsePhases(PROMPT);
  assert.equal(phases.length, 2);

  const [p1, p2] = phases;
  assert.equal(p1.label, '1');
  assert.equal(p1.title, 'Identity and storage');
  assert.equal(p1.buildLead, 'the smallest thing that stores a row. Use WAL mode.');
  // The raw build block keeps its bullets for the build page.
  assert.match(p1.build, /- one trap\n- another trap/);
  // Multi-line "Done when" comes back whole, not truncated at the first newline.
  assert.match(p1.doneWhen, /^a row round-trips/);
  assert.match(p1.doneWhen, /spans three lines\.$/);
  assert.equal(p1.notYet, 'anything visible.');

  assert.equal(p2.label, '2');
  assert.equal(p2.title, 'The surface');
  assert.equal(p2.doneWhen, 'it renders.');
  assert.equal(p2.notYet, '');
});

test('build block stops before "Done when" and never swallows the check', () => {
  const [p1] = parsePhases(PROMPT);
  assert.doesNotMatch(p1.build, /Done when/);
  assert.doesNotMatch(p1.doneWhen, /Do not build yet/);
});

test('promptSection pulls named sections case-insensitively, by heading prefix', () => {
  assert.equal(promptSection(PROMPT, 'Stack').body, '- Node 22, no framework.');
  assert.equal(promptSection(PROMPT, 'data model').body, '- things: id, name');
  assert.match(promptSection(PROMPT, 'Out of scope').body, /Multi-user/);
  assert.equal(promptSection(PROMPT, 'Rule zero'), null);
  assert.equal(promptSection('', 'Stack'), null);
});

test('buildSteps: phased prompt yields its own steps, flagged phased', () => {
  const { phased, steps } = buildSteps({ prompt: PROMPT });
  assert.equal(phased, true);
  assert.deepEqual(
    steps.map((s) => [s.n, s.title]),
    [
      ['1', 'Identity and storage'],
      ['2', 'The surface'],
    ]
  );
});

test('buildSteps: a one-shot prompt falls back to the shared delivery order', () => {
  const { phased, steps } = buildSteps({ prompt: 'Build me a thing. Requirements:\n- one\n- two' });
  assert.equal(phased, false);
  assert.equal(steps.length, DELIVERY_ORDER.length);
  assert.equal(steps[0].title, DELIVERY_ORDER[0].title);
  assert.equal(steps[0].n, '1');
  assert.ok(steps.every((s) => s.doneWhen));
});

test('buildSteps: no prompt means nothing to track', () => {
  assert.deepEqual(buildSteps({ prompt: '' }), { phased: false, steps: [] });
  assert.deepEqual(buildSteps(null), { phased: false, steps: [] });
});

test('a heading that is not a phase is ignored, and non-strings are safe', () => {
  assert.deepEqual(parsePhases('### Phaser · not a phase\nBuild: x'), []);
  assert.deepEqual(parsePhases(undefined), []);
  assert.deepEqual(parsePhases(42), []);
});
