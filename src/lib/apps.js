import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Resolved from the working directory (the project root in dev and under
// systemd), because import.meta.url points inside dist/ after the build.
const DATA_DIR = process.env.APPS_DIR || path.resolve('data/apps');

export const CATEGORIES = {
  'meeting-notes': { label: 'Meeting notes', emoji: '🎙️' },
  'voice-dictation': { label: 'Dictation', emoji: '🗣️' },
  'link-in-bio': { label: 'Link in bio', emoji: '🔗' },
  'testimonials': { label: 'Testimonials', emoji: '💬' },
  'waitlists': { label: 'Waitlists', emoji: '📋' },
  'screenshots': { label: 'Screenshots', emoji: '🖼️' },
  'og-images': { label: 'OG images', emoji: '🏞️' },
  'uptime': { label: 'Uptime', emoji: '⏱️' },
  'qr-codes': { label: 'QR codes', emoji: '🐯' },
  'cron': { label: 'Cron monitoring', emoji: '⏰' },
  'website-builder': { label: 'Website builders', emoji: '🧱' },
  'analytics': { label: 'Analytics', emoji: '📊' },
  'scheduling': { label: 'Scheduling', emoji: '📅' },
  'social-media': { label: 'Social media', emoji: '🐦' },
  'design': { label: 'Design', emoji: '🎨' },
  'finance-accounting': { label: 'Finance & accounting', emoji: '🧾' },
  'tasks-calendar': { label: 'Tasks & calendar', emoji: '🗓️' },
  'ai-writing': { label: 'AI writing', emoji: '✍️' },
  'dev-tools': { label: 'Dev tools', emoji: '🛠️' },
  'automation': { label: 'Automation', emoji: '🤖' },
  'seo-marketing': { label: 'SEO & marketing', emoji: '📈' },
  'audio-video': { label: 'Audio & video', emoji: '🎬' },
  'notes-knowledge': { label: 'Notes & knowledge', emoji: '🧠' },
  'security': { label: 'Security', emoji: '🔐' },
  'ai-assistant': { label: 'AI assistants', emoji: '✨' },
  'forms': { label: 'Forms', emoji: '📝' },
  'no-code-apps': { label: 'No-code apps', emoji: '🧩' },
  'newsletter': { label: 'Newsletters', emoji: '📮' },
  'creator-commerce': { label: 'Creator commerce', emoji: '🛍️' },
  'personal-finance': { label: 'Personal finance', emoji: '💰' },
  'screen-recording': { label: 'Screen recording', emoji: '📹' },
  'rss-research': { label: 'RSS & research', emoji: '📡' },
  'presentations': { label: 'Presentations', emoji: '🖥️' },
  'hosting': { label: 'Hosting', emoji: '☁️' },
  'community': { label: 'Community', emoji: '👥' },
  'live-chat': { label: 'Live chat', emoji: '🗨️' },
  'read-it-later': { label: 'Read it later', emoji: '🔖' },
  'bookmarks': { label: 'Bookmarks', emoji: '📌' },
  'tasks': { label: 'Tasks', emoji: '✅' },
  'productivity-utilities': { label: 'Productivity utilities', emoji: '⚙️' },
  'email': { label: 'Email', emoji: '📬' },
  'whiteboard': { label: 'Whiteboards', emoji: '🧑‍🏫' },
  'diagrams': { label: 'Diagrams', emoji: '📐' },
  'ai-image': { label: 'AI images', emoji: '🎆' },
  'ai-video': { label: 'AI video', emoji: '🎞️' },
  'ai-audio': { label: 'AI audio', emoji: '🎧' },
  'ai-search': { label: 'AI search', emoji: '🔍' },
  'databases': { label: 'Databases', emoji: '🗄️' },
  'docs-databases': { label: 'Docs & databases', emoji: '📚' },
  'publishing': { label: 'Publishing', emoji: '📰' },
  'commerce': { label: 'Commerce', emoji: '🛒' },
};

export const VERDICTS = {
  yes: { label: 'YES', sub: 'one-shottable', color: 'yes' },
  kinda: { label: 'KINDA', sub: 'weekend project', color: 'kinda' },
  no: { label: 'NOT REALLY', sub: "don't bother", color: 'no' },
};

let cache;

export function allApps() {
  if (!cache) {
    cache = readdirSync(DATA_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const app = JSON.parse(readFileSync(path.join(DATA_DIR, f), 'utf8'));
        if (app.slug !== path.basename(f, '.json')) {
          throw new Error(`slug "${app.slug}" does not match filename ${f}`);
        }
        return app;
      });
  }
  return cache;
}

export function getApp(slug) {
  return allApps().find((a) => a.slug === slug);
}

export function appsByCategory(cat) {
  return allApps().filter((a) => a.category === cat);
}

export function categoriesInUse() {
  const counts = new Map();
  for (const a of allApps()) counts.set(a.category, (counts.get(a.category) ?? 0) + 1);
  return Object.entries(CATEGORIES)
    .filter(([slug]) => counts.has(slug))
    .map(([slug, meta]) => ({ slug, ...meta, count: counts.get(slug) }));
}

export function topCategories(n = 11) {
  return categoriesInUse()
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

// 3 related apps: the sheet's curated relatedSlugs first, then same category,
// then the best other YES apps by votes.
export function relatedApps(app, votes) {
  const rest = allApps().filter((a) => a.slug !== app.slug);
  const curated = (app.relatedSlugs ?? [])
    .map((s) => rest.find((a) => a.slug === s))
    .filter(Boolean);
  const same = rest.filter(
    (a) => a.category === app.category && !curated.includes(a)
  );
  const others = rest
    .filter((a) => a.category !== app.category && a.verdict === 'yes' && !curated.includes(a))
    .sort((a, b) => (votes?.(b.slug) ?? 0) - (votes?.(a.slug) ?? 0));
  return [...curated, ...same, ...others].slice(0, 3);
}

export function yearlySaving(app) {
  return app.priceMonthly != null ? app.priceMonthly * 12 : null;
}
