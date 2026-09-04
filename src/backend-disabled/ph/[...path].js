/* First-party PostHog proxy, same contract as the reverse-proxy config used
   on a plain VPS: /ph/static/* → assets host, everything else → ingest host.
   Exists so analytics stays same-origin when the app runs on a PaaS where we
   don't control the front proxy. */
const INGEST = 'https://eu.i.posthog.com';
const ASSETS = 'https://eu-assets.i.posthog.com';

/* Scripted-browser filter (first seen 2026-08-22): a GB machine running two
   Firefox profiles in a loop against the homepage, also clicking every
   sponsor slot. Its ingest gets swallowed here so analytics and the event
   quota stay clean; the site itself still serves it. Scoped to country GB so
   a real user elsewhere with the same user agent keeps analytics. */
const DROP_UAS = new Set([
  'Mozilla/5.0 (Windows NT 6.1; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0',
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0',
]);
let dropCount = 0;

async function proxy({ params, request, clientAddress }) {
  const path = params.path ? `/${params.path}` : '/';
  if (
    !path.startsWith('/static/') &&
    DROP_UAS.has(request.headers.get('user-agent') || '') &&
    (request.headers.get('cf-ipcountry') || '') === 'GB'
  ) {
    // Sampled log line so the source IP is on record without flooding.
    if (dropCount++ % 200 === 0) {
      console.warn(`ph-drop: ${request.headers.get('cf-connecting-ip') || '?'} (${dropCount} dropped since boot)`);
    }
    return new Response('{"status": 1}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const search = new URL(request.url).search;
  const upstreamBase = path.startsWith('/static/') ? ASSETS : INGEST;
  const upstream = upstreamBase + path + search;

  const headers = new Headers(request.headers);
  headers.set('Host', new URL(upstreamBase).host);
  headers.delete('cookie');
  // Upstream is itself behind Cloudflare, which rejects requests carrying
  // another Cloudflare's edge headers (error 1000 on the assets host) — so
  // drop everything our own edge injected before re-fetching.
  for (const name of [...headers.keys()]) {
    if (name.startsWith('cf-') || name.startsWith('x-railway-')) headers.delete(name);
  }
  headers.delete('cdn-loop');
  // The origin-lock secret our own edge stamps on every request must never
  // travel to a third party.
  headers.delete('x-origin-verify');
  headers.delete('x-forwarded-host');
  headers.delete('x-forwarded-proto');
  headers.delete('x-forwarded-for');
  headers.delete('x-real-ip');
  const ip =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    clientAddress;
  if (ip) headers.set('X-Forwarded-For', ip);

  const res = await fetch(upstream, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    duplex: 'half',
    redirect: 'manual',
  });

  const out = new Headers(res.headers);
  out.delete('content-encoding');
  out.delete('content-length');
  out.delete('transfer-encoding');
  return new Response(res.body, { status: res.status, headers: out });
}

export const GET = proxy;
export const POST = proxy;
export const OPTIONS = proxy;
export const HEAD = proxy;
