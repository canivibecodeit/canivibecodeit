// Showcase curation, token-gated like the build admin, JSON only, noindex.
//   POST  { token, model, urls: [...], dryRun? }  -> runs the ingest
//   PATCH { token, id, status? | featured_order? | text? } -> edits a demo
// Curation never needs a deploy: hide a post, reorder, tighten a line.
import { modelDemoById, updateModelDemo } from '../../../lib/db.js';
import { json, readBody } from '../../../lib/request.js';
import { isAdmin } from '../../../lib/sponsors.js';
import { showcaseModel } from '../../../lib/models.js';
import { DEMO_ID_RE, cleanText, ingestUrls } from '../../../lib/showcase.js';

const noindex = (res) => {
  res.headers.set('X-Robots-Tag', 'noindex');
  return res;
};

export async function POST({ request }) {
  let body;
  try {
    body = await readBody(request);
  } catch {
    return noindex(json({ error: 'bad request' }, 400));
  }
  if (!isAdmin(body.token)) return noindex(json({ error: 'not found' }, 404));
  const model = showcaseModel(body.model);
  if (!model) return noindex(json({ error: 'unknown model' }, 400));
  const urls = Array.isArray(body.urls) ? body.urls.map(String).slice(0, 50) : [];
  if (urls.length === 0) return noindex(json({ error: 'urls[] required' }, 400));
  const lines = [];
  // keepOrder: true = refresh media only, false = the list is the new order;
  // omitted = a single URL keeps its slot, a list re-orders.
  const keepOrder = typeof body.keepOrder === 'boolean' ? body.keepOrder : null;
  const results = await ingestUrls({ model: model.slug, urls, dryRun: !!body.dryRun, keepOrder, log: (l) => lines.push(l) });
  return noindex(json({ ok: true, model: model.slug, results, log: lines }));
}

export async function PATCH({ request }) {
  let body;
  try {
    body = await readBody(request);
  } catch {
    return noindex(json({ error: 'bad request' }, 400));
  }
  if (!isAdmin(body.token)) return noindex(json({ error: 'not found' }, 404));
  const id = String(body.id ?? '');
  if (!DEMO_ID_RE.test(id) || !(await modelDemoById(id))) return noindex(json({ error: 'no such demo' }, 404));

  const fields = {};
  if (body.status !== undefined) {
    if (!['live', 'hidden'].includes(body.status)) return noindex(json({ error: 'status: live | hidden' }, 400));
    fields.status = body.status;
  }
  if (body.featured_order !== undefined) {
    const n = Number(body.featured_order);
    if (!Number.isInteger(n) || n < 0 || n > 10000) return noindex(json({ error: 'featured_order: 0..10000' }, 400));
    fields.featured_order = n;
  }
  if (body.text !== undefined) {
    const t = cleanText(body.text);
    if (!t) return noindex(json({ error: 'text: 1..280 characters' }, 400));
    fields.text = t;
  }
  if (Object.keys(fields).length === 0) return noindex(json({ error: 'nothing to change' }, 400));
  await updateModelDemo(id, fields);
  return noindex(json({ ok: true, id, ...fields }));
}
