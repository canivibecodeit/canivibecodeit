/* The rails: where The Attention Playbook's house slot sits in the sequence,
   and the sizing that keeps every card in both rails the same height.
   Pure functions only. Run: npm test */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RAIL, TAP_SLOT, cardHeightFor, composeRails, railCardHeight, railRows, railSizingCss } from '../src/lib/sponsors.js';

const slot = (id, state, house = null) => ({ id, side: id.startsWith('L') ? 'left' : 'right', state, house });
const board = (slots) => ({ slots, left: slots.filter((s) => s.side === 'left'), right: slots.filter((s) => s.side === 'right') });
const ids = (rail) => rail.map((s) => s.id);
const house = { slot: 'L3', name: 'House', url: 'https://example.com' };
const SIZES = [[1920, 1080], [1536, 864], [1440, 900], [1440, 800], [1366, 768], [1280, 720]];

// Production on the day this was written.
const today = () => board([slot('L1', 'live'), slot('L2', 'live'), slot('L3', 'open', house), slot('L4', 'open'), slot('L5', 'open'), slot('R1', 'live'), slot('R2', 'live'), slot('R3', 'open')]);

test('the house slot sits immediately above the open unit, in the rail that takes it', () => {
  const r = composeRails(today(), { tapSlot: true });
  assert.deepEqual(ids(r.left), ['L1', 'L2', 'L3']);
  assert.deepEqual(ids(r.right), ['R1', 'R2', 'TAP', 'L4']);
  assert.equal(r.right[2], TAP_SLOT);
  assert.equal(r.right[3].state, 'open');
});

test('every other slot keeps its rail and its order; switched off, nothing changes', () => {
  const on = composeRails(today(), { tapSlot: true });
  const off = composeRails(today(), { tapSlot: false });
  assert.deepEqual(ids(off.left), ['L1', 'L2', 'L3']);
  assert.deepEqual(ids(off.right), ['R1', 'R2', 'L4']);
  assert.deepEqual(ids(on.left), ids(off.left));
  assert.deepEqual(ids(on.right).filter((id) => id !== 'TAP'), ids(off.right));
});

test('it follows the open unit to whichever rail takes it', () => {
  // The right rail is the longer one here, so the open unit goes left, and the house slot with it.
  const b = board([slot('L1', 'live'), slot('L2', 'open'), slot('R1', 'live'), slot('R2', 'live'), slot('R3', 'reserved')]);
  const r = composeRails(b, { tapSlot: true });
  assert.deepEqual(ids(r.left), ['L1', 'TAP', 'L2']);
  assert.deepEqual(ids(r.right), ['R1', 'R2', 'R3']);
});

test('no open unit: it closes the rail the open unit would have taken', () => {
  const b = board([slot('L1', 'live'), slot('L2', 'live'), slot('R1', 'live')]);
  const r = composeRails(b, { tapSlot: true });
  assert.deepEqual(ids(r.left), ['L1', 'L2']);
  assert.deepEqual(ids(r.right), ['R1', 'TAP']);
});

test('it is not inventory: never a sellable slot, never in the board', () => {
  const b = today();
  composeRails(b, { tapSlot: true });
  assert.equal(b.slots.some((s) => s.id === 'TAP'), false);
  assert.equal(TAP_SLOT.priceCents, 0);
  assert.equal(TAP_SLOT.sponsor, null);
  assert.throws(() => { TAP_SLOT.state = 'live'; });
});

test('rows: the rail that holds more cards sets the size for both', () => {
  const r = composeRails(today(), { tapSlot: true });
  assert.equal(railRows(r), 4);
  assert.equal(railRows(r, true), 5);
  assert.equal(railRows(composeRails(today(), { tapSlot: false })), 3);
  assert.equal(railRows({ left: [], right: [] }), 1);
});

test('card height at the six standard sizes, four rows', () => {
  const expected = { '1920x1080': 176, '1536x864': 176, '1440x900': 176, '1440x800': 170, '1366x768': 162, '1280x720': 150 };
  for (const [w, h] of SIZES) assert.equal(railCardHeight(4, h), expected[`${w}x${h}`], `${w}x${h}`);
  // Equal rails give exactly what the flex split gave before.
  for (const [, h] of SIZES) assert.equal(railCardHeight(3, h), Math.min(176, (h - 90 - 20) / 3));
});

test('at the six sizes every card holds a full four-line tagline and the house card holds all of its content', () => {
  assert.equal(cardHeightFor(4), 139);
  assert.equal(cardHeightFor(1), 94);
  assert.equal(cardHeightFor(0), 77);
  for (const [w, h] of SIZES) {
    const card = railCardHeight(4, h);
    assert.ok(card >= cardHeightFor(RAIL.tagMaxLines), `${w}x${h}: ${card}px holds icon, name and four tagline lines`);
    assert.ok(card >= RAIL.tapFull, `${w}x${h}: ${card}px holds the house card in full`);
  }
});

test('sizing rules: rows, then the tagline gives way a line at a time only where the card cannot hold it', () => {
  const css = railSizingCss(4);
  assert.match(css, /^@media \(min-width:1280px\)\{aside\.sp-rail\{--sp-rows:4\}/);
  assert.match(css, /aside\.sp-rail \.sp-card \.sp-tag\{display:-webkit-box;-webkit-line-clamp:4;line-clamp:4\}/);
  const at = [...css.matchAll(/max-height:(\d+)px\)\{aside\.sp-rail \.sp-card \.sp-tag\{([^}]*)\}/g)].map((m) => [Number(m[1]), m[2]]);
  assert.deepEqual(at, [
    [675, '-webkit-line-clamp:3;line-clamp:3'],
    [615, '-webkit-line-clamp:2;line-clamp:2'],
    [555, '-webkit-line-clamp:1;line-clamp:1'],
    [495, 'display:none'],
  ]);
  // Every threshold is where the card height crosses what that many lines need.
  for (const [below, rule] of at) {
    const lines = rule === 'display:none' ? 1 : Number(rule.match(/clamp:(\d)/)[1]) + 1;
    assert.ok(railCardHeight(4, below + 1) >= cardHeightFor(lines), `at ${below + 1}px ${lines} lines fit`);
    assert.ok(railCardHeight(4, below) < cardHeightFor(lines), `at ${below}px they do not`);
  }
  // None of them is reached at the six standard sizes.
  for (const [, h] of SIZES) assert.ok(at.every(([below]) => h > below));
  // The house card sheds its own lines first, and before any sponsor line goes.
  const line = Number(css.match(/max-height:(\d+)px\)\{aside\.sp-rail \.tap-slot-card \.tap-rail-line/)[1]);
  const tag = Number(css.match(/max-height:(\d+)px\)\{aside\.sp-rail \.tap-slot-card \.tap-rail-tag/)[1]);
  assert.equal(line, 711);
  assert.equal(tag, 627);
  assert.ok(line > at[0][0], 'the house card gives way before a sponsor tagline does');
  assert.doesNotMatch(css, /[<]/);
  // More rows, taller thresholds.
  assert.match(railSizingCss(5), /--sp-rows:5/);
  assert.match(railSizingCss(3), /--sp-rows:3/);
});

/* A card that is down says when it came down, not when its paid month would
   have ended. */
test('cardDownAt: the real end of a card that is no longer showing', async () => {
  const { cardDownAt } = await import('../src/lib/sponsors.js');
  const now = Date.UTC(2026, 0, 10);
  const day = 24 * 60 * 60 * 1000;
  // Taken down early: ends_at is the takedown, the paid month runs on.
  assert.equal(cardDownAt({ status: 'expired', ends_at: now - day, paid_through: now + 20 * day }, now), now - day);
  // Its time ran out and the daily job has not marked it yet.
  assert.equal(cardDownAt({ status: 'live', ends_at: now - 1 }, now), now - 1);
  // Still showing, cancelled or not.
  assert.equal(cardDownAt({ status: 'live', ends_at: now + day, cancel_at: now }, now), null);
  // Not a card yet, or nothing to go on.
  assert.equal(cardDownAt({ status: 'submitted', ends_at: null }, now), null);
  assert.equal(cardDownAt({ status: 'expired', ends_at: null }, now), null);
  assert.equal(cardDownAt(null, now), null);
});
