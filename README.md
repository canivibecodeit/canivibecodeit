# Vibecode It?

**[vibecodeit.com](https://vibecodeit.com)** — find out which subscriptions are one
prompt away from free.

For each paid SaaS app: an honest verdict on whether an AI coding agent (Claude Code,
Codex, Cursor) can one-shot a personal replacement, the exact prompt to do it, and — just
as important — what you lose by leaving. Think caniuse.com, but for killing your SaaS bills.

- 🟢 **YES** — one session, usable personal version, no moat in the way
- 🟡 **KINDA** — buildable in a weekend, real gaps remain
- 🔴 **NOT REALLY** — the value is the network, the data, or the infra. Some things survive.

Yes, [you can vibecode this site too](https://vibecodeit.com/vibecode-this-site).

## About

**Vibecode It** is built and maintained by **Faizan Ali** — computer science student and
lead software engineer. It is a modified fork of the open-source project
[Can I Vibecode It?](https://canivibecodeit.com) by [Rob Hallam](https://x.com/robj3d3)
([source](https://github.com/canivibecodeit/canivibecodeit)). Original credit stays with
Rob; product branding, copy, and ongoing work here are Faizan's.

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
npm start          # previews the static dist/ output on 127.0.0.1:4321
```

No environment variables are required. The current deployment is frontend-only:
Astro prerenders the catalog to `dist/`, and Vercel serves those static files. Former
API, admin, account, Stripe, PostHog, database, submission, sponsor, challenge, and
community-build routes are preserved under `src/backend-disabled/` but are not built.

## Stack

- [Astro](https://astro.build) static output — every route is prerendered HTML
- Vanilla JS + CSS for local interactions; no client framework and no API calls
- [satori](https://github.com/vercel/satori) + resvg for build-time OG images

## Deploy

Import the repository into Vercel. `vercel.json` runs `npm run build` and publishes
`dist/`; no functions, database, Stripe, PostHog, secrets, or environment variables
are required.

## License

[MIT](LICENSE). The prompts are free forever — paywalling them would be brand poison.
Original copyright Rob Hallam; modifications Faizan Ali.
