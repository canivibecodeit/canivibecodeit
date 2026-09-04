import { purchaseByToken, rateLimit, updatePurchase } from '../../../lib/db.js';
import { alertAdmin, button, esc, shell } from '../../../lib/mail.js';
import { clientIp, json, readBody } from '../../../lib/request.js';
import { hostedIconUrl } from '../../../lib/sponsor-icon.js';
import {
  cleanText, cleanTint, cleanUrl, clearCache, DEFAULT_TINT, faviconUrl, LIMITS,
  signAction, siteUrl, usd, withUtm,
} from '../../../lib/sponsors.js';

export async function POST({ request, clientAddress }) {
  const ip = clientIp(request, clientAddress);
  const wantsJson = (request.headers.get('content-type') || '').includes('application/json');
  if (!(await rateLimit(`sponsor-details:${ip}`, 20, 60 * 60 * 1000))) {
    return json({ error: 'slow down' }, 429);
  }

  let body;
  try {
    body = await readBody(request);
  } catch {
    return json({ error: 'bad request' }, 400);
  }

  const token = String(body.t ?? '').trim();
  const purchase = token ? await purchaseByToken(token) : null;
  if (!purchase) return json({ error: 'not found' }, 404);
  // Resubmitting while we still haven't approved is allowed — typos happen.
  if (purchase.status !== 'paid' && purchase.status !== 'submitted') {
    return json({ error: 'this slot is no longer editable' }, 409);
  }

  const name = cleanText(body.name, LIMITS.name);
  const tagline = cleanText(body.tagline, LIMITS.tagline);
  const url = cleanUrl(body.url);
  if (!name) return json({ error: 'name is required' }, 400);
  if (!tagline) return json({ error: 'tagline is required' }, 400);
  if (!url) return json({ error: 'that URL looks off' }, 400);

  // logo_url is never taken from the form as-is: the card, the approval mail
  // and the decide page all load it, so an arbitrary URL is a tracking
  // beacon. Accepted only when it is THIS purchase's icon on our own R2 or
  // exactly the favicon default for the URL being saved; otherwise the
  // stored icon survives when it is ours, else the favicon default.
  const submitted = body.logo_url ? cleanUrl(body.logo_url) : null;
  const ours = (u) => hostedIconUrl(u, 'sponsor-icons') && String(u).includes(`/sponsor-icons/${purchase.id}-`);
  const fallback = faviconUrl(url);
  const logoUrl =
    submitted && (ours(submitted) || submitted === fallback)
      ? submitted
      : ours(purchase.logo_url)
        ? purchase.logo_url
        : fallback;
  const now = Date.now();
  const fields = {
    name,
    tagline,
    url,
    logo_url: logoUrl,
    tint: cleanTint(body.tint) || purchase.tint || DEFAULT_TINT,
    status: 'submitted',
    submitted_at: now,
  };
  const changed = await updatePurchase(purchase.id, fields, ['paid', 'submitted']);
  if (!changed) return json({ error: 'this slot is no longer editable' }, 409);
  clearCache();

  const approve = `${siteUrl('/admin/decide')}?id=${purchase.id}&action=approve&sig=${signAction(purchase.id, 'approve')}`;
  const reject = `${siteUrl('/admin/decide')}?id=${purchase.id}&action=reject&sig=${signAction(purchase.id, 'reject')}`;
  await alertAdmin(
    `sponsor slot ${purchase.slot_id}: ${name} needs a decision`,
    shell(
      `<p style="color:#6e6e67;">${esc(purchase.slot_id)} &middot; ${esc(usd(purchase.amount_cents))}`
      + ` &middot; ${esc(purchase.email || 'no email')}</p>`
      + `<table role="presentation" cellpadding="0" cellspacing="0" style="border:1px solid #e0e0db;`
      + ` border-radius:8px; padding:14px; margin:14px 0;"><tr>`
      + `<td valign="top" width="40"><img src="${esc(fields.logo_url)}" width="26" height="26" alt="" /></td>`
      + `<td valign="top"><b>${esc(name)}</b><br /><span style="color:#6e6e67;">${esc(tagline)}</span></td>`
      + `</tr></table>`
      + `<p><a href="${esc(withUtm(url))}">${esc(url)}</a> &middot; tint ${esc(fields.tint)}</p>`
      + `<p style="padding-top:8px;">${button(approve, 'review & approve')}`
      + ` &nbsp; <a href="${esc(reject)}" style="color:#b4552f;">reject + refund</a></p>`
      + `<p style="color:#6e6e67; font-size:12px;">Both links open a confirmation page;`
      + ` nothing changes until you tap the button there.</p>`
    )
  );

  if (wantsJson) return json({ ok: true });
  // Without JS the same form posts here directly and belongs back on its page.
  return new Response(null, {
    status: 303,
    headers: { Location: `/sponsor/details?t=${encodeURIComponent(token)}` },
  });
}
