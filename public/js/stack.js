/* My Stack: versioned local storage and site-wide controls. */
(() => {
  const STORAGE_KEY = 'canivibecodeit:my-stack';
  const VERSION = 1;
  const STATUSES = new Set(['targeted', 'building', 'replaced', 'keeping']);
  const civci = () => window.CanIVibecodeIt || {};

  const validSlugs = (() => {
    try {
      return new Set(JSON.parse(document.querySelector('#stack-valid-slugs')?.textContent || '[]'));
    } catch {
      return new Set();
    }
  })();

  let available = true;
  let issue = null;

  const emptyState = () => ({ version: VERSION, items: [] });

  const sanitise = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { state: emptyState(), issue: 'malformed' };
    }
    if (value.version !== VERSION) {
      return { state: emptyState(), issue: 'unknown-version' };
    }
    if (!Array.isArray(value.items)) {
      return { state: emptyState(), issue: 'malformed' };
    }

    const seen = new Set();
    const items = [];
    let discarded = 0;

    for (const item of value.items) {
      const valid =
        item &&
        typeof item === 'object' &&
        typeof item.slug === 'string' &&
        validSlugs.has(item.slug) &&
        STATUSES.has(item.status) &&
        !seen.has(item.slug);

      if (!valid) {
        discarded += 1;
        continue;
      }

      seen.add(item.slug);
      const clean = { slug: item.slug, status: item.status };
      if (typeof item.addedAt === 'string') clean.addedAt = item.addedAt;
      if (typeof item.statusUpdatedAt === 'string') clean.statusUpdatedAt = item.statusUpdatedAt;
      items.push(clean);
    }

    return {
      state: { version: VERSION, items },
      issue: discarded ? 'discarded-items' : null,
    };
  };

  const read = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return emptyState();
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        issue = 'malformed';
        return emptyState();
      }
      const result = sanitise(parsed);
      issue = result.issue;
      if (result.issue === 'discarded-items') {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(result.state));
        } catch {
          available = false;
        }
      }
      return result.state;
    } catch {
      available = false;
      issue = 'unavailable';
      return emptyState();
    }
  };

  let state = read();

  const snapshot = () => ({
    version: VERSION,
    items: state.items.map((item) => ({ ...item })),
  });

  const announceStorageFallback = () => {
    if (!available) {
      civci().toast?.('local storage unavailable · changes last for this page only');
    }
  };

  const renderControls = (addedSlug = null) => {
    const selected = new Set(state.items.map((item) => item.slug));

    document.querySelectorAll('[data-stack-toggle]').forEach((button) => {
      const inStack = selected.has(button.dataset.stackSlug);
      const name = button.dataset.stackName || 'this app';
      const label = button.querySelector('[data-stack-toggle-label]');
      button.classList.toggle('selected', inStack);
      button.setAttribute('aria-pressed', String(inStack));
      button.setAttribute(
        'aria-label',
        inStack ? `Remove ${name} from My Stack` : `Add ${name} to My Stack`
      );
      if (label) label.textContent = inStack ? '✓ IN MY STACK' : '+ ADD TO STACK';
    });

    document.querySelectorAll('[data-stack-count]').forEach((el) => {
      el.textContent = String(state.items.length);
    });
    document.querySelectorAll('[data-stack-nav]').forEach((link) => {
      link.setAttribute(
        'aria-label',
        `My Stack, ${state.items.length} ${
          state.items.length === 1 ? 'subscription' : 'subscriptions'
        }`
      );
      if (addedSlug) {
        link.classList.remove('acknowledge');
        void link.offsetWidth;
        link.classList.add('acknowledge');
        window.setTimeout(() => link.classList.remove('acknowledge'), 900);
      }
    });
  };

  const emit = (action, slug) => {
    renderControls(action === 'added' ? slug : null);
    document.dispatchEvent(
      new CustomEvent('stack:changed', {
        detail: {
          state: snapshot(),
          available,
          issue,
          action,
          slug,
        },
      })
    );
  };

  const persist = (next, action, slug) => {
    state = next;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      available = true;
      issue = null;
    } catch {
      available = false;
      issue = 'unavailable';
    }
    emit(action, slug);
    announceStorageFallback();
  };

  const add = (slug) => {
    if (!validSlugs.has(slug) || state.items.some((item) => item.slug === slug)) return false;
    persist(
      {
        version: VERSION,
        items: [
          ...state.items,
          { slug, status: 'targeted', addedAt: new Date().toISOString() },
        ],
      },
      'added',
      slug
    );
    return true;
  };

  const remove = (slug) => {
    if (!state.items.some((item) => item.slug === slug)) return false;
    persist(
      { version: VERSION, items: state.items.filter((item) => item.slug !== slug) },
      'removed',
      slug
    );
    return true;
  };

  const toggle = (slug) =>
    state.items.some((item) => item.slug === slug) ? remove(slug) : add(slug);

  const setStatus = (slug, status) => {
    if (!STATUSES.has(status)) return false;
    let changed = false;
    const items = state.items.map((item) => {
      if (item.slug !== slug || item.status === status) return item;
      changed = true;
      return { ...item, status, statusUpdatedAt: new Date().toISOString() };
    });
    if (!changed) return false;
    persist({ version: VERSION, items }, 'status', slug);
    return true;
  };

  // Keep the personal replacement state in lockstep with the public
  // "I replaced this" action. A first-time vote acquires the target as already
  // replaced; taking the vote back returns only replaced items to TARGETED.
  const setReplacement = (slug, replaced) => {
    if (!validSlugs.has(slug)) return false;
    const existing = state.items.find((item) => item.slug === slug);
    const now = new Date().toISOString();

    if (replaced) {
      if (existing?.status === 'replaced') return false;
      if (!existing) {
        persist(
          {
            version: VERSION,
            items: [
              ...state.items,
              { slug, status: 'replaced', addedAt: now, statusUpdatedAt: now },
            ],
          },
          'added',
          slug
        );
        return true;
      }
      persist(
        {
          version: VERSION,
          items: state.items.map((item) =>
            item.slug === slug ? { ...item, status: 'replaced', statusUpdatedAt: now } : item
          ),
        },
        'status',
        slug
      );
      return true;
    }

    if (existing?.status !== 'replaced') return false;
    persist(
      {
        version: VERSION,
        items: state.items.map((item) =>
          item.slug === slug ? { ...item, status: 'targeted', statusUpdatedAt: now } : item
        ),
      },
      'status',
      slug
    );
    return true;
  };

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-stack-toggle]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const slug = button.dataset.stackSlug;
    const name = button.dataset.stackName || 'subscription';
    const wasSelected = state.items.some((item) => item.slug === slug);
    if (!toggle(slug)) return;
    civci().toast?.(
      wasSelected ? `${name} removed from your stack` : `target acquired · ${name} added`
    );
    civci().track?.(wasSelected ? 'stack_remove' : 'stack_add', { app: slug });
  });

  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    state = read();
    emit('synced', null);
  });

  window.MyStack = {
    key: STORAGE_KEY,
    version: VERSION,
    statuses: [...STATUSES],
    getState: snapshot,
    isAvailable: () => available,
    getIssue: () => issue,
    add,
    remove,
    toggle,
    setStatus,
    setReplacement,
    refreshControls: renderControls,
  };

  renderControls();
  document.dispatchEvent(
    new CustomEvent('stack:ready', {
      detail: { state: snapshot(), available, issue },
    })
  );
})();
