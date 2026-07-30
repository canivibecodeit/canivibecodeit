import { allApps, categoriesInUse } from '../lib/apps.js';

export async function GET() {
  const base = 'https://canivibecodeit.com';
  const urls = [
    `${base}/`,
    ...allApps().map((a) => `${base}/${a.slug}`),
    ...categoriesInUse().map((c) => `${base}/category/${c.slug}`),
    `${base}/categories`,
    `${base}/stats`,
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
