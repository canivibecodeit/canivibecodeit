/* Reader-guide validator: the rules shared by /write and /api/article. Every
   rejection path and the two cleaning modes (single-line collapses whitespace,
   the body keeps its newlines) are pinned here. Run: npm test */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LIMITS, cleanBody, cleanLine, parseLink, validateArticle, wordCount } from '../src/lib/articles.js';

const LONG = 'word '.repeat(200); // 1,000 chars, comfortably over the minimum
const good = (over = {}) => ({
  title: 'How to ship a CLI in one weekend',
  author: 'Ada Lovelace',
  email: 'Ada@Example.com',
  link: 'example.com/post',
  summary: 'A short summary.',
  body: LONG,
  ...over,
});

test('a good draft validates, with the email lowercased and the link normalised', () => {
  const r = validateArticle(good());
  assert.equal(r.ok, true);
  assert.equal(r.value.email, 'ada@example.com');
  assert.equal(r.value.link, 'https://example.com/post');
  assert.equal(r.value.summary, 'A short summary.');
});

test('each rejection names what to do, not which rule failed', () => {
  assert.equal(validateArticle(good({ title: 'tiny' })).error, 'give the guide a real title');
  assert.equal(validateArticle(good({ author: '' })).error, 'tell us who to credit');
  assert.equal(validateArticle(good({ email: 'nope' })).error, 'that email does not look right');
  assert.equal(validateArticle(good({ link: 'http://127.0.0.1/x' })).error, 'that link does not look like a public URL');
  assert.match(validateArticle(good({ body: 'too short' })).error, /too short · 600 characters minimum, this one is 9/);
});

test('an empty link is optional; a present-but-bad one is refused', () => {
  assert.equal(validateArticle(good({ link: '' })).value.link, null);
  assert.equal(validateArticle(good({ link: undefined })).value.link, null);
  assert.equal(validateArticle(good({ link: 'localhost' })).ok, false);
  assert.equal(validateArticle(good({ link: 'http://internal.local/x' })).ok, false);
});

test('the body keeps newlines; single-line fields collapse them and tabs to one space', () => {
  const r = validateArticle(good({ body: 'line1\nline2\n\n' + LONG, title: 'A title\twith\ttabs in it' }));
  assert.ok(r.value.body.includes('\n'));
  assert.equal(r.value.title, 'A title with tabs in it');
});

test('control characters are dropped from the body but tab and newline survive', () => {
  const hostile = 'a' + String.fromCharCode(0) + 'b' + String.fromCharCode(7) + 'c\td\ne';
  assert.equal(cleanBody(hostile, 100), 'abc\td\ne');
  assert.equal(cleanLine(hostile, 100), 'a b c d e');
});

test('CRLF bodies are normalised to LF', () => {
  assert.equal(cleanBody('one\r\ntwo\rthree', 100), 'one\ntwo\nthree');
});

test('oversized fields are truncated to their caps rather than rejected', () => {
  const r = validateArticle(good({ body: 'x'.repeat(LIMITS.body.max + 5000) }));
  assert.equal(r.ok, true);
  assert.equal(r.value.body.length, LIMITS.body.max);
});

test('parseLink accepts schemeless public hosts and refuses everything internal', () => {
  assert.equal(parseLink('example.com'), 'https://example.com/');
  assert.equal(parseLink('https://sub.example.org/p?q=1'), 'https://sub.example.org/p?q=1');
  assert.equal(parseLink('ftp://example.com'), null);
  assert.equal(parseLink('10.0.0.1'), null);
  assert.equal(parseLink('box.internal'), null);
  assert.equal(parseLink('x'.repeat(LIMITS.link.max + 1)), null);
  assert.equal(parseLink(''), null);
  assert.equal(parseLink(null), null);
});

test('wordCount is whitespace-split and empty-safe', () => {
  assert.equal(wordCount('one two  three\nfour'), 4);
  assert.equal(wordCount('   '), 0);
  assert.equal(wordCount(undefined), 0);
});

test('the source carries no raw control bytes (they were written as code-point tests on purpose)', () => {
  const raw = readFileSync(new URL('../src/lib/articles.js', import.meta.url));
  const bad = [...raw].filter((b) => b < 9 || b === 11 || b === 12 || (b >= 14 && b <= 31) || b === 127);
  assert.equal(bad.length, 0);
});
