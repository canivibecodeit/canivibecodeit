// Icon upload for a homepage sponsor card, post-checkout. Same token model
// as the details save: the purchase must still be editable (paid or
// submitted). The hosted icon lands in logo_url, the field the card and the
// approval mail already read; revert restores the favicon default the
// details save would compute.
import { purchaseByToken, updatePurchase } from '../../../lib/db.js';
import { iconEndpoint } from '../../../lib/icon-upload.js';
import { clearCache, faviconUrl } from '../../../lib/sponsors.js';

const EDITABLE = ['paid', 'submitted'];

export const POST = iconEndpoint({
  surface: 'sponsor',
  resolve: async ({ token }) => {
    const purchase = await purchaseByToken(token);
    if (!purchase) return { error: 'not found', status: 404 };
    if (!EDITABLE.includes(purchase.status)) return { error: 'this slot is no longer editable', status: 409 };
    return { subject: purchase, keyStem: `sponsor-icons/${purchase.id}` };
  },
  apply: async (purchase, url) => {
    const changed = await updatePurchase(purchase.id, { logo_url: url }, EDITABLE);
    if (!changed) return { error: 'this slot is no longer editable', status: 409 };
    clearCache();
    return { icon_url: url };
  },
  revert: async (purchase) => {
    const url = (purchase.url && faviconUrl(purchase.url)) || null;
    await updatePurchase(purchase.id, { logo_url: url }, EDITABLE);
    clearCache();
    return { icon_url: url };
  },
});
