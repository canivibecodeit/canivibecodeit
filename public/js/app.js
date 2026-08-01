/* Can I Vibecode It? — interactions. No frameworks, on purpose. */
(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

  const track = (event, props) => window.posthog?.capture(event, props);

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

  /* ---------- search filter + chips ---------- */
  const search = $('#search');
  const rows = $$('#rows .row, #rows-rest .row');
  let activeCat = '';
  let activeVerdict = '';

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
    // Someone mid-search is looking for one app; an ad wedged into the results
    // is just noise. The banners come back when the filter clears.
    const filtering = !!q || !!activeCat || !!activeVerdict;
    $$('.sp-banner').forEach((b) => {
      b.style.display = filtering ? 'none' : '';
    });
  };

  $('#verdict-filter')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.vchip');
    if (!chip) return;
    activeVerdict = chip.dataset.verdict || '';
    $$('.vchip').forEach((c) => c.classList.toggle('active', c === chip));
    applyFilter();
    track('verdict_filter', { verdict: activeVerdict || 'all' });
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

  const renderDropdown = (q) => {
    if (!srBox) return;
    srActive = -1;
    if (!q) {
      srBox.classList.remove('open');
      search?.setAttribute('aria-expanded', 'false');
      return;
    }
    const hits = rowData.filter((r) => r.lower.includes(q));
    if (!hits.length) {
      srBox.classList.remove('open');
      search?.setAttribute('aria-expanded', 'false');
      return;
    }
    const top = hits.slice(0, 6);
    srBox.innerHTML =
      top
        .map(
          (r, i) => `<a class="sr-row" role="option" data-i="${i}" href="${r.href}">
            <img src="${r.icon}" alt="" width="20" height="20">
            <span class="sr-name">${r.name}</span>
            <span class="badge ${r.verdict}">${BADGE[r.verdict]}</span>
            <span class="sr-meta">${r.meta}</span>
          </a>`
        )
        .join('') +
      (hits.length > top.length
        ? `<a class="sr-foot" href="#death-list">↓ all ${hits.length} matches in the death list</a>`
        : '');
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
      const target = items[srActive >= 0 ? srActive : 0];
      if (target) location.href = target.getAttribute('href');
    }
  });
  document.addEventListener('click', (e) => {
    if (srBox && !e.target.closest('.search-wrap')) renderDropdown('');
  });

  // Chips are real links (SEO); on the homepage they filter in place instead.
  const chips = $('#chips');
  if (chips && rows.length) {
    chips.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip || !chip.hasAttribute('data-cat') || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      activeCat = chip.dataset.cat || '';
      $$('.chip', chips).forEach((c) => c.classList.toggle('active', c === chip));
      applyFilter();
      track('category_filter', { category: activeCat || 'all' });
    });
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
  if ($('#ticker')) setInterval(refreshStats, 30000);

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
    setInterval(refreshStrip, 60000);
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

  /* ---------- sponsors ---------- */
  $$('.sp-card, .sp-banner').forEach((el) =>
    el.addEventListener('click', () =>
      track('sponsor_slot_click', { slot: el.dataset.slot || 'none', state: el.dataset.state })
    )
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

  /* Coming back from Stripe with the back button restores this page from the
     bfcache exactly as it was left — mid-submit, so the card would sit on
     "opening checkout…" forever. Put every checkout card back how it started. */
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

  /* ---------- digest signup ---------- */
  const bar = $('#digest-bar');

  // Dismissing or signing up has to be permanent for the session: without this
  // the next scroll event is past the show threshold and puts the bar straight
  // back. The flag covers browsers that ignore the listener's abort signal.
  const barScroll = new AbortController();
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
})();
