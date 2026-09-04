/* Vibecode It? — interactions. No frameworks, on purpose. */
(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

  const track = (event, props) => window.posthog?.capture(event, props);

  /* ClientRouter swaps the page DOM instead of reloading (so the header radio
     keeps playing across navigations). Everything that wires per-page elements
     lives in initPage(), re-run on every astro:page-load; anything bound to
     document/window or a timer registers a cleanup here so navigations don't
     stack duplicates. */
  let cleanups = [];
  let inited = false;
  const onLeave = (fn) => cleanups.push(fn);
  document.addEventListener('astro:before-swap', () => {
    cleanups.forEach((fn) => fn());
    cleanups = [];
    inited = false; // re-arm boot() for the incoming page
  });

  /* Coming back from Stripe with the back button restores this page from the
     bfcache exactly as it was left — mid-submit, so the card would sit on
     "opening checkout…" forever. Put every checkout card back how it started.
     (Global, not per-page: bfcache restores only happen on real loads.) */
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    $$('form[data-checkout]').forEach((form) => {
      delete form.dataset.loading;
      const btn = $('button', form);
      if (!btn) return;
      btn.disabled = false;
      btn.classList.remove('is-loading');
      const label = $('.sp-cta', btn) || $('.sp-tag', btn) || btn;
      if (label.dataset.spLabel !== undefined) label.textContent = label.dataset.spLabel;
    });
  });

  const initPage = () => {
    /* one controller per page visit: aborted via onLeave when the page swaps */
    const page = new AbortController();
    onLeave(() => page.abort());

    /* ---------- external links open in a new tab ---------- */
    $$('a[href]').forEach((a) => {
      if (/^https?:/.test(a.href) && a.hostname !== location.hostname) {
        a.target = '_blank';
        // Append rather than assign: sponsor cards ship rel="sponsored", and
        // dropping that turns a paid link into an SEO problem.
        if (!a.rel.includes('noopener')) a.rel = `${a.rel} noopener`.trim();
      }
    });

    /* ---------- toast ---------- */
    let toastTimer;
    const toast = (msg) => {
      const el = $('#toast');
      if (!el) return;
      el.textContent = msg;
      el.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
    };

    /* ---------- theme toggle ---------- */
    $('[data-toggle-theme]')?.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('theme', next);
      // keep browser chrome in step; values mirror --bg (and THEME_SCRIPT)
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = next === 'light' ? '#f7f8f9' : '#0b0d0b';
      track('theme_toggle', { theme: next });
    });

    /* ---------- search filter + category dropdown ---------- */
    const search = $('#search');
    const rows = $$('#rows .row, #rows-rest .row');
    let activeCat = '';
    let activeVerdict = '';

    // The live globe rides after the 10th VISIBLE row. A fixed DOM slot means
    // a filtered list can render the globe before its first matching entry.
    const placeGlobe = () => {
      const box = $('#rows');
      const globe = $('#globe-strip');
      if (!box || !globe || !box.contains(globe)) return;
      const visible = $$('.row', box).filter((r) => r.style.display !== 'none');
      if (!visible.length) {
        globe.style.display = 'none';
        return;
      }
      globe.style.display = '';
      visible[Math.min(9, visible.length - 1)].after(globe);
    };

    const applyFilter = () => {
      const q = (search?.value || '').trim().toLowerCase();
      let shown = 0;
      rows.forEach((r) => {
        const hit =
          (!q || r.dataset.name.includes(q)) &&
          (!activeCat || r.dataset.category === activeCat) &&
          (!activeVerdict || r.dataset.verdict === activeVerdict);
        r.style.display = hit ? '' : 'none';
        if (hit) shown++;
      });
      const miss = $('#no-results');
      if (miss) miss.classList.toggle('show', shown === 0 && (q.length > 0 || !!activeCat || !!activeVerdict));
      const count = $('#filter-count');
      if (count) count.textContent = shown === rows.length ? '' : `${shown} of ${rows.length}`;
      // Someone mid-search is looking for one app; an ad or a stats panel wedged
      // into the results is just noise. Both come back when the filter clears.
      const filtering = !!q || !!activeCat || !!activeVerdict;
      $$('.sp-banner, #stats-strip').forEach((b) => {
        b.style.display = filtering ? 'none' : '';
      });
      placeGlobe();
    };

    /* ---------- category dropdown (hero, next to search) ---------- */
    const catDD = $('#cat-dd');
    if (catDD && rows.length) {
      const ddBtn = $('#cat-dd-btn');
      const ddPanel = $('#cat-dd-panel');
      const ddLabel = $('#cat-dd-label');
      const ddClose = () => {
        ddPanel.hidden = true;
        ddBtn.setAttribute('aria-expanded', 'false');
      };
      ddBtn.addEventListener('click', () => {
        const opening = ddPanel.hidden;
        ddPanel.hidden = !opening;
        ddBtn.setAttribute('aria-expanded', String(opening));
        if (opening) $('.cat-opt.active', ddPanel)?.scrollIntoView({ block: 'nearest' });
      });
      ddPanel.addEventListener('click', (e) => {
        const link = e.target.closest('a.cat-opt');
        if (link) {
          ddClose();
          return;
        }
        const opt = e.target.closest('button.cat-opt');
        if (!opt) return;
        activeCat = opt.dataset.cat || '';
        $$('button.cat-opt', ddPanel).forEach((o) => {
          o.classList.toggle('active', o === opt);
          o.setAttribute('aria-selected', String(o === opt));
        });
        ddLabel.textContent = opt.dataset.label;
        ddBtn.classList.toggle('filtering', !!activeCat);
        ddClose();
        applyFilter();
        if (activeCat) {
          document.getElementById('death-list')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        track('category_filter', { category: activeCat || 'all' });
      });
      document.addEventListener('click', (e) => {
        if (!catDD.contains(e.target)) ddClose();
      }, { signal: page.signal });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') ddClose();
      }, { signal: page.signal });
    }

    $('#verdict-filter')?.addEventListener('click', (e) => {
      // Verdict chips only: the sort toggle is a .vchip in the same row, and it
      // owns its own active state.
      const chip = e.target.closest('.vchip[data-verdict]');
      if (!chip) return;
      activeVerdict = chip.dataset.verdict || '';
      $$('.vchip[data-verdict]').forEach((c) => c.classList.toggle('active', c === chip));
      applyFilter();
      track('verdict_filter', { verdict: activeVerdict || 'all' });
    });

    /* ---------- team size + sort by spend ----------
       A seat price is a lie at team scale: 12 people on a $14/user tool is $168
       a month, and that is the number worth comparing against a weekend build. */
    const rowsBox = $('#rows');
    const teamInput = $('#team-size');
    const sortBtn = $('#sort-toggle');
    const startOrder = rowsBox ? [...rowsBox.children] : [];
    let sortMode = 'votes';

    const teamSize = () => Math.min(999, Math.max(1, Math.floor(Number(teamInput?.value) || 1)));
    const money = (v) => `$${v.toLocaleString('en-US')}`;
    const priceOf = (r) => (r.dataset.price === '' ? null : Number(r.dataset.price));

    // What N people actually pay per month. Usage and custom pricing can't be
    // multiplied honestly, and neither can "varies" — those sort last.
    const spendOf = (r, n) => {
      const p = priceOf(r);
      if (p == null || Number.isNaN(p)) return -1;
      if (r.dataset.unit === 'per-seat') return p * n;
      if (r.dataset.unit === 'usage' || r.dataset.unit === 'custom') return -1;
      return p;
    };

    const applyTeamSize = () => {
      const n = teamSize();
      rows.forEach((r) => {
        if (r.dataset.unit !== 'per-seat') return;
        const cell = $('.c-price', r);
        const p = priceOf(r);
        if (!cell || p == null || Number.isNaN(p)) return;
        if (cell.dataset.base === undefined) cell.dataset.base = cell.textContent;
        if (n > 1) {
          cell.textContent = `${money(p * n)}/mo`;
          cell.title = `${n} × $${p}/user/mo`;
        } else {
          cell.textContent = cell.dataset.base;
          cell.removeAttribute('title');
        }
      });
    };

    // Sponsor banners keep their slots: only the rows move between them.
    const applySort = () => {
      if (!rowsBox) return;
      let ordered = startOrder;
      if (sortMode === 'spend') {
        const n = teamSize();
        const sorted = startOrder
          .filter((el) => el.classList.contains('row'))
          .sort((a, b) => spendOf(b, n) - spendOf(a, n));
        let i = 0;
        ordered = startOrder.map((el) => (el.classList.contains('row') ? sorted[i++] : el));
      }
      const frag = document.createDocumentFragment();
      ordered.forEach((el) => frag.appendChild(el));
      rowsBox.appendChild(frag);
      // Re-appending startOrder put the globe back at its server-rendered
      // slot; a filtered or re-sorted list wants it after the 10th visible row.
      placeGlobe();
    };

    if (teamInput) {
      applyTeamSize(); // a reload can restore a team size the page didn't render with
      teamInput.addEventListener('input', () => {
        applyTeamSize();
        if (sortMode === 'spend') applySort();
      });
      teamInput.addEventListener('change', () => track('team_size', { size: teamSize() }));
      // The −/+ buttons replace the native spinners; going through the input's
      // own events keeps the price and sort listeners above as the only wiring.
      $$('.team-step').forEach((btn) =>
        btn.addEventListener('click', () => {
          teamInput.value = String(Math.min(999, Math.max(1, teamSize() + Number(btn.dataset.step))));
          teamInput.dispatchEvent(new Event('input'));
          teamInput.dispatchEvent(new Event('change'));
        })
      );
    }

    sortBtn?.addEventListener('click', () => {
      sortMode = sortMode === 'votes' ? 'spend' : 'votes';
      sortBtn.dataset.sort = sortMode;
      sortBtn.textContent = `sort: ${sortMode}`;
      sortBtn.classList.toggle('active', sortMode === 'spend');
      applySort();
      track('list_sort', { sort: sortMode });
    });

    /* Command-palette dropdown: instant results pinned to the search box, so
       nobody has to scroll past the ticker to see what matched. */
    const srBox = $('#search-results');
    const rowData = rows.map((r) => ({
      href: r.getAttribute('href'),
      name: $('.name', r)?.textContent ?? '',
      lower: r.dataset.name,
      verdict: r.dataset.verdict,
      icon: $('img', r)?.getAttribute('src'),
      meta: `${$('.c-cat', r)?.textContent.trim() ?? ''} · ${$('.c-price', r)?.textContent.trim() ?? ''}`,
    }));
    const BADGE = { yes: 'YES', kinda: 'KINDA', no: 'NOT REALLY' };
    let srActive = -1;

    /* Rows are built as DOM nodes, never as an HTML string. The values here
       come back out of the rendered page decoded (getAttribute/textContent),
       so re-parsing them as markup would undo the server's escaping and hand
       an app entry a way to smuggle attributes into this dropdown. */
    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };

    const renderDropdown = (q) => {
      if (!srBox) return;
      srActive = -1;
      const hits = q ? rowData.filter((r) => r.lower.includes(q)) : [];
      if (!hits.length) {
        // Clear the rows, don't just hide them: Enter reads the row list, and a
        // stale row from three keystrokes ago must not swallow the keypress and
        // redirect someone whose full query matches nothing.
        srBox.classList.remove('open');
        srBox.replaceChildren();
        search?.setAttribute('aria-expanded', 'false');
        return;
      }
      const top = hits.slice(0, 6);
      const nodes = top.map((r, i) => {
        const a = el('a', 'sr-row');
        a.setAttribute('role', 'option');
        a.dataset.i = i;
        a.href = r.href;
        const img = el('img', null);
        img.src = r.icon;
        img.alt = '';
        img.width = 20;
        img.height = 20;
        const badge = el('span', 'badge', BADGE[r.verdict] ?? '');
        // Only the three known verdicts get to name a class.
        if (r.verdict in BADGE) badge.classList.add(r.verdict);
        a.append(img, el('span', 'sr-name', r.name), badge, el('span', 'sr-meta', r.meta));
        return a;
      });
      if (hits.length > top.length) {
        const foot = el('a', 'sr-foot', `↓ all ${hits.length} matches in the death list`);
        foot.href = '#death-list';
        nodes.push(foot);
      }
      srBox.replaceChildren(...nodes);
      srBox.classList.add('open');
      search?.setAttribute('aria-expanded', 'true');
    };

    const srRows = () => $$('.sr-row', srBox);
    const setActive = (i) => {
      const items = srRows();
      srActive = ((i % items.length) + items.length) % items.length;
      items.forEach((el, j) => el.classList.toggle('active', j === srActive));
    };

    search?.addEventListener('input', () => {
      applyFilter();
      renderDropdown(search.value.trim().toLowerCase());
    });
    search?.addEventListener('keydown', (e) => {
      const items = srRows();
      if (e.key === 'ArrowDown' && items.length) {
        e.preventDefault();
        setActive(srActive + 1);
      } else if (e.key === 'ArrowUp' && items.length) {
        e.preventDefault();
        setActive(srActive - 1);
      } else if (e.key === 'Escape') {
        renderDropdown('');
      } else if (e.key === 'Enter') {
        // Only follow a suggestion the user can see: with the dropdown closed
        // (query matches nothing) Enter does nothing, and the death list's
        // "no results" state is the honest answer.
        if (!srBox?.classList.contains('open')) return;
        const target = items[srActive >= 0 ? srActive : 0];
        if (target) location.href = target.getAttribute('href');
      }
    });
    document.addEventListener(
      'click',
      (e) => {
        if (srBox && !e.target.closest('.search-wrap')) renderDropdown('');
      },
      { signal: page.signal }
    );

    /* ---------- search audit ----------
       Log the query someone settled on, not every keystroke: a pause, Enter,
       picking a result, or leaving the box flushes it. Deduped so backspacing
       and retyping the same thing doesn't double-log. */
    let searchLogTimer;
    let lastLoggedQuery = '';
    const logSearch = () => {
      clearTimeout(searchLogTimer);
      const q = (search?.value || '').trim().toLowerCase().slice(0, 80);
      if (!q || q === lastLoggedQuery) return;
      lastLoggedQuery = q;
      const hits = rowData.filter((r) => r.lower.includes(q)).length;
      track('search', { query: q, hits });
      // keepalive: the request survives navigating away to a picked result.
      fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, hits }),
        keepalive: true,
      }).catch(() => {});
    };
    if (search) {
      search.addEventListener('input', () => {
        clearTimeout(searchLogTimer);
        searchLogTimer = setTimeout(logSearch, 1500);
      });
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') logSearch();
      });
      search.addEventListener('blur', logSearch);
      srBox?.addEventListener('click', logSearch);
    }

    /* ---------- odometer ---------- */
    const setOdometer = (value) => {
      const od = $('#ticker .odometer');
      if (!od) return;
      const chars = [...('$' + value.toLocaleString('en-US'))];
      const digits = $$('.digit, .sym', od);
      // Digit count changed (rolled past a comma boundary): fall back to plain
      // text — the next full page load rebuilds the reels.
      if (digits.length !== chars.length) {
        od.textContent = chars.join('');
        return;
      }
      chars.forEach((ch, i) => {
        const el = digits[i];
        if (!/\d/.test(ch) || el.dataset.digit === ch) return;
        el.dataset.digit = ch;
        const reel = $('.reel', el);
        if (reel) reel.style.transform = `translateY(calc(${-ch} * clamp(36px, 5.6vw, 56px)))`;
      });
    };

    // Roll the odometer in from zero on first view. Reset data-digit too, or
    // setOdometer sees the target value already "set" and skips the animation.
    const ticker = $('#ticker');
    if (ticker && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const total = Number(ticker.dataset.total || 0);
      if (total > 0) {
        $$('.digit', ticker).forEach((d) => {
          d.dataset.digit = '0';
          const reel = $('.reel', d);
          if (reel) {
            reel.style.transition = 'none';
            reel.style.transform = 'translateY(0)';
            void reel.offsetHeight; // flush so the roll animates from 0
            reel.style.transition = '';
          }
        });
        // Stagger per digit so the roll sweeps left to right.
        setTimeout(() => {
          $$('.digit', ticker).forEach((d, i) => {
            const reel = $('.reel', d);
            if (reel) reel.style.transitionDelay = `${i * 90}ms`;
          });
          setOdometer(total);
          setTimeout(
            () => $$('.digit .reel', ticker).forEach((r) => (r.style.transitionDelay = '')),
            2000
          );
        }, 350);
      }
    }

    // Tape speed: constant px/s regardless of how long the tape content is —
    // a fixed-duration animation over 109 apps scrolls comically fast.
    $$('.tape > span').forEach((span) => {
      const secs = Math.max(40, Math.round(span.scrollWidth / 55));
      span.style.animationDuration = `${secs}s`;
    });

    /* ---------- live stats poll ---------- */
    const refreshStats = async () => {
      try {
        const res = await fetch('/api/stats');
        if (!res.ok) return;
        const { mrr, votes } = await res.json();
        setOdometer(mrr);
        $$('[data-votes]').forEach((el) => {
          const v = votes[el.dataset.votes];
          if (v !== undefined && el.textContent !== String(v)) el.textContent = v;
        });
      } catch {}
    };
    if ($('#ticker')) {
      const iv = setInterval(refreshStats, 30000);
      onLeave(() => clearInterval(iv));
    }

    /* ---------- public analytics strip ---------- */
    const strip = $('#stats-strip');
    if (strip) {
      const refreshStrip = async () => {
        try {
          const res = await fetch('/api/analytics');
          const s = await res.json();
          if (s.unavailable) return;
          Object.entries(s).forEach(([k, v]) => {
            const el = $(`[data-stat="${k}"]`, strip);
            if (el && v != null) el.textContent = Number(v).toLocaleString('en-US');
          });
        } catch {}
      };
      const iv = setInterval(refreshStrip, 60000);
      onLeave(() => clearInterval(iv));
    }

    /* ---------- open-in-agent deeplinks + raw copy ----------
       Each agent registers a URL scheme that opens its harness with the prompt
       prefilled (never auto-sent). The prompt is also copied as a fallback for
       machines without the handler installed. */
    const AGENTS = {
      'claude-code': {
        name: 'Claude Code',
        link: (p) => `claude-cli://open?q=${encodeURIComponent(p)}`,
        newTab: false,
      },
      codex: {
        name: 'Codex',
        link: (p) => `https://chatgpt.com/codex/deeplink?prompt=${encodeURIComponent(p)}`,
        newTab: true,
      },
      cursor: {
        // Official https launcher: fires the cursor:// scheme and shows a
        // download fallback when the app isn't installed.
        name: 'Cursor',
        link: (p) => `https://cursor.com/link/prompt?text=${encodeURIComponent(p)}`,
        newTab: true,
      },
    };

    // Clipboard API needs a secure context (https / localhost); the textarea +
    // execCommand path covers plain-http previews and older browsers.
    const copyText = async (text) => {
      if (navigator.clipboard && window.isSecureContext) {
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch {}
      }
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {}
      ta.remove();
      return ok;
    };

    const flashCopied = (btn, text = 'copied ✓') => {
      const label = $('span:last-child', btn);
      const original = label.textContent;
      label.textContent = text;
      btn.classList.add('copied');
      setTimeout(() => {
        label.textContent = original;
        btn.classList.remove('copied');
      }, 1800);
    };

    /* ---------- project-pack mode + file browser ---------- */
    const projectPack = $('[data-project-pack]');
    if (projectPack) {
      const promptText = $('#prompt-text');
      const summary = $('[data-pack-summary]', projectPack);
      const summaries = {
        indie: '4 files · fastest path to a working personal build',
        product: '5 files · architecture, delivery, and operations included',
      };

      const selectFile = (workspace, path) => {
        $$('[data-pack-file]', workspace).forEach((btn) => {
          const active = btn.dataset.packFile === path;
          btn.classList.toggle('active', active);
          btn.setAttribute('aria-pressed', String(active));
        });
        $$('[data-pack-panel]', workspace).forEach((panel) => {
          panel.hidden = panel.dataset.packPanel !== path;
        });
      };

      $$('[data-pack-file]', projectPack).forEach((btn) => {
        btn.addEventListener('click', () => selectFile(btn.closest('[data-pack-mode]'), btn.dataset.packFile));
      });

      $$('[data-build-mode]', projectPack).forEach((btn) => {
        btn.addEventListener('click', () => {
          const mode = btn.dataset.buildMode;
          $$('[data-build-mode]', projectPack).forEach((modeBtn) => {
            const active = modeBtn === btn;
            modeBtn.classList.toggle('active', active);
            modeBtn.setAttribute('aria-pressed', String(active));
          });
          $$('[data-pack-mode]', projectPack).forEach((workspace) => {
            workspace.hidden = workspace.dataset.packMode !== mode;
          });
          const bundle = $(`[data-pack-bundle="${mode}"]`, projectPack);
          if (promptText && bundle) promptText.textContent = bundle.textContent;
          if (summary) summary.textContent = summaries[mode];
          track('build_mode_select', { app: projectPack.querySelector('.copy-group')?.dataset.slug, mode });
        });
      });

      $$('[data-copy-file]', projectPack).forEach((btn) => {
        btn.addEventListener('click', async () => {
          const content = $('pre', btn.closest('[data-pack-panel]'))?.textContent || '';
          const copied = await copyText(content);
          if (copied) {
            const original = btn.textContent;
            btn.textContent = 'copied ✓';
            setTimeout(() => (btn.textContent = original), 1600);
          } else {
            toast('copy failed · select the file manually');
          }
        });
      });
    }

    /* The ask lands after the value: the reveal only appears once the prompt is
       in someone's clipboard, and never again after a signup or a dismissal. */
    const reveal = $('#digest-reveal');
    // Storage throws outright in blocked-cookie contexts and in-app webviews.
    const remembered = (key) => {
      try {
        return !!localStorage.getItem(key);
      } catch {
        return false;
      }
    };
    const remember = (key) => {
      try {
        localStorage.setItem(key, '1');
      } catch {}
    };
    /* One shared dismissal for every digest ask (reveal + bar): closing any of
       them silences all of them, for 90 days rather than forever. Legacy
       per-surface flags convert to one clock starting at first sight.
       digest_subscribed stays permanent — subscribers never get asked again. */
    const DISMISS_KEY = 'digest_ask_dismissed';
    const DISMISS_TTL = 90 * 24 * 60 * 60 * 1000;
    const dismissAsks = () => {
      try {
        localStorage.setItem(DISMISS_KEY, String(Date.now()));
      } catch {}
    };
    const asksDismissed = () => {
      try {
        if (localStorage.getItem('digest_dismissed') || localStorage.getItem('digest_bar_dismissed')) {
          localStorage.removeItem('digest_dismissed');
          localStorage.removeItem('digest_bar_dismissed');
          dismissAsks();
          return true;
        }
        const at = Number(localStorage.getItem(DISMISS_KEY));
        if (!at) return false;
        if (Date.now() - at < DISMISS_TTL) return true;
        localStorage.removeItem(DISMISS_KEY);
        return false;
      } catch {
        return false;
      }
    };
    /* The same card serves several moments (post-copy, post-vote): the trigger
       passes its own source + headline. First trigger wins — a visible card is
       never re-labelled under the reader. */
    const showReveal = (opts) => {
      if (!reveal || !reveal.hidden) return;
      if (asksDismissed() || remembered('digest_subscribed')) return;
      if (opts?.source) {
        const src = $('input[name=source]', reveal);
        if (src) src.value = opts.source;
      }
      if (opts?.head) {
        const head = $('[data-dr-head]', reveal);
        if (head) head.textContent = opts.head;
      }
      reveal.hidden = false;
      requestAnimationFrame(() => reveal.classList.add('in'));
      // One ask at a time: the reveal on screen sends the bar away.
      killBar();
    };

    $$('.copy-group').forEach((group) => {
      const slug = group.dataset.slug;
      group.addEventListener('click', async (e) => {
        const btn = e.target.closest('.copy-btn');
        if (!btn) return;
        const prompt = $('#prompt-text')?.textContent || '';

        if (btn.dataset.agent === 'raw') {
          const copied = await copyText(prompt);
          track('copy_prompt', { app: slug, agent: 'raw' });
          if (copied) {
            flashCopied(btn);
            toast('prompt copied · paste it into any agent');
            showReveal();
          } else {
            toast('copy failed · select the text manually');
          }
          return;
        }

        const agent = AGENTS[btn.dataset.agent];
        copyText(prompt); // best-effort backup; don't block the deeplink on it
        flashCopied(btn, 'opening…');
        toast(`opening ${agent.name} · prompt prefilled (and copied, just in case)`);
        const url = agent.link(prompt);
        if (agent.newTab) window.open(url, '_blank', 'noopener');
        else window.location.href = url;
        track('copy_prompt', { app: slug, agent: btn.dataset.agent });
        showReveal();
      });
    });

    /* ---------- build progress ----------
       Device-local progress over the steps on /<slug>/build, in localStorage
       under vibecodeit:progress · same contract as my stack, no account and no
       server round trip. Each entry stores the step count it was saved against,
       so a prompt that later gains or loses phases invalidates its own stale
       ticks instead of crossing off the wrong steps. */
    const PROGRESS_KEY = 'vibecodeit:progress';
    const readProgress = () => {
      try {
        const value = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      } catch {
        return {};
      }
    };
    const readSteps = (slug, total) => {
      const entry = readProgress()[slug];
      if (!entry || !Array.isArray(entry.done) || entry.total !== total) return [];
      return entry.done.filter((i) => Number.isInteger(i) && i >= 0 && i < total);
    };
    const writeSteps = (slug, total, done) => {
      try {
        const all = readProgress();
        if (done.length) all[slug] = { done: [...done].sort((a, b) => a - b), total, updated: Date.now() };
        else delete all[slug];
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
        return true;
      } catch {
        return false;
      }
    };

    /* Verdict-page CTA: shows the percentage back once there is any, so the
       button reads as "resume" rather than "start" on a return visit. */
    const cta = $('[data-track-cta]');
    if (cta) {
      const total = Number(cta.dataset.total) || 0;
      const done = readSteps(cta.dataset.slug, total);
      if (done.length) {
        const ring = $('[data-track-cta-ring]', cta);
        const pct = $('[data-track-cta-pct]', cta);
        const sub = $('[data-track-cta-sub]', cta);
        const percent = total ? Math.round((done.length / total) * 100) : 0;
        if (pct) pct.textContent = `${percent}%`;
        if (ring) ring.hidden = false;
        if (sub) sub.textContent = done.length === total
          ? 'every step done'
          : `${total - done.length} of ${total} left`;
      }
      cta.addEventListener('click', () => track('build_track_open', { app: cta.dataset.slug }));
    }

    /* The tracker itself. */
    const buildPage = $('[data-build-page]');
    if (buildPage) {
      const slug = buildPage.dataset.slug;
      const total = Number(buildPage.dataset.total) || 0;
      const bar = $('[data-bt-bar]', buildPage);
      const fill = $('[data-bt-fill]', buildPage);
      const pct = $('[data-bt-pct]', buildPage);
      const doneCount = $('[data-bt-done]', buildPage);
      const finished = $('[data-build-done]', buildPage);

      const render = (done) => {
        const set = new Set(done);
        $$('[data-bt-toggle]', buildPage).forEach((btn) => {
          const i = Number(btn.dataset.btToggle);
          const isDone = set.has(i);
          btn.setAttribute('aria-pressed', String(isDone));
          btn.closest('.step')?.classList.toggle('done', isDone);
        });
        const percent = total ? Math.round((set.size / total) * 100) : 0;
        if (fill) fill.style.width = `${percent}%`;
        if (pct) pct.textContent = `${percent}%`;
        if (doneCount) doneCount.textContent = String(set.size);
        if (bar) bar.setAttribute('aria-valuenow', String(percent));
        if (finished) finished.hidden = !(total > 0 && set.size === total);
        buildPage.classList.toggle('complete', total > 0 && set.size === total);
      };

      let done = readSteps(slug, total);
      render(done);

      /* Collapse everything already ticked on arrival: coming back to a
         half-finished build should open on the step actually being worked. */
      done.forEach((i) => {
        const detail = $(`[data-step-detail="${i}"]`, buildPage);
        const toggle = $(`[data-step-collapse="${i}"]`, buildPage);
        if (detail && toggle) {
          detail.hidden = true;
          toggle.setAttribute('aria-expanded', 'false');
        }
      });

      $$('[data-bt-toggle]', buildPage).forEach((btn) => {
        btn.addEventListener('click', () => {
          const i = Number(btn.dataset.btToggle);
          const set = new Set(done);
          const nowDone = !set.has(i);
          if (nowDone) set.add(i);
          else set.delete(i);
          done = [...set];
          if (!writeSteps(slug, total, done)) {
            toast('progress needs site data enabled in this browser');
            done = readSteps(slug, total);
          }
          render(done);
          if (nowDone && done.length === total) toast('every step done · nice');
          track('build_step_toggle', { app: slug, step: i, done: nowDone, completed: done.length, total });
        });
      });

      $$('[data-step-collapse]', buildPage).forEach((btn) => {
        btn.addEventListener('click', () => {
          const detail = $(`[data-step-detail="${btn.dataset.stepCollapse}"]`, buildPage);
          if (!detail) return;
          const open = btn.getAttribute('aria-expanded') === 'true';
          btn.setAttribute('aria-expanded', String(!open));
          detail.hidden = open;
        });
      });

      /* Reset wipes work someone actually did, so it arms first and disarms on
         second thoughts, matching the stack's remove control. */
      const resetBtn = $('[data-bt-reset]', buildPage);
      if (resetBtn) {
        const label = resetBtn.textContent;
        let armTimer = null;
        const disarm = () => {
          clearTimeout(armTimer);
          delete resetBtn.dataset.armed;
          resetBtn.textContent = label;
        };
        resetBtn.addEventListener('click', () => {
          if (!done.length) return;
          if (!resetBtn.dataset.armed) {
            resetBtn.dataset.armed = '1';
            resetBtn.textContent = 'clear all progress?';
            armTimer = setTimeout(disarm, 4000);
            return;
          }
          disarm();
          done = [];
          writeSteps(slug, total, done);
          render(done);
          track('build_progress_reset', { app: slug });
        });
        onLeave(disarm);
      }
    }

    /* ---------- vote (toggles: click again to take it back) ---------- */
    const voteLabel = (btn, voted) => {
      const text = btn.childNodes[0];
      if (text?.nodeType === 3) text.textContent = voted ? '✓ replaced it · ' : 'I replaced this · ';
      btn.classList.toggle('is-voted', voted);
      btn.title = voted ? 'click to take your vote back' : '';
    };

    $$('[data-vote]').forEach((btn) => {
      const slug = btn.dataset.vote;
      if (localStorage.getItem(`voted:${slug}`)) voteLabel(btn, true);

      btn.addEventListener('click', async () => {
        const voted = !!localStorage.getItem(`voted:${slug}`);
        btn.classList.remove('voted');
        void btn.offsetWidth; // restart animation
        btn.classList.add('voted');
        try {
          const res = await fetch(`/api/vote/${slug}`, { method: voted ? 'DELETE' : 'POST' });
          if (!voted && res.status === 429) {
            localStorage.setItem(`voted:${slug}`, '1');
            voteLabel(btn, true);
            toast('already counted · one funeral per person');
            return;
          }
          if (!res.ok) throw new Error();
          const { count } = await res.json();
          $$(`[data-votes="${slug}"]`).forEach((el) => (el.textContent = count));
          if (voted) {
            localStorage.removeItem(`voted:${slug}`);
            voteLabel(btn, false);
            toast('vote taken back · resurrection granted');
            track('unvote', { app: slug });
          } else {
            localStorage.setItem(`voted:${slug}`, '1');
            voteLabel(btn, true);
            toast('☠ counted. RIP that subscription.');
            track('vote', { app: slug });
            showReveal({ source: 'post_vote', head: 'counted. verdicts flip when models improve.' });
          }
        } catch {
          toast('something broke · try again');
        }
      });
    });

    /* ---------- share ---------- */
    $$('[data-share]').forEach((a) =>
      a.addEventListener('click', () => track('share', { app: a.dataset.share }))
    );

    /* ---------- local-only my stack ---------- */
    const jsonPost = (url, method, body) =>
      fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const STACK_KEY = 'vibecodeit:stack';
    const readStack = () => {
      try {
        const value = JSON.parse(localStorage.getItem(STACK_KEY) || '[]');
        return Array.isArray(value) ? [...new Set(value.filter((slug) => typeof slug === 'string'))] : [];
      } catch {
        return [];
      }
    };
    const writeStack = (slugs) => {
      try {
        localStorage.setItem(STACK_KEY, JSON.stringify([...new Set(slugs)]));
        return true;
      } catch {
        return false;
      }
    };

    const markIcons = (slug, saved) =>
      $$(`[data-stack-icon][data-slug="${CSS.escape(slug)}"]`).forEach((el) => {
        el.classList.toggle('saved', saved);
        if (el.hasAttribute('aria-pressed')) el.setAttribute('aria-pressed', String(saved));
      });
    const setStackBtn = (btn, saved) => {
      btn.dataset.saved = saved ? '1' : '';
      btn.classList.toggle('in-stack', saved);
      btn.textContent = saved ? '✓ in your stack' : '+ save to my stack';
    };
    /* Two-step confirm, in place of a browser confirm(): the button arms
       itself, says so, and disarms on second thoughts (a click anywhere else,
       Escape, or 4s of hesitation). One armed button at a time. Returns true
       only on the click that confirms. */
    let armedBtn = null;
    let armedLabel = '';
    let armedTimer;
    const disarm = () => {
      if (!armedBtn) return;
      clearTimeout(armedTimer);
      armedBtn.textContent = armedLabel;
      armedBtn.classList.remove('armed');
      armedBtn = null;
    };
    const armConfirm = (btn, label) => {
      if (armedBtn === btn) {
        disarm();
        return true;
      }
      disarm();
      armedBtn = btn;
      armedLabel = btn.textContent;
      armedTimer = setTimeout(disarm, 4000);
      btn.textContent = label;
      btn.classList.add('armed');
      return false;
    };
    /* The arming click reaches this on the way up, but the button still
       contains the target then, so it never disarms itself. */
    document.addEventListener(
      'click',
      (e) => {
        if (armedBtn && !armedBtn.contains(e.target)) disarm();
      },
      { signal: page.signal }
    );
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') disarm();
      },
      { signal: page.signal }
    );
    onLeave(disarm);

    const updateStackPage = () => {
      const slugs = readStack();
      const saved = new Set(slugs);
      $$('[data-stack-count]').forEach((el) => {
        el.textContent = slugs.length;
        el.hidden = slugs.length === 0;
      });
      $$('[data-local-stack-row]').forEach((row) => {
        row.hidden = !saved.has(row.dataset.localStackRow);
      });
      const page = $('[data-local-stack-page]');
      if (!page) return;
      const rows = $$('[data-local-stack-row]', page).filter((row) => !row.hidden);
      const monthly = rows.reduce((sum, row) => sum + Number(row.dataset.price || 0), 0);
      $('[data-local-stack-count]', page).textContent = rows.length;
      $('[data-local-stack-monthly]', page).textContent = `$${monthly.toFixed(2).replace(/\.00$/, '')}`;
      $('[data-local-stack-yearly]', page).textContent = `$${(monthly * 12).toFixed(2).replace(/\.00$/, '')}`;
      $('[data-local-stack-saved]', page).hidden = rows.length === 0;
      $('[data-local-stack-empty]', page).hidden = rows.length > 0;
    };

    const toggleStack = (slug, saved) => {
      const slugs = readStack();
      const next = saved ? slugs.filter((item) => item !== slug) : [...slugs, slug];
      if (!writeStack(next)) throw new Error();
      const btn = $(`[data-stack="${CSS.escape(slug)}"]`);
      if (btn) setStackBtn(btn, !saved);
      markIcons(slug, !saved);
      updateStackPage();
      toast(saved ? 'removed from your stack' : '✓ saved to your stack');
      track(saved ? 'stack_remove' : 'stack_add', { app: slug });
    };

    /* verdict-page button */
    $$('[data-stack]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const slug = btn.dataset.stack;
        const saved = btn.dataset.saved === '1';
        if (saved && !armConfirm(btn, 'click again to remove')) return;
        try {
          toggleStack(slug, saved);
        } catch {
          toast('browser storage is unavailable');
        }
      })
    );

    /* death-list quick-save icons (span[role=button] inside the row link) */
    const iconAct = (el) => {
      const slug = el.dataset.slug;
      try {
        toggleStack(slug, el.classList.contains('saved'));
      } catch {
        toast('browser storage is unavailable');
      }
    };
    $$('[data-stack-icon]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        iconAct(el);
      });
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        iconAct(el);
      });
    });

    readStack().forEach((slug) => {
      markIcons(slug, true);
      const btn = $(`[data-stack="${CSS.escape(slug)}"]`);
      if (btn) setStackBtn(btn, true);
    });
    updateStackPage();

    $$('[data-stack-remove]').forEach((btn) =>
      btn.addEventListener('click', () => {
        try {
          toggleStack(btn.dataset.stackRemove, true);
        } catch {
          toast('browser storage is unavailable');
        }
      })
    );

    $$('[data-stack-suggest]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const slug = btn.dataset.stackSuggest;
        try {
          toggleStack(slug, readStack().includes(slug));
        } catch {
          toast('browser storage is unavailable');
        }
      })
    );

    const digestToggle = $('[data-digest-toggle]');
    digestToggle?.addEventListener('click', async () => {
      const next = digestToggle.dataset.on !== '1';
      digestToggle.dataset.on = next ? '1' : '';
      digestToggle.classList.toggle('on', next);
      digestToggle.setAttribute('aria-checked', String(next));
      const state = $('[data-digest-state]');
      if (state) state.textContent = next ? 'subscribed' : 'not subscribed';
      try {
        const res = await jsonPost('/api/account/digest', 'POST', { on: next });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || '');
        }
        toast(next ? 'digest on · see you sunday' : 'digest off');
      } catch (err) {
        digestToggle.dataset.on = next ? '' : '1';
        digestToggle.classList.toggle('on', !next);
        digestToggle.setAttribute('aria-checked', String(!next));
        if (state) state.textContent = !next ? 'subscribed' : 'not subscribed';
        toast(err?.message || 'something broke · try again');
      }
    });

    /* Delete account: the one destructive action here, so it gets a real
       modal and a typed phrase rather than a button you can fat-finger.
       Same open/close mechanics as the signup modal. */
    const delModal = $('#delete-modal');
    const delPhrase = $('[data-delete-phrase]');
    const delGo = $('[data-delete-go]');
    let delCloseTimer;
    const closeDelete = () => {
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';
      if (!delModal || delModal.hidden) return;
      delModal.classList.remove('open');
      clearTimeout(delCloseTimer);
      delCloseTimer = setTimeout(() => {
        delModal.hidden = true;
      }, 240);
    };
    const openDelete = () => {
      if (!delModal) return;
      if (delPhrase) delPhrase.value = '';
      if (delGo) delGo.disabled = true;
      const scrollbar = window.innerWidth - document.documentElement.clientWidth;
      if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;
      document.body.style.overflow = 'hidden';
      clearTimeout(delCloseTimer);
      delModal.hidden = false;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        delModal.classList.add('open');
        delPhrase?.focus();
      }));
    };
    onLeave(closeDelete);
    $('[data-delete-account]')?.addEventListener('click', openDelete);
    delModal?.addEventListener('click', (e) => {
      if (e.target === delModal || e.target.closest('[data-delete-cancel]')) closeDelete();
    });
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape' && delModal && !delModal.hidden) closeDelete();
      },
      { signal: page.signal }
    );
    delPhrase?.addEventListener('input', () => {
      if (delGo) delGo.disabled = delPhrase.value.trim().toLowerCase() !== 'delete';
    });
    delGo?.addEventListener('click', async () => {
      if (delGo.disabled) return;
      delGo.disabled = true;
      delGo.textContent = 'deleting…';
      try {
        const res = await fetch('/api/account/delete', { method: 'POST' });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          delGo.textContent = 'delete account';
          delGo.disabled = false;
          closeDelete();
          toast(d.error || 'delete failed · sign in again and retry');
          return;
        }
        window.location.href = '/';
      } catch {
        delGo.textContent = 'delete account';
        delGo.disabled = false;
        closeDelete();
        toast('something broke · try again');
      }
    });

    /* ---------- sponsors ---------- */
    $$('.sp-card, .sp-banner, .sp-tape-item').forEach((el) =>
      el.addEventListener('click', () => {
        const slot = el.dataset.slot || 'none';
        const surface = el.classList.contains('sp-card')
          ? 'rail'
          : el.classList.contains('sp-tape-item')
            ? 'tape'
            : 'banner';
        track('sponsor_slot_click', { slot, state: el.dataset.state, surface });
        // First-party copy of live-placement clicks (slot + surface + country),
        // logged server-side for the private admin stats.
        if (el.classList.contains('live') && navigator.sendBeacon) {
          navigator.sendBeacon('/api/spot', JSON.stringify({ slot, surface }));
        }
      })
    );

    // The form submits natively so it works without JS; this tracks the click and
    // shows that something is happening while Stripe answers.
    $$('form[data-checkout]').forEach((form) => {
      form.addEventListener('submit', (e) => {
        // A second click would create a second hold on the same slot.
        if (form.dataset.loading === '1') {
          e.preventDefault();
          return;
        }
        form.dataset.loading = '1';
        const btn = $('button', form);
        track('sponsor_checkout_start', {
          slot: $('[name=slot]', form)?.value,
          price: Number(btn?.dataset.price) || null,
        });
        if (!btn) return;
        btn.classList.add('is-loading');
        // Swap the one line that can change without moving anything: the card and
        // banner have fixed heights, so the geometry is identical either way.
        const label = $('.sp-cta', btn) || $('.sp-tag', btn) || btn;
        if (label.dataset.spLabel === undefined) label.dataset.spLabel = label.textContent;
        label.textContent = 'opening checkout…';
        // Disabling inside the submit event can cancel the submission in some
        // browsers; a tick later still beats a second click.
        setTimeout(() => {
          btn.disabled = true;
        }, 0);
      });
    });

    /* ---------- digest signup ---------- */
    const bar = $('#digest-bar');

    // Dismissing or signing up has to be permanent for the session: without this
    // the next scroll event is past the show threshold and puts the bar straight
    // back. The flag covers browsers that ignore the listener's abort signal.
    const barScroll = new AbortController();
    onLeave(() => barScroll.abort());
    let barOff = false;
    const killBar = (hide = true) => {
      barOff = true;
      barScroll.abort();
      // Signup from the bar: let the "you're in ✓" land, then slide away.
      if (hide) bar?.classList.remove('show');
      else setTimeout(() => bar?.classList.remove('show'), 2500);
    };

    const COREG_OFF = 'cvci_rec_coreg_off';
    const showCoreg = (form, email) => {
      const tpl = document.getElementById('rec-coreg-tpl');
      if (!tpl || localStorage.getItem(COREG_OFF) === '1') return false;
      if (document.documentElement.classList.contains('ruben-src')) return false;
      const card = tpl.content.firstElementChild.cloneNode(true);
      const source = form.querySelector('input[name=source]')?.value === 'buildgames' ? 'coreg_buildgames' : 'coreg_digest';
      const go = card.querySelector('[data-rec-coreg-go]');
      go.href = '/api/rec/howtoai?src=' + source + (email ? '&email=' + encodeURIComponent(email) : '');
      card.querySelector('[data-rec-coreg-no]').addEventListener('click', () => {
        localStorage.setItem(COREG_OFF, '1');
        card.remove();
        if (bar && bar.contains(form)) bar.classList.remove('show');
      });
      go.addEventListener('click', () => {
        localStorage.setItem(COREG_OFF, '1');
        if (bar && bar.contains(form)) setTimeout(() => bar.classList.remove('show'), 800);
      });
      form.insertAdjacentElement('afterend', card);
      // Impression beacon: the CTR denominator for the co-reg surface.
      try {
        navigator.sendBeacon('/api/rec/impression?src=' + source);
      } catch {
        /* a lost beacon is a lost count, never a broken card */
      }
      return true;
    };

    $$('form[data-digest]').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('button', form);
        const res = await fetch('/api/waitlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.fromEntries(new FormData(form))),
        }).catch(() => null);
        if (res?.ok) {
          btn.textContent = "you're in ✓";
          btn.disabled = true;
          const emailInput = form.querySelector('input[type=email]');
          emailInput.disabled = true;
          toast('in. see you sunday.');
          // waitlist_signup is captured server-side in /api/waitlist — no
          // client event, or blocked-analytics visitors vanish from the count.
          remember('digest_subscribed');
          if (reveal && !reveal.contains(form)) reveal.hidden = true;
          /* Co-reg: one card, one tap, their email already in the link. Never
             again once dismissed (localStorage); never for Ruben-sourced
             visitors (html.ruben-src hides it via CSS). If the card shows
             inside the bar, the bar stays up for it instead of sliding away. */
          const showedCoreg = showCoreg(form, emailInput.value);
          if (bar) {
            if (bar.contains(form) && showedCoreg) {
              barOff = true;
              barScroll.abort();
            } else killBar(!bar.contains(form));
          }
        } else {
          toast(res?.status === 429 ? 'slow down a little' : 'that email looks off');
        }
      });
    });

    /* Signed-in one-click subscribe (the reveal's dr-oneclick state): the
       account email is on file, /api/account/digest flips it on server-side. */
    $('[data-digest-oneclick]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const placement = reveal?.querySelector('input[name=source]')?.value || 'app_copy';
      const res = await jsonPost('/api/account/digest', 'POST', { on: true, placement }).catch(() => null);
      if (res?.ok) {
        btn.textContent = "you're in ✓";
        toast('digest on · see you sunday');
        remember('digest_subscribed');
        setTimeout(() => {
          if (reveal) reveal.hidden = true;
        }, 1500);
        killBar();
      } else {
        btn.disabled = false;
        toast('that did not stick · try again');
      }
    });

    $$('[data-digest-dismiss]').forEach((el) =>
      el.addEventListener('click', () => {
        if (reveal) reveal.hidden = true;
        dismissAsks();
      })
    );

    /* The bar arrives once someone is past the first screen and leaves again at
       the top. Dismissed or subscribed → the listener is never attached. */
    if (bar && !asksDismissed() && !remembered('digest_subscribed')) {
      let queued = false;
      const syncBar = () => {
        queued = false;
        if (barOff) return;
        // One ask at a time: while the post-copy reveal is up, the bar waits.
        if (reveal && !reveal.hidden) return;
        const y = window.scrollY;
        if (y > window.innerHeight * 0.8) bar.classList.add('show');
        else if (y < 200) bar.classList.remove('show');
      };
      window.addEventListener(
        'scroll',
        () => {
          if (barOff || queued) return;
          queued = true;
          requestAnimationFrame(syncBar);
        },
        { passive: true, signal: barScroll.signal }
      );
    }

    $('[data-digest-bar-dismiss]')?.addEventListener('click', () => {
      killBar();
      dismissAsks();
    });

    /* ---------- reveal on scroll ---------- */
    const revealables = $$('.reveal');
    if (revealables.length && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver(
        (entries) =>
          entries.forEach((en) => {
            if (en.isIntersecting) {
              en.target.classList.add('in');
              io.unobserve(en.target);
            }
          }),
        { threshold: 0.15 }
      );
      revealables.forEach((el) => io.observe(el));
    } else {
      revealables.forEach((el) => el.classList.add('in'));
    }
  };

  /* astro:page-load fires on the initial load too, but on slow pages the
     timer fallback can beat it — boot() makes whichever arrives second a
     no-op. Double-running initPage wires every handler twice, and a doubled
     theme toggle flips the theme twice per click, i.e. visibly never. The
     before-swap handler above re-arms it for each soft navigation. */
  const boot = () => {
    if (inited) return;
    inited = true;
    initPage();
  };
  document.addEventListener('astro:page-load', boot);
  const bootFallback = () => setTimeout(boot, 20);
  document.readyState === 'loading'
    ? addEventListener('DOMContentLoaded', bootFallback)
    : bootFallback();
})();
