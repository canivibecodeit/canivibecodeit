/* The embeddable badge, served at /challenge/badge.js with the site origin
   injected from the environment (mirror and production each phone their own
   home). Entrants paste one script tag; the badge is a fixed corner pill
   linking back to the challenge, and it phones home ONE counter beacon per
   page load — no cookies, no fingerprints, nothing per-visitor. The Vibe
   Jam widget model: a live link that also counts. */
import { challengeLive } from '../../lib/flags.js';

export function GET() {
  if (!challengeLive()) return new Response(null, { status: 404 });

  const origin = process.env.SITE_URL || 'https://vibecodeit.com';

  const body = `(function () {
  if (window.__cvciBadge) return; window.__cvciBadge = 1;
  var ORIGIN = ${JSON.stringify(origin)};
  var s = document.currentScript;
  var entry = (s && s.getAttribute('data-entry')) || '';
  if (!/^ce_[a-z2-9]{10}$/.test(entry)) entry = '';

  var mount = function () {
    var a = document.createElement('a');
    a.href = ORIGIN + '/challenge' + (entry ? '?e=' + entry : '');
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'i vibecoded it';
    a.setAttribute('aria-label', 'This site was vibecoded for the vibecodeit challenge');
    a.style.cssText = [
      'position:fixed', 'right:12px', 'bottom:12px', 'z-index:2147483646',
      'font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace',
      'color:#33e667', 'background:#14171a', 'border:1px solid #2e332d',
      'border-radius:999px', 'padding:8px 14px', 'text-decoration:none',
      'box-shadow:0 2px 10px rgba(0,0,0,.35)', 'opacity:.92', 'letter-spacing:.02em',
    ].join(';');
    a.onmouseenter = function () { a.style.opacity = '1'; };
    a.onmouseleave = function () { a.style.opacity = '.92'; };
    document.body.appendChild(a);

    if (entry && navigator.sendBeacon) {
      try {
        navigator.sendBeacon(ORIGIN + '/api/challenge/beacon', JSON.stringify({ id: entry }));
      } catch (e) { /* their page must never notice us */ }
    }
  };

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();`;

  return new Response(body, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
