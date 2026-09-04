/* Reader-submitted guides for the sunday newsletter.

   One set of rules, two callers: the API validates against them and the form
   page renders its limits from the same constants, so the counter under the
   textarea can never disagree with what the server accepts. */

export const LIMITS = {
  title: { min: 8, max: 140 },
  author: { min: 2, max: 60 },
  link: { max: 300 },
  summary: { max: 300 },
  // Long enough to rule out a paste of a tweet, short enough that one POST
  // stays a sane request body. 40k characters is roughly 6,000 words.
  body: { min: 600, max: 40000 },
};

export const STATUSES = ['pending', 'accepted', 'rejected'];

/* Drop C0/C1 control characters. Written as a code-point test rather than a
   regex class so the source carries no literal control bytes of its own.
   `keepBreaks` spares tab and newline: Markdown without newlines is not
   Markdown, but a single-line field has no business holding either. */
function stripControl(value, keepBreaks) {
  let out = '';
  for (const ch of value) {
    const c = ch.codePointAt(0);
    if (keepBreaks && (c === 9 || c === 10)) {
      out += ch;
      continue;
    }
    // A single-line field turns a control character into a space so the
    // whitespace collapse below joins the words; deleting it would weld
    // "title<tab>with" into "titlewith".
    if (c < 32 || (c >= 127 && c <= 159)) {
      if (!keepBreaks) out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

export const cleanLine = (value, max) =>
  typeof value === 'string' ? stripControl(value, false).replace(/\s+/g, ' ').trim().slice(0, max) : '';

export const cleanBody = (value, max) =>
  typeof value === 'string'
    ? stripControl(value.replace(/\r\n?/g, '\n'), true).trim().slice(0, max)
    : '';

/* A public http(s) URL, or null. Same shape check the app submitter uses: no
   bare hosts, no IP literals, nothing that could aim a later fetch at an
   internal service. */
export function parseLink(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  if (raw.length > LIMITS.link.max) return null;
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u;
  try {
    u = new URL(withProto);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(host)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.endsWith('.local') || host.endsWith('.internal')) return null;
  return u.href;
}

export function wordCount(body) {
  const trimmed = (body || '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/* Returns { ok, error } or { ok, value }. The error string is shown to the
   writer as typed, so it says what to do rather than which rule failed. */
export function validateArticle(input) {
  const title = cleanLine(input.title, LIMITS.title.max);
  const author = cleanLine(input.author, LIMITS.author.max);
  const email = cleanLine(input.email, 254).toLowerCase();
  const summary = cleanLine(input.summary, LIMITS.summary.max);
  const body = cleanBody(input.body, LIMITS.body.max);
  const link = parseLink(input.link);

  if (title.length < LIMITS.title.min) return { ok: false, error: 'give the guide a real title' };
  if (author.length < LIMITS.author.min) return { ok: false, error: 'tell us who to credit' };
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'that email does not look right' };
  if (typeof input.link === 'string' && input.link.trim() && !link) {
    return { ok: false, error: 'that link does not look like a public URL' };
  }
  if (body.length < LIMITS.body.min) {
    return {
      ok: false,
      error: `the draft is too short · ${LIMITS.body.min} characters minimum, this one is ${body.length}`,
    };
  }

  return { ok: true, value: { title, author, email, link, summary: summary || null, body } };
}
