/* First-party PostHog proxy, same contract as the reverse-proxy config used
   on a plain VPS: /ph/static/* → assets host, everything else → ingest host.
   Exists so analytics stays same-origin when the app runs on a PaaS where we
   don't control the front proxy. */
const INGEST = 'https://eu.i.posthog.com';
const ASSETS = 'https://eu-assets.i.posthog.com';

async function proxy({ params, request, clientAddress }) {
  const path = params.path ? `/${params.path}` : '/';
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
