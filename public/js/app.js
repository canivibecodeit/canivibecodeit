/* Can I Vibecode It? — interactions. No frameworks, on purpose. */
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

    /* ---------- category dropdown (list header) ---------- */
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
        const opt = e.target.closest('.cat-opt');
        if (!opt) return;
        activeCat = opt.dataset.cat || '';
        $$('.cat-opt', ddPanel).forEach((o) => {
          o.classList.toggle('active', o === opt);
          o.setAttribute('aria-selected', String(o === opt));
        });
        ddLabel.textContent = opt.dataset.label;
        ddBtn.classList.toggle('filtering', !!activeCat);
        ddClose();
        applyFilter();
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
    const showReveal = () => {
      if (!reveal) return;
      if (remembered('digest_dismissed') || remembered('digest_subscribed')) return;
      reveal.hidden = false;
      requestAnimationFrame(() => reveal.classList.add('in'));
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

    /* ---------- accounts + my stack ---------- */
    const authed = document.body.dataset.user === '1';
    const jsonPost = (url, method, body) =>
      fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    /* Signup modal: stays on the page (converts better than navigating away).
       The [data-signin] links keep href=/signin so no-JS still works. */
    const modal = $('#signup-modal');
    let pendingSlug = null;
    let modalCloseTimer;
    const openSignup = (slug) => {
      pendingSlug = slug || null;
      if (!modal) {
        window.location.href = '/signin';
        return;
      }
      /* The title is conditional: "Sign in" from the nav, the save pitch only
         when a save actually triggered it. */
      const title = $('#signup-title');
      if (title) title.textContent = pendingSlug ? 'Save it to your stack' : 'Sign in';
      /* Hiding the scrollbar shrinks the viewport and shifts the page; pad the
         body by exactly the scrollbar width so nothing moves. */
      const scrollbar = window.innerWidth - document.documentElement.clientWidth;
      if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;
      document.body.style.overflow = 'hidden';
      clearTimeout(modalCloseTimer);
      modal.hidden = false;
      requestAnimationFrame(() => requestAnimationFrame(() => modal.classList.add('open')));
      track('signup_open', { app: pendingSlug || undefined });
    };
    const closeSignup = () => {
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';
      if (!modal || modal.hidden) return;
      modal.classList.remove('open');
      clearTimeout(modalCloseTimer);
      modalCloseTimer = setTimeout(() => {
        modal.hidden = true;
      }, 240);
    };
    onLeave(closeSignup);
    modal?.addEventListener('click', (e) => {
      if (e.target === modal || e.target.closest('[data-signup-close]')) closeSignup();
    });
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape' && modal && !modal.hidden) closeSignup();
      },
      { signal: page.signal }
    );
    $$('[data-signin]').forEach((a) =>
      a.addEventListener('click', (e) => {
        e.preventDefault();
        openSignup();
      })
    );

    /* The checkbox value rides inside the signed OAuth state; the pending save
       comes back as a ?stacksave= param on the callback URL. The callback is
       pathname-only: Better Auth's trustedOrigins regex rejects several legal
       query characters, and a rejected callback means sign-in dies with a 403.
       The checkbox is read from the SAME surface as the clicked button; the
       hidden modal also has one and must never shadow the /signin page's. */
    const oauthStart = async (btn) => {
      const provider = btn.dataset.oauth;
      const box = btn
        .closest('.signup-card, .signin-card')
        ?.querySelector('input[type="checkbox"]');
      let callbackURL = location.pathname === '/signin' ? '/' : location.pathname;
      if (pendingSlug) callbackURL += `?stacksave=${encodeURIComponent(pendingSlug)}`;
      try {
        const res = await jsonPost('/api/auth/sign-in/social', 'POST', {
          provider,
          callbackURL,
          additionalData: { newsletter: !!box?.checked },
        });
        if (!res.ok) throw new Error();
        const { url } = await res.json();
        if (!url) throw new Error();
        track('signup_start', { provider, digest: !!box?.checked });
        window.location.href = url;
      } catch {
        toast('sign-in failed to start · try again');
      }
    };
    $$('[data-oauth]').forEach((btn) =>
      btn.addEventListener('click', () => oauthStart(btn))
    );

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

    const toggleStack = async (slug, saved) => {
      const res = await jsonPost('/api/stack', saved ? 'DELETE' : 'POST', { slug });
      if (!res.ok) throw new Error();
      const btn = $(`[data-stack="${CSS.escape(slug)}"]`);
      if (btn) setStackBtn(btn, !saved);
      markIcons(slug, !saved);
      toast(saved ? 'removed from your stack' : '✓ saved to your stack');
      track(saved ? 'stack_remove' : 'stack_add', { app: slug });
    };

    /* verdict-page button */
    $$('[data-stack]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const slug = btn.dataset.stack;
        if (!authed) return openSignup(slug);
        const saved = btn.dataset.saved === '1';
        if (saved && !armConfirm(btn, 'click again to remove')) return;
        try {
          await toggleStack(slug, saved);
        } catch {
          toast('something broke · try again');
        }
      })
    );

    /* death-list quick-save icons (span[role=button] inside the row link) */
    const iconAct = async (el) => {
      const slug = el.dataset.slug;
      if (!authed) return openSignup(slug);
      try {
        await toggleStack(slug, el.classList.contains('saved'));
      } catch {
        toast('something broke · try again');
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

    /* signed-in: paint saved states on the list icons once per page */
    if (authed && $('[data-stack-icon]')) {
      fetch('/api/stack')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d?.slugs?.forEach((s) => markIcons(s, true)))
        .catch(() => {});
    }

    /* back from OAuth with a pending save: finish it, clean the URL */
    const params = new URLSearchParams(location.search);
    const pendingSave = params.get('stacksave');
    if (pendingSave) {
      params.delete('stacksave');
      history.replaceState(null, '', location.pathname + (params.size ? `?${params}` : ''));
      if (authed) {
        jsonPost('/api/stack', 'POST', { slug: pendingSave })
          .then((r) => {
            if (!r.ok) return;
            const btn = $(`[data-stack="${CSS.escape(pendingSave)}"]`);
            if (btn) setStackBtn(btn, true);
            markIcons(pendingSave, true);
            toast('✓ saved to your stack');
          })
          .catch(() => {});
      }
    }

    /* ---------- /account ---------- */
    $('[data-signout]')?.addEventListener('click', async () => {
      try {
        await jsonPost('/api/auth/sign-out', 'POST', {});
      } catch {}
      window.location.href = '/';
    });

    $$('[data-stack-remove]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        if (!armConfirm(btn, 'confirm?')) return;
        try {
          const res = await jsonPost('/api/stack', 'DELETE', { slug: btn.dataset.stackRemove });
          if (!res.ok) throw new Error();
          btn.closest('.stack-row')?.remove();
          toast('removed from your stack');
        } catch {
          toast('something broke · try again');
        }
      })
    );

    /* empty-stack suggestions: save without leaving /account. Reload rather
       than patch the DOM: the count, the total and the whole section are
       server-rendered, and this fires at most three times per account. */
    $$('[data-stack-suggest]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const slug = btn.dataset.stackSuggest;
        btn.disabled = true;
        try {
          const res = await jsonPost('/api/stack', 'POST', { slug });
          if (!res.ok) throw new Error();
          track('stack_add', { app: slug });
          window.location.reload();
        } catch {
          btn.disabled = false;
          toast('something broke · try again');
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
        toast(next ? 'digest on · see you thursday' : 'digest off');
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
          form.querySelector('input[type=email]').disabled = true;
          toast('in. verdicts arrive weekly.');
          track('waitlist_signup', { placement: form.querySelector('[name=source]')?.value });
          remember('digest_subscribed');
          if (reveal && !reveal.contains(form)) reveal.hidden = true;
          // A signup from the bar itself keeps its "you're in ✓" on screen.
          if (bar) killBar(!bar.contains(form));
        } else {
          toast(res?.status === 429 ? 'slow down a little' : 'that email looks off');
        }
      });
    });

    $('[data-digest-dismiss]')?.addEventListener('click', () => {
      if (reveal) reveal.hidden = true;
      remember('digest_dismissed');
    });

    /* The bar arrives once someone is past the first screen and leaves again at
       the top. Dismissed or subscribed → the listener is never attached. */
    if (bar && !remembered('digest_bar_dismissed') && !remembered('digest_subscribed')) {
      let queued = false;
      const syncBar = () => {
        queued = false;
        if (barOff) return;
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
      remember('digest_bar_dismissed');
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
