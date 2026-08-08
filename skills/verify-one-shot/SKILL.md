---
name: verify-one-shot
description: Execute a Can I Vibecode It? build prompt in a disposable workspace, test the resulting implementation, capture reproducible evidence, and propose verifiedOneShot true only when the evidence passes. Use when asked to verify a catalogue claim or proof-build an entry.
---

# Verify a one-shot build

## Goal

Turn an editorial buildability claim into reproducible evidence. Verification is execution, not model judgement.

## Workflow

1. Record the source entry slug, prompt text, prompt hash, agent/model, date, operating system, runtime versions, and starting workspace state.
2. Create a clean disposable directory or repository. Do not run against personal files or credentials.
3. Supply only documented environment variables and test credentials. Never expose production secrets.
4. Run the prompt once without silently rewriting it mid-run.
5. Record elapsed time, agent interventions, tool failures, and any manual edits.
6. Install dependencies and run all documented checks.
7. Exercise the primary user flow, persistence, restart behavior, and the most important failure path.
8. Capture a proof repository or immutable artifact containing:
   - generated source;
   - README and run instructions;
   - tests and results;
   - screenshots where the product is visual;
   - verification metadata;
   - known failures and deviations.
9. Pass only when the resulting product provides the claimed personal core loop and can be reproduced from the evidence.
10. When it passes, add the proof repository to `priorArt` or the repository's designated proof field and propose `verifiedOneShot: true`.
11. When it fails, keep `verifiedOneShot: false`; improve the prompt or revisit the verdict in a separate, explicitly justified change.
12. Run catalogue validation and build, then open a draft PR.

## Non-negotiable rules

- No verification by screenshots alone.
- No hidden manual implementation presented as a one-shot result.
- No changing the prompt and pretending the original passed.
- No production credentials or private user data in the proof repository.
