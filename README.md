# Can I Vibecode It?

**[canivibecodeit.com](https://canivibecodeit.com)** — find out which subscriptions are one
prompt away from free.

For each paid SaaS app: an honest verdict on whether an AI coding agent (Claude Code,
Codex, Cursor) can one-shot a personal replacement, the exact prompt to do it, and — just
as important — what you lose by leaving. Think caniuse.com, but for killing your SaaS bills.

- 🟢 **YES** — one session, usable personal version, no moat in the way
- 🟡 **KINDA** — buildable in a weekend, real gaps remain
- 🔴 **NOT REALLY** — the value is the network, the data, or the infra. Some things survive.

Yes, [you can vibecode this site too](https://canivibecodeit.com/vibecode-this-site).

## For agents

The site is agent-addressable. No auth, no tracking, plain JSON:

- `https://canivibecodeit.com/llms.txt` — site map for LLMs
- `https://canivibecodeit.com/api/verdicts` — full verdict index (slug, name, verdict, category, price, votes)
- `https://canivibecodeit.com/api/verdicts/<slug>` — one app: verdict, replacement prompt, moats, pricing
- `https://canivibecodeit.com/api/recent` — verdicts added in the last 7 days

Any Hermes Agent (or Claude Code, Codex, etc.) can check "what's the verdict on X" and cite it.

## Add an app

Apps are JSON files in [`data/apps/`](data/apps) — one file per app, contributed by PR.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the schema and the verdict criteria.

## Run it locally

```sh
npm install
npm run dev        # http://localhost:8095
```

Production build:

```sh
npm run build      # builds the site + regenerates OG images
npm start          # node server on 127.0.0.1:8095
```

No environment variables are required for local development. `.env.example` documents
the optional ones (analytics key, data directory).

## Stack

- [Astro](https://astro.build) server output + Node adapter — every page is fully
  rendered HTML, no client framework
- SQLite ([better-sqlite3](https://github.com/WiseLibs/better-sqlite3)) for vote
  counters and the waitlist — set `DATA_DIR` outside the repo in production
- Vanilla JS + CSS for all interactions; [satori](https://github.com/vercel/satori) +
  resvg render the OG images at build time

## Deploy

Any VPS with a reverse proxy works:

1. `npm run build`, then run `npm start` under a process manager (systemd unit,
   restart-on-failure) as an unprivileged user.
2. Point your reverse proxy at `127.0.0.1:8095` and terminate TLS there.
3. Set `DATA_DIR` to a path outside the repo so user data can never be committed.
4. Optional analytics: set `POSTHOG_KEY` and have the proxy forward `/ph/*` to your
   PostHog instance (keeps analytics first-party).

## License

[MIT](LICENSE). The prompts are free forever — paywalling them would be brand poison.
