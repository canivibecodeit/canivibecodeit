/* Content-Security-Policy: the policy string, the one inline script it
   allows, and that script's hash. The script text lives HERE and nowhere
   else: Base.astro injects this exact string and the header hashes this
   exact string, so the fingerprint can never drift from the markup.

   Anything new the site loads or runs needs a matching allowance below, or
   browsers will refuse it once the policy is enforced. Report-only mode
   (the default) surfaces misses in the Railway logs via /api/csp-report
   before they can break anything. */
import { createHash } from 'node:crypto';

/* Theme before first paint: the one script that must stay inline (an
   external fetch would flash the wrong theme). ClientRouter swaps <html>
   attributes on soft navigations, so the incoming document gets the theme
   stamped at astro:before-swap — BEFORE it enters the DOM. (after-swap ran a
   frame too late: the attribute-less <html> painted with the default dark
   tokens first, a black flicker on every light-mode navigation.)
   theme-color values must match --bg in global.css for each theme; app.js's
   toggle keeps the meta in step too. */
export const THEME_SCRIPT = `(() => {
  const paint = (doc) => {
    const theme =
      localStorage.getItem('theme') ||
      (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    doc.documentElement.dataset.theme = theme;
    const meta = doc.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'light' ? '#f7f8f9' : '#0b0d0b';
  };
  paint(document);
  document.addEventListener('astro:before-swap', (e) => paint(e.newDocument));
})();`;

const themeHash = createHash('sha256').update(THEME_SCRIPT, 'utf8').digest('base64');

/* Referrer-aware hide for the How to AI placements: a visitor who arrived
   from Ruben's own Substack (referrer) or a substack/howtoai/ruben utm_source
   is flagged for the session, and <html class="ruben-src"> hides every
   [data-hide-for-ruben] element before first paint (no flash). Inline for
   the same reason as the theme script; hashed the same way. */
export const REC_HIDE_SCRIPT = `(() => {
  try {
    const k = 'cvci_rubensrc';
    if (/substack\.com/i.test(document.referrer) || /[?&]utm_source=[^&]*(substack|howtoai|ruben)/i.test(location.search)) {
      sessionStorage.setItem(k, '1');
    }
    const mark = (doc) => { if (sessionStorage.getItem(k) === '1') doc.documentElement.classList.add('ruben-src'); };
    mark(document);
    document.addEventListener('astro:before-swap', (e) => mark(e.newDocument));
  } catch {}
})();`;

const recHideHash = createHash('sha256').update(REC_HIDE_SCRIPT, 'utf8').digest('base64');

/* Directive notes:
   - script-src: everything is same-origin files except the theme snippet.
   - style-src 'unsafe-inline': style= attributes are all over the markup;
     locking styles down buys little (CSS can't run script) and costs a lot.
   - img-src https:: sponsor logos and their favicon fallback are arbitrary
     external images by design (SponsorTape, details preview). Build
     screenshots served from the R2 media host (R2_PUBLIC_BASE) ride the
     same allowance.
   - font-src data:: Vite inlines sub-4KB font subsets into the CSS.
   - media-src: the header radio streams from nightride.fm; showcase demo
     videos are self-hosted on the R2 media domain.
   - form-action: the sponsor checkout form ends in a redirect to Stripe,
     which some browsers validate against form-action. */
const POLICY = [
  "default-src 'self'",
  `script-src 'self' 'sha256-${themeHash}' 'sha256-${recHideHash}' 'report-sample'`,
  "style-src 'self' 'unsafe-inline' 'report-sample'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' https://stream.nightride.fm https://media.vibecodeit.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https://checkout.stripe.com",
  "frame-ancestors 'self'",
  'report-uri /api/csp-report',
].join('; ');

/* Coverage notes: no worker-src on purpose (PostHog session recording is
   disabled, so nothing spawns workers; default-src 'self' governs if that
   changes and a report will say so). A page that ever sets prerender = true
   is served by the static handler and skips middleware entirely, losing this
   header and the rest of the security set; don't prerender without solving
   that. */

/* Report-only unless CSP_ENFORCE is set on Railway: the same off/observe/
   enforce ladder as the origin lock, rollback is deleting the env var. */
export function cspHeader() {
  const enforce = ['1', 'true'].includes(process.env.CSP_ENFORCE);
  return {
    name: enforce ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only',
    value: POLICY,
  };
}
