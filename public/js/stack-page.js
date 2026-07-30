/* /stack mission-control rendering and interactions. */
(() => {
  const root = document.querySelector('#stack-mission-control');
  if (!root) return;

  const apps = (() => {
    try {
      return JSON.parse(document.querySelector('#stack-app-data')?.textContent || '[]');
    } catch {
      return [];
    }
  })();
  const appsBySlug = new Map(apps.map((app) => [app.slug, app]));
  const esc = (value) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  const usd = (value) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 2,
    }).format(value);
  const monthly = (item) =>
    window.StackPlannerLogic.numericPrice(item) ? `${usd(item.priceMonthly)}/mo` : 'varies';
  const annual = (item) =>
    window.StackPlannerLogic.numericPrice(item) ? `${usd(item.priceMonthly * 12)}/year` : null;
  const compromise = (item) =>
    item.whatYouLose?.[0] || item.verdictSummary || 'The original product may still have useful polish.';
  const statusLabel = (status) =>
    ({ targeted: 'TARGETED', building: 'BUILDING', replaced: 'REPLACED', keeping: 'KEEPING' })[
      status
    ] || status;
  const civci = () => window.CanIVibecodeIt || {};

  let currentItems = [];
  let currentRoadmap = null;
  let currentMetrics = null;

  const storageMessage = () => {
    const note = document.querySelector('[data-stack-storage-note]');
    if (!note || !window.MyStack) return;
    const issue = window.MyStack.getIssue();
    const available = window.MyStack.isAvailable();
    if (!available) {
      note.hidden = false;
      note.textContent =
        'LOCAL STORAGE UNAVAILABLE · changes work for this page, but cannot survive a reload.';
    } else if (issue === 'malformed' || issue === 'unknown-version') {
      note.hidden = false;
      note.textContent =
        'MISSION FILE COULD NOT BE READ · an empty, safe stack is shown instead.';
    } else if (issue === 'discarded-items') {
      note.hidden = false;
      note.textContent =
        'MISSION FILE REPAIRED · unavailable apps or invalid entries were removed.';
    } else {
      note.hidden = true;
      note.textContent = '';
    }
  };

  const statusControl = (item) => `
    <div class="stack-status-control">
      <label class="microlabel" for="stack-status-${esc(item.slug)}">STATUS</label>
      <select id="stack-status-${esc(item.slug)}" data-stack-status data-slug="${esc(item.slug)}">
        ${['targeted', 'building', 'replaced', 'keeping']
          .map(
            (status) =>
              `<option value="${status}"${item.status === status ? ' selected' : ''}>${statusLabel(
                status
              )}</option>`
          )
          .join('')}
      </select>
      <button class="stack-remove" type="button" data-stack-remove="${esc(
        item.slug
      )}" aria-label="Remove ${esc(item.name)} from My Stack">REMOVE</button>
    </div>`;

  const promptActions = (item, recommended = false) => {
    if (!item.prompt) {
      return `<p class="stack-no-prompt">NO CURATED PROMPT AVAILABLE · view the honest build plan.</p>`;
    }
    return `
      <div class="stack-prompt-actions" role="group" aria-label="Build actions for ${esc(item.name)}">
        <a class="stack-action" href="/${esc(item.slug)}#build-plan">${
          recommended ? 'VIEW BUILD PLAN' : 'VIEW PROMPT'
        }</a>
        <button class="stack-action" type="button" data-copy-prompt="${esc(
          item.slug
        )}">COPY PROMPT</button>
        <button class="stack-action" type="button" data-launch-agent="cursor" data-slug="${esc(
          item.slug
        )}">OPEN IN CURSOR</button>
        <button class="stack-action" type="button" data-launch-agent="codex" data-slug="${esc(
          item.slug
        )}">OPEN IN CODEX</button>
        <button class="stack-action" type="button" data-launch-agent="claude-code" data-slug="${esc(
          item.slug
        )}">OPEN IN CLAUDE CODE</button>
      </div>`;
  };

  const itemCard = (item, phaseId, actionable = false) => {
    const reason = currentRoadmap.reasonFor(item, phaseId);
    const annualPrice = annual(item);
    return `
      <article class="stack-item" data-roadmap-item="${esc(item.slug)}">
        <div class="stack-item-main">
          <div class="stack-item-title">
            <img src="/icons/${esc(item.slug)}.png" width="38" height="38" alt="">
            <div>
              <h3><a href="/${esc(item.slug)}">${esc(item.name)}</a></h3>
              <p>${esc(item.categoryEmoji)} ${esc(item.categoryLabel)} · ${esc(
                monthly(item)
              )}${annualPrice ? ` · ${esc(annualPrice)}` : ''}</p>
            </div>
          </div>
          <div class="stack-item-badges">
            <span class="badge ${esc(item.verdict)}">${esc(item.verdictLabel)}</span>
            <span class="status-badge status-${esc(item.status)}">${esc(
              statusLabel(item.status)
            )}</span>
          </div>
        </div>
        <div class="stack-item-brief">
          <span class="roadmap-reason">${esc(reason)}</span>
          <span>${esc(item.diyTimeEstimate)}</span>
          <p><b>PRINCIPAL COMPROMISE:</b> ${esc(compromise(item))}</p>
        </div>
        ${actionable ? promptActions(item) : ''}
        ${statusControl(item)}
      </article>`;
  };

  const phaseSection = (phase) => {
    if (!phase.items.length) return '';
    return `
      <section class="roadmap-phase" aria-labelledby="phase-${esc(phase.id)}">
        <div class="roadmap-phase-head">
          <span class="phase-index">${String(phase.items.length).padStart(2, '0')}</span>
          <div>
            <h2 id="phase-${esc(phase.id)}">${esc(phase.title)}</h2>
            <p>${esc(phase.description)}</p>
          </div>
        </div>
        <div class="stack-item-list">
          ${phase.items.map((item) => itemCard(item, phase.id, true)).join('')}
        </div>
      </section>`;
  };

  const metric = (label, value, note, tone = '') => `
    <article class="stack-metric ${tone}">
      <span class="microlabel">${esc(label)}</span>
      <strong>${esc(value)}</strong>
      <p>${esc(note)}</p>
    </article>`;

  const effortCopy = (metrics) => {
    const labels = {
      'one sitting': ['one-sitting build', 'one-sitting builds'],
      weekend: ['weekend mission', 'weekend missions'],
      'multi-day': ['multi-day project', 'multi-day projects'],
      'not realistically solo': ['not realistically solo', 'not realistically solo'],
    };
    const parts = Object.entries(metrics.effort)
      .filter(([, count]) => count > 0)
      .map(([key, count]) => `${count} ${labels[key][count === 1 ? 0 : 1]}`);
    return parts.length ? parts.join(' · ') : 'No remaining build workload';
  };

  const summarySection = (metrics) => `
    <section class="stack-summary" aria-labelledby="stack-summary-title">
      <div class="section-command">
        <span class="terminal-prompt">&gt;</span>
        <h2 id="stack-summary-title">CURRENT BURN + RECOVERY</h2>
      </div>
      <div class="stack-metrics-grid">
        ${metric(
          'ORIGINAL STACK COST',
          `${usd(metrics.originalMonthly)}/mo`,
          `${usd(metrics.originalAnnual)}/year baseline`
        )}
        ${metric(
          'CURRENT REMAINING SPEND',
          `${usd(metrics.remainingMonthly)}/mo`,
          'Targeted, building, and keeping'
        )}
        ${metric(
          'REALISED SAVINGS',
          `${usd(metrics.realisedMonthly)}/mo`,
          `${usd(metrics.realisedAnnual)}/year avoided`,
          'positive'
        )}
        ${metric(
          'IMMEDIATELY RECOVERABLE · YES',
          `${usd(metrics.immediateMonthly)}/mo`,
          'Targeted or building YES opportunities',
          'positive'
        )}
        ${metric(
          'CONDITIONAL · KINDA',
          `${usd(metrics.conditionalMonthly)}/mo`,
          'Potential only · real compromises remain',
          'conditional'
        )}
        ${metric(
          'PROBABLY KEEP',
          `${usd(metrics.probablyKeepMonthly)}/mo`,
          'NOT REALLY targets and anything you chose to keep'
        )}
      </div>
      <div class="stack-progress-panel">
        <div>
          <span class="microlabel">REPLACEMENT PROGRESS</span>
          <strong>${metrics.counts.replaced} of ${metrics.counts.total} subscriptions eliminated</strong>
          <p>${metrics.counts.targeted} targeted · ${metrics.counts.building} building · ${
            metrics.counts.replaced
          } replaced · ${metrics.counts.keeping} keeping</p>
        </div>
        <div>
          <span class="microlabel">REMAINING BUILD EFFORT</span>
          <strong>${esc(effortCopy(metrics))}</strong>
          <p>Effort bands stay separate. They are not fake hour estimates.</p>
        </div>
      </div>
      ${
        metrics.variableCount
          ? `<p class="variable-note">${metrics.variableCount} variable-price ${
              metrics.variableCount === 1 ? 'product was' : 'products were'
            } excluded from every dollar total because the repository lists the price as “varies”.</p>`
          : ''
      }
    </section>`;

  const recommendationSection = (item) => {
    if (!item) {
      const fullyReplaced = currentMetrics.counts.replaced === currentMetrics.counts.total;
      return `
        <section class="recommendation empty-recommendation">
          <span class="microlabel">${fullyReplaced ? 'MISSION COMPLETE' : 'NO ACTIONABLE TARGET'}</span>
          <h2>${fullyReplaced ? 'EVERY SUBSCRIPTION ELIMINATED' : 'THE MOAT SURVIVES'}</h2>
          <p>${
            fullyReplaced
              ? `${usd(currentMetrics.realisedMonthly)}/mo eliminated · ${usd(
                  currentMetrics.realisedAnnual
                )}/year avoided.`
              : 'Everything remaining is marked KEEPING or is not an honest economic build target.'
          }</p>
        </section>`;
    }
    const reason =
      item.status === 'building'
        ? 'This is already in progress. Resume it before opening another front.'
        : currentRoadmap.reasonFor(
            item,
            currentRoadmap.phases.find((phase) => phase.items.includes(item))?.id || 'longer'
          ) === 'ONE-SITTING WIN'
          ? 'Strong YES verdict, one-sitting effort, and the best recoverable cost among comparable targets.'
          : 'This is the first eligible target after effort, verdict, monthly cost, and name are applied in order.';
    return `
      <section class="recommendation" aria-labelledby="recommended-target-title">
        <span class="microlabel">${
          item.status === 'building' ? 'ACTIVE MISSION' : 'RECOMMENDED NEXT TARGET'
        }</span>
        <div class="recommendation-grid">
          <div class="recommendation-title">
            <img src="/icons/${esc(item.slug)}.png" width="52" height="52" alt="">
            <div>
              <h2 id="recommended-target-title">${esc(item.name)}</h2>
              <p>${esc(monthly(item))}${
                annual(item) ? ` · ${esc(annual(item))}` : ''
              } · ${esc(item.verdictLabel)} · ${esc(item.diyTimeEstimate)}</p>
            </div>
          </div>
          <div class="recommendation-copy">
            <p><b>WHY THIS ONE:</b> ${esc(reason)}</p>
            <p><b>PRINCIPAL COMPROMISE:</b> ${esc(compromise(item))}</p>
          </div>
        </div>
        ${promptActions(item, true)}
      </section>`;
  };

  const roadmapControls = () => {
    const hasActions = currentRoadmap.actionableOrder.some((item) => item.prompt);
    return `
      <div class="roadmap-command-bar">
        <div>
          <span class="microlabel">PROMPT COMMAND CENTRE</span>
          <p>Package the plan or launch the repository’s original curated prompts.</p>
        </div>
        <div class="stack-prompt-actions">
          <button class="stack-action" type="button" data-copy-roadmap${
            currentRoadmap.actionableOrder.length ? '' : ' disabled'
          }>COPY ACTIONABLE ROADMAP</button>
          <button class="stack-action" type="button" data-copy-all-prompts${
            hasActions ? '' : ' disabled'
          }>COPY ALL BUILD PROMPTS</button>
        </div>
      </div>`;
  };

  const roadmapSection = () => `
    <section class="escape-plan" aria-labelledby="escape-plan-title">
      <div class="escape-plan-head">
        <span class="microlabel">DETERMINISTIC · HONEST · LOCAL</span>
        <h2 id="escape-plan-title">YOUR VIBECODING ESCAPE PLAN</h2>
        <p>
          Lower effort comes first, then stronger verdict, higher monthly cost, and app name.
          Conditional savings are never treated as guaranteed.
        </p>
      </div>
      ${roadmapControls()}
      ${recommendationSection(currentRoadmap.recommendation)}
      ${
        currentRoadmap.active.length
          ? `<section class="roadmap-phase active-phase" aria-labelledby="active-mission-title">
              <div class="roadmap-phase-head">
                <span class="phase-index">▶</span>
                <div>
                  <h2 id="active-mission-title">ACTIVE MISSION</h2>
                  <p>Resume the build already underway before starting another.</p>
                </div>
              </div>
              <div class="stack-item-list">
                ${currentRoadmap.active
                  .map((item) => itemCard(item, 'active', true))
                  .join('')}
              </div>
            </section>`
          : ''
      }
      ${
        currentRoadmap.missionComplete.length
          ? `<section class="roadmap-phase mission-complete" aria-labelledby="mission-complete-title">
              <div class="roadmap-phase-head">
                <span class="phase-index">✓</span>
                <div>
                  <h2 id="mission-complete-title">MISSION COMPLETE</h2>
                  <p>${usd(
                    window.StackPlannerLogic.sumPrices(currentRoadmap.missionComplete)
                  )}/mo eliminated · ${usd(
                    window.StackPlannerLogic.sumPrices(currentRoadmap.missionComplete) * 12
                  )}/year avoided.</p>
                </div>
              </div>
              <div class="stack-item-list">
                ${currentRoadmap.missionComplete
                  .map((item) => itemCard(item, 'complete', false))
                  .join('')}
              </div>
            </section>`
          : ''
      }
      ${currentRoadmap.phases.map(phaseSection).join('')}
      ${
        currentRoadmap.keep.length
          ? `<section class="roadmap-phase keep-phase" aria-labelledby="probably-keep-title">
              <div class="roadmap-phase-head">
                <span class="phase-index">×</span>
                <div>
                  <h2 id="probably-keep-title">PROBABLY KEEP // THE MOAT SURVIVES</h2>
                  <p>Building these is not the economic win. Keeping a useful product is a valid decision.</p>
                </div>
              </div>
              <div class="stack-item-list">
                ${currentRoadmap.keep
                  .map((item) => itemCard(item, 'keep', false))
                  .join('')}
              </div>
            </section>`
          : ''
      }
    </section>`;

  const emptyState = () => `
    <section class="stack-empty">
      <span class="microlabel">NO TARGETS ACQUIRED</span>
      <h2>YOUR MISSION FILE IS EMPTY</h2>
      <p>
        Add the subscriptions you currently use from the death list. Their prices, verdicts,
        build estimates, compromises, and original prompts stay synced to the repository.
      </p>
      <a class="btn primary" href="/#death-list">BROWSE THE DEATH LIST</a>
    </section>`;

  const render = (state, announcement = '') => {
    if (!window.StackPlannerLogic) return;
    currentItems = window.StackPlannerLogic.hydrate(state, apps);
    currentMetrics = window.StackPlannerLogic.calculate(currentItems);
    currentRoadmap = window.StackPlannerLogic.buildRoadmap(currentItems);

    const title = document.querySelector('[data-stack-page-title]');
    if (title) {
      title.textContent = `YOUR STACK // ${currentMetrics.counts.total} ${
        currentMetrics.counts.total === 1 ? 'TARGET' : 'TARGETS'
      }`;
    }
    storageMessage();
    root.innerHTML = currentItems.length
      ? `${summarySection(currentMetrics)}${roadmapSection()}`
      : emptyState();
    window.MyStack?.refreshControls();
    const live = document.querySelector('[data-stack-live]');
    if (live && announcement) live.textContent = announcement;
  };

  const phaseFor = (item) => {
    if (currentRoadmap.active.includes(item)) return 'ACTIVE MISSION';
    const phase = currentRoadmap.phases.find((entry) => entry.items.includes(item));
    return phase?.title || 'ACTIONABLE';
  };

  const roadmapText = () => {
    const sections = [];
    if (currentRoadmap.active.length) {
      sections.push(['ACTIVE MISSION', currentRoadmap.active]);
    }
    currentRoadmap.phases.forEach((phase) => {
      if (phase.items.length) sections.push([phase.title, phase.items]);
    });
    return [
      'YOUR VIBECODING ESCAPE PLAN',
      '',
      ...sections.flatMap(([title, items]) => [
        title,
        ...items.flatMap((item) => [
          `${item.name} · ${monthly(item)} · ${item.verdictLabel} · ${item.diyTimeEstimate}`,
          `What you lose: ${compromise(item)}`,
          `${location.origin}/${item.slug}`,
          '',
        ]),
      ]),
    ].join('\n').trim();
  };

  const allPromptsText = () =>
    currentRoadmap.actionableOrder
      .filter((item) => item.prompt)
      .map(
        (item) =>
          `${phaseFor(item)}\n${item.name.toUpperCase()} · ${monthly(item)} · ${
            item.verdictLabel
          } · ${item.diyTimeEstimate}\n${location.origin}/${item.slug}\n\n${item.prompt}`
      )
      .join('\n\n========================================\n\n');

  const copyWithFeedback = async (button, text, success) => {
    const ok = await civci().copyText?.(text);
    civci().toast?.(ok ? success : 'copy failed · select the text manually');
    if (!ok) return;
    const original = button.textContent;
    button.textContent = 'COPIED ✓';
    window.setTimeout(() => {
      button.textContent = original;
    }, 1800);
  };

  root.addEventListener('change', (event) => {
    const select = event.target.closest('[data-stack-status]');
    if (!select) return;
    const item = appsBySlug.get(select.dataset.slug);
    const status = select.value;
    if (!item || !window.MyStack?.setStatus(item.slug, status)) return;

    let message = `${item.name} marked ${status}`;
    if (status === 'building') message = `MISSION STARTED · ${item.name}`;
    if (status === 'replaced') {
      message =
        typeof item.priceMonthly === 'number'
          ? `SUBSCRIPTION ELIMINATED · ${usd(item.priceMonthly)}/mo removed · ${usd(
              item.priceMonthly * 12
            )}/year avoided`
          : `SUBSCRIPTION ELIMINATED · ${item.name} removed · variable price`;
    }
    if (status === 'keeping') message = `TARGET WITHDRAWN · KEEPING ${item.name}`;
    civci().toast?.(message);
    civci().track?.('stack_status', { app: item.slug, status });
  });

  root.addEventListener('click', async (event) => {
    const remove = event.target.closest('[data-stack-remove]');
    if (remove) {
      const item = appsBySlug.get(remove.dataset.stackRemove);
      if (item && window.MyStack?.remove(item.slug)) {
        civci().toast?.(`${item.name} removed from your stack`);
        civci().track?.('stack_remove', { app: item.slug, source: 'stack_page' });
      }
      return;
    }

    const copyPrompt = event.target.closest('[data-copy-prompt]');
    if (copyPrompt) {
      const item = appsBySlug.get(copyPrompt.dataset.copyPrompt);
      if (item) {
        await copyWithFeedback(
          copyPrompt,
          item.prompt,
          `prompt copied · ${item.name} is ready to build`
        );
        civci().track?.('copy_prompt', { app: item.slug, agent: 'raw', source: 'stack' });
      }
      return;
    }

    const launch = event.target.closest('[data-launch-agent]');
    if (launch) {
      const item = appsBySlug.get(launch.dataset.slug);
      if (item) {
        civci().launchAgent?.(launch.dataset.launchAgent, item.prompt);
        civci().track?.('copy_prompt', {
          app: item.slug,
          agent: launch.dataset.launchAgent,
          source: 'stack',
        });
      }
      return;
    }

    const copyRoadmap = event.target.closest('[data-copy-roadmap]');
    if (copyRoadmap) {
      await copyWithFeedback(copyRoadmap, roadmapText(), 'actionable roadmap copied');
      civci().track?.('stack_copy_roadmap');
      return;
    }

    const copyAll = event.target.closest('[data-copy-all-prompts]');
    if (copyAll) {
      await copyWithFeedback(copyAll, allPromptsText(), 'all build prompts copied');
      civci().track?.('stack_copy_all_prompts');
    }
  });

  document.addEventListener('stack:ready', (event) => render(event.detail.state));
  document.addEventListener('stack:changed', (event) => {
    const name = appsBySlug.get(event.detail.slug)?.name || 'Stack';
    const announcement =
      event.detail.action === 'status'
        ? `${name} status updated. Savings and roadmap recalculated.`
        : `${name} updated. Stack totals and roadmap recalculated.`;
    render(event.detail.state, announcement);
  });

  if (window.MyStack) render(window.MyStack.getState());
})();
