import { allApps, alternativesSitemapApps, productsSitemap, categoriesInUse, moatsInUse } from '../lib/apps.js';

export async function GET() {
  const base = 'https://canivibecodeit.com';
  const altPages = alternativesSitemapApps();
  const urls = [
    `${base}/`,
    ...allApps().map((a) => `${base}/${a.slug}`),
    ...altPages.map((a) => `${base}/${a.slug}/alternatives`),
    ...(altPages.length > 0 ? [`${base}/alternatives`] : []),
    ...productsSitemap().map((p) => `${base}/alternative/${p.slug}`),
    ...categoriesInUse().map((c) => `${base}/category/${c.slug}`),
    `${base}/categories`,
    ...moatsInUse().map((m) => `${base}/moat/${m.tag}`),
    `${base}/moats`,
    `${base}/stats`,
    `${base}/best-vibe-coding-tools`,
    `${base}/vibecode-this-site`,
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n')}
</urlset>
`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml' },
  });
}
