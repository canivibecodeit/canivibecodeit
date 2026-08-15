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
   attributes on soft navigations, so the theme is re-applied on
   astro:after-swap (fires before paint). */
export const THEME_SCRIPT = `(() => {
  const apply = () => {
    const stored = localStorage.getItem('theme');
    const theme =
      stored || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    document.documentElement.dataset.theme = theme;
  };
  apply();
  document.addEventListener('astro:after-swap', apply);
})();`;

const themeHash = createHash('sha256').update(THEME_SCRIPT, 'utf8').digest('base64');

/* Directive notes:
   - script-src: everything is same-origin files except the theme snippet.
   - style-src 'unsafe-inline': style= attributes are all over the markup;
     locking styles down buys little (CSS can't run script) and costs a lot.
   - img-src https:: sponsor logos and their favicon fallback are arbitrary
     external images by design (SponsorTape, details preview).
   - font-src data:: Vite inlines sub-4KB font subsets into the CSS.
   - media-src: the header radio streams from nightride.fm.
   - form-action: the sponsor checkout form ends in a redirect to Stripe,
     which some browsers validate against form-action. */
const POLICY = [
  "default-src 'self'",
  `script-src 'self' 'sha256-${themeHash}' 'report-sample'`,
  "style-src 'self' 'unsafe-inline' 'report-sample'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' https://stream.nightride.fm",
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
