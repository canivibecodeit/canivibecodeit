// PostHog loader, served at /analytics.js with the project key injected from
// the environment — the repo stays generic, the deployment carries the key.
// Traffic goes to <origin>/ph/*, reverse-proxied to PostHog by the web server,
// so analytics stays first-party (see README deploy notes).
export function GET() {
  const key = process.env.POSTHOG_KEY || '';
  const uiHost = process.env.POSTHOG_UI_HOST || 'https://eu.posthog.com';

  const body = key
    ? `(function () {
  var s = document.createElement('script');
  s.src = location.origin + '/ph/static/array.js';
  s.async = true;
  s.crossOrigin = 'anonymous';
  s.onload = function () {
    posthog.init(${JSON.stringify(key)}, {
      api_host: location.origin + '/ph',
      ui_host: ${JSON.stringify(uiHost)},
      // Nothing ever calls identify(), so every event stays anonymous —
      // billed at the anonymous rate, no person profiles created.
      person_profiles: 'identified_only',
      // ClientRouter navigations are pushState, not loads: history_change
      // captures a pageview for each soft navigation too.
      capture_pageview: 'history_change',
      // Only $pageview and the explicit custom events are consumed anywhere
      // (stats page, strip, globe, exports). Pageleave, autocapture and web
      // vitals were ~68% of event volume with zero readers.
      capture_pageleave: false,
      autocapture: false,
      capture_performance: { web_vitals: false },
      disable_session_recording: true,
      // Private pages never load this script on a full load, but a soft
      // navigation carries the already-initialised posthog with it. Same
      // list as isPrivate in Base.astro: no token-bearing URL may ever
      // reach analytics, so drop every event captured on one.
      before_send: function (ev) {
        var url = (ev && ev.properties && ev.properties.$current_url) || '';
        if (/\\/admin|\\/sponsor\\/(details|stats)|\\/thebuildgames\\/(details|entry)|\\/account|[?&]token=/.test(url)) return null;
        return ev;
      }
    });
  };
  document.head.appendChild(s);
})();`
    : '/* analytics disabled: POSTHOG_KEY not set */';

  return new Response(body, {
    headers: {
      'Content-Type': 'application/javascript',
      'Cache-Control': 'public, max-age=300, must-revalidate',
    },
  });
}
