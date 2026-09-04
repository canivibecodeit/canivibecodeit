/* The build sequence for an app, derived from its prompt.

   Phased prompts (the format is specified in CONTRIBUTING.md) carry their own
   sequence as "### Phase N · Title" sections, each with a Build block, a
   falsifiable "Done when" check, and often a "Do not build yet" boundary. Those
   sections are the steps. Prompts not yet converted fall back to the generic
   delivery order below, which is the same list BUILD_PLAN.md renders, defined
   once here so the two can never drift. */

export const DELIVERY_ORDER = [
  {
    title: 'Scaffold the smallest runnable application and document its commands.',
    doneWhen: 'The project starts from a documented command in a clean checkout.',
  },
  {
    title: 'Implement the primary data model and core workflow.',
    doneWhen: 'The main object can be created, read and changed end to end.',
  },
  {
    title: 'Add validation, safe failure states, and persistence.',
    doneWhen: 'Bad input is refused with a readable message and nothing is left corrupted.',
  },
  {
    title: 'Cover the critical path with automated tests.',
    doneWhen: 'The highest-risk behavior fails the suite when it breaks.',
  },
  {
    title: 'Exercise a clean install from the README and fix every missing step.',
    doneWhen: 'A fresh clone reaches the first successful workflow using only the README.',
  },
];

const collapse = (text) => (text || '').replace(/\s+/g, ' ').trim();

export function parsePhases(prompt) {
  if (typeof prompt !== 'string' || !prompt) return [];
  return prompt
    .split(/\n(?=### )/)
    .filter((block) => /^### Phase /.test(block.trim()))
    .map((block) => {
      const lines = block.trim().split('\n');
      const head = lines.shift();
      const body = lines.join('\n');
      const parts = head.match(/^### Phase\s+([^·]+?)\s*·\s*(.+)$/);
      /* Split rather than match: a lookahead anchored with /m would stop a lazy
         capture at the first line break, truncating multi-line checks. */
      const section = (from, until) => {
        const after = body.split(from)[1];
        if (!after) return '';
        return (until ? after.split(until)[0] : after).trim();
      };
      const build = section(/^Build:\s*/m, /\nDone when/);
      return {
        label: parts ? parts[1].trim() : '',
        title: parts ? parts[2].trim() : head.replace(/^###\s*/, ''),
        // Raw keeps the bullet lists and code spans readable; the lead
        // paragraph alone is enough wherever there is no room for the rest.
        build,
        buildLead: collapse(build.split(/\n\s*\n/)[0]),
        doneWhen: collapse(section(/^Done when:?\s*/m, /\nDo not build yet/)),
        notYet: collapse(section(/^Do not build yet:?\s*/m)),
      };
    });
}

/* Sections a phased prompt carries around its phases. Worth surfacing on the
   build page: the stack decision and the data model are the two things that are
   painful to change once the phases are underway. */
export function promptSection(prompt, heading) {
  if (typeof prompt !== 'string' || !prompt) return null;
  const block = prompt
    .split(/\n(?=### )/)
    .find((b) => b.trim().toLowerCase().startsWith(`### ${heading.toLowerCase()}`));
  if (!block) return null;
  const lines = block.trim().split('\n');
  const title = lines.shift().replace(/^###\s*/, '');
  const body = lines.join('\n').trim();
  return body ? { title, body } : null;
}

/* One shape for both cases so callers never branch on it. `phased` says whether
   these are the app's real modules or the generic fallback, which is the only
   thing the UI needs to word differently. */
export function buildSteps(app) {
  if (!app?.prompt) return { phased: false, steps: [] };
  const phases = parsePhases(app.prompt);
  if (phases.length) {
    return {
      phased: true,
      steps: phases.map((phase, i) => ({
        n: phase.label || String(i + 1),
        title: phase.title,
        build: phase.build,
        buildLead: phase.buildLead,
        doneWhen: phase.doneWhen,
        notYet: phase.notYet,
      })),
    };
  }
  return {
    phased: false,
    steps: DELIVERY_ORDER.map((step, i) => ({
      n: String(i + 1),
      title: step.title,
      build: '',
      buildLead: '',
      doneWhen: step.doneWhen,
      notYet: '',
    })),
  };
}
