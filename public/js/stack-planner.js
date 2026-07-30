/* Pure My Stack calculations and deterministic roadmap generation. */
(() => {
  const EFFORT_ORDER = {
    'one sitting': 0,
    weekend: 1,
    'multi-day': 2,
    'not realistically solo': 3,
  };
  const VERDICT_ORDER = { yes: 0, kinda: 1, no: 2 };
  const STATUS_ORDER = { targeted: 0, building: 0, replaced: 1, keeping: 2 };

  const numericPrice = (item) =>
    typeof item.priceMonthly === 'number' && Number.isFinite(item.priceMonthly);

  const sumPrices = (items) =>
    items.reduce((sum, item) => sum + (numericPrice(item) ? item.priceMonthly : 0), 0);

  const compareItems = (a, b) =>
    (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
    (EFFORT_ORDER[a.diyTimeEstimate] ?? 9) - (EFFORT_ORDER[b.diyTimeEstimate] ?? 9) ||
    (VERDICT_ORDER[a.verdict] ?? 9) - (VERDICT_ORDER[b.verdict] ?? 9) ||
    (numericPrice(b) ? b.priceMonthly : -1) - (numericPrice(a) ? a.priceMonthly : -1) ||
    a.name.localeCompare(b.name);

  const hydrate = (state, apps) => {
    const bySlug = new Map(apps.map((app) => [app.slug, app]));
    return (state?.items || [])
      .map((saved) => {
        const app = bySlug.get(saved.slug);
        return app ? { ...app, ...saved } : null;
      })
      .filter(Boolean);
  };

  const calculate = (items) => {
    const selected = items;
    const live = items.filter((item) => item.status !== 'replaced');
    const actionable = items.filter(
      (item) => item.status === 'targeted' || item.status === 'building'
    );
    const realised = items.filter((item) => item.status === 'replaced');
    const probablyKeep = live.filter(
      (item) => item.status === 'keeping' || item.verdict === 'no'
    );
    const counts = {
      total: items.length,
      targeted: items.filter((item) => item.status === 'targeted').length,
      building: items.filter((item) => item.status === 'building').length,
      replaced: realised.length,
      keeping: items.filter((item) => item.status === 'keeping').length,
    };

    const effort = {
      'one sitting': actionable.filter((item) => item.diyTimeEstimate === 'one sitting').length,
      weekend: actionable.filter((item) => item.diyTimeEstimate === 'weekend').length,
      'multi-day': actionable.filter((item) => item.diyTimeEstimate === 'multi-day').length,
      'not realistically solo': actionable.filter(
        (item) => item.diyTimeEstimate === 'not realistically solo'
      ).length,
    };

    return {
      originalMonthly: sumPrices(selected),
      originalAnnual: sumPrices(selected) * 12,
      remainingMonthly: sumPrices(live),
      realisedMonthly: sumPrices(realised),
      realisedAnnual: sumPrices(realised) * 12,
      immediateMonthly: sumPrices(actionable.filter((item) => item.verdict === 'yes')),
      conditionalMonthly: sumPrices(actionable.filter((item) => item.verdict === 'kinda')),
      probablyKeepMonthly: sumPrices(probablyKeep),
      variableCount: selected.filter((item) => !numericPrice(item)).length,
      counts,
      effort,
    };
  };

  const reasonFor = (item, phase) => {
    if (item.status === 'keeping') return 'USER CHOSE TO KEEP';
    if (item.diyTimeEstimate === 'not realistically solo') return 'NOT REALISTICALLY SOLO';
    if (item.verdict === 'no') {
      return /network|data/i.test(item.moatType || '') ? 'NETWORK/DATA MOAT' : 'THE MOAT SURVIVES';
    }
    if (phase === 'quick') return 'ONE-SITTING WIN';
    if (phase === 'weekend') {
      return item.verdict === 'kinda' ? 'REAL GAPS REMAIN' : 'WEEKEND BUILD';
    }
    if (item.diyTimeEstimate === 'multi-day') return 'MULTI-DAY PROJECT';
    return 'REAL GAPS REMAIN';
  };

  const buildRoadmap = (items) => {
    const sorted = [...items].sort(compareItems);
    const missionComplete = sorted.filter((item) => item.status === 'replaced');
    const active = sorted.filter((item) => item.status === 'building');
    const untouched = sorted.filter((item) => item.status === 'targeted');

    const probablyKeep = sorted.filter(
      (item) =>
        item.status !== 'replaced' &&
        item.status !== 'keeping' &&
        (item.verdict === 'no' || item.diyTimeEstimate === 'not realistically solo')
    );
    const eligible = untouched.filter((item) => !probablyKeep.includes(item));
    const quick = eligible.filter(
      (item) => item.verdict === 'yes' && item.diyTimeEstimate === 'one sitting'
    );
    const weekend = eligible.filter(
      (item) =>
        (item.verdict === 'yes' && item.diyTimeEstimate === 'weekend') ||
        (item.verdict === 'kinda' &&
          (item.diyTimeEstimate === 'one sitting' || item.diyTimeEstimate === 'weekend'))
    );
    const longer = eligible.filter(
      (item) => !quick.includes(item) && !weekend.includes(item)
    );
    const keeping = sorted.filter((item) => item.status === 'keeping');
    const keep = [...probablyKeep, ...keeping].sort(compareItems);

    const phases = [
      {
        id: 'quick',
        title: 'PHASE 1 // QUICK WINS',
        description: 'The best subscriptions to attack first: high confidence and low effort.',
        items: quick,
      },
      {
        id: 'weekend',
        title: 'PHASE 2 // WEEKEND MISSIONS',
        description:
          'Actionable builds with more moving parts. KINDA targets will involve real compromises.',
        items: weekend,
      },
      {
        id: 'longer',
        title: 'PHASE 3 // LONGER BUILDS + CAREFUL DECISIONS',
        description:
          'Meaningful projects where polish, integrations, sync, or collaboration may still justify the original.',
        items: longer,
      },
    ];

    const actionableOrder = [...active, ...phases.flatMap((phase) => phase.items)];
    const recommendation =
      phases.flatMap((phase) => phase.items)[0] || active[0] || null;

    return {
      missionComplete,
      active,
      phases,
      keep,
      actionableOrder,
      recommendation,
      reasonFor,
    };
  };

  window.StackPlannerLogic = {
    hydrate,
    calculate,
    buildRoadmap,
    compareItems,
    numericPrice,
    sumPrices,
  };
})();
