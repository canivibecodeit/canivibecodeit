---
name: add-app
description: Add or update a Can I Vibecode It? catalogue entry, validate the repository, commit the change on a dedicated branch, and open a draft pull request. Use when the user asks to contribute an assessment, add an app, or raise a PR.
---

# Add an app

## Goal

Turn an assessment into a minimal, reviewable repository contribution. One app per pull request.

## Prerequisite

Run `can-i-vibecode-it` first unless a complete, evidence-backed entry already exists in the conversation or worktree.

## Workflow

1. Confirm the repository root and inspect `git status -sb`.
2. Read `CONTRIBUTING.md`, the current schema implementation, and one recent high-quality app entry.
3. Search for the slug, canonical domain, aliases, and product name to prevent duplicates.
4. If the entry exists, update it rather than creating a second file.
5. Write `data/apps/<slug>.json` with stable formatting matching nearby entries.
6. Add `public/icons/<slug>.png` only from a permitted source and in the repository's required dimensions. Do not fabricate a trademark.
7. Confirm:
   - filename equals `slug`;
   - category is valid;
   - moat tags use approved values;
   - prompt is 15-30 lines;
   - pricing has source and checked date;
   - `verifiedOneShot` remains false unless execution proof exists;
   - `promptCurated` truthfully describes the prompt.
8. Run:

```sh
npm install
npm run validate
npm run build
```

Use the repository's package-manager lockfile and documented commands if they differ.

9. Create branch `agent/add-<slug>` or `agent/update-<slug>`.
10. Stage only the app JSON, icon, and directly required supporting changes.
11. Commit using `feat(apps): add <Product>` or `feat(apps): update <Product>`.
12. Push the branch and open a **draft** pull request.
13. Never auto-merge. Human editorial review is mandatory.

## Pull request body

Use `skills/templates/app-pr.md`. Include the requesting source when one exists, evidence reviewed, key assumptions, validation results, and explicit unchecked boxes for editorial and one-shot verification.

## Failure handling

- If validation fails, fix the entry before publishing.
- If the build fails for a pre-existing unrelated problem, report it precisely and keep the PR draft.
- If GitHub write access is unavailable, create a patch or archive and identify the exact permission missing. Do not claim a PR was opened.
