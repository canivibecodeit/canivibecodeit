/* Can I Vibecode It? — interactions. No frameworks, on purpose. */
(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

  const track = (event, props) => window.posthog?.capture(event, props);

  /* ---------- external links open in a new tab ---------- */
  $$('a[href]').forEach((a) => {
    if (/^https?:/.test(a.href) && a.hostname !== location.hostname) {
      a.target = '_blank';
      a.rel = 'noopener';
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

  window.CanIVibecodeIt = {
    ...(window.CanIVibecodeIt || {}),
    toast,
    track,
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
    href: $('.row-link', r)?.getAttribute('href'),
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
      if (!chip || e.metaKey || e.ctrlKey) return;
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

  const launchAgent = (agentId, prompt) => {
    const agent = AGENTS[agentId];
    if (!agent) return false;
    copyText(prompt);
    toast(`opening ${agent.name} · prompt prefilled (and copied, just in case)`);
    const url = agent.link(prompt);
    if (agent.newTab) window.open(url, '_blank', 'noopener');
    else window.location.href = url;
    return true;
  };

  Object.assign(window.CanIVibecodeIt, { copyText, launchAgent });

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

  $$('.copy-group').forEach((group) => {
    const slug = group.dataset.slug;
    group.addEventListener('click', async (e) => {
      const btn = e.target.closest('.copy-btn');
      if (!btn) return;
      const prompt = $('#prompt-text')?.textContent || '';

      if (btn.dataset.agent === 'raw') {
        if (await copyText(prompt)) {
          flashCopied(btn);
          toast('prompt copied · paste it into any agent');
        } else {
          toast('copy failed · select the text manually');
        }
        track('copy_prompt', { app: slug, agent: 'raw' });
        return;
      }

      flashCopied(btn, 'opening…');
      launchAgent(btn.dataset.agent, prompt);
      track('copy_prompt', { app: slug, agent: btn.dataset.agent });
    });
  });

  /* ---------- vote (toggles: click again to take it back) ---------- */
  const voteLabel = (btn, voted) => {
    const text = btn.childNodes[0];
    if (text?.nodeType === 3) text.textContent = voted ? '✓ replaced it · ' : 'I replaced this · ';
    btn.classList.toggle('is-voted', voted);
    btn.title = voted ? 'click to take your vote back' : '';
  };

  const replacementVoteKey = (slug) => `voted:${slug}`;
  const isReplacementVoted = (slug) => {
    try {
      return !!localStorage.getItem(replacementVoteKey(slug));
    } catch {
      return false;
    }
  };
  const rememberReplacementVote = (slug, voted) => {
    try {
      if (voted) localStorage.setItem(replacementVoteKey(slug), '1');
      else localStorage.removeItem(replacementVoteKey(slug));
      return true;
    } catch {
      return false;
    }
  };
  const renderReplacementVote = (slug, voted, count) => {
    $$(`[data-vote="${slug}"]`).forEach((btn) => voteLabel(btn, voted));
    if (count !== undefined && count !== null) {
      $$(`[data-votes="${slug}"]`).forEach((el) => (el.textContent = count));
    }
  };

  // Serialise operations per app so a quick replace/unreplace sequence cannot
  // leave the public count and the device-local status pointing different ways.
  const replacementVoteOps = new Map();
  const setReplacementVote = (slug, replaced) => {
    const previous = replacementVoteOps.get(slug) || Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        const voted = isReplacementVoted(slug);
        if (voted === replaced) {
          renderReplacementVote(slug, replaced);
          return { ok: true, changed: false };
        }

        try {
          const res = await fetch(`/api/vote/${slug}`, {
            method: replaced ? 'POST' : 'DELETE',
          });
          // A missing local marker can still represent a vote already counted
          // for this IP. Treat that response as reconciled, as the existing
          // vote control has always done.
          if (replaced && res.status === 429) {
            rememberReplacementVote(slug, true);
            renderReplacementVote(slug, true);
            return { ok: true, changed: false, alreadyCounted: true };
          }
          if (!res.ok) return { ok: false };

          const { count } = await res.json();
          rememberReplacementVote(slug, replaced);
          renderReplacementVote(slug, replaced, count);
          return { ok: true, changed: true, count };
        } catch {
          return { ok: false };
        }
      });

    replacementVoteOps.set(slug, operation);
    operation.finally(() => {
      if (replacementVoteOps.get(slug) === operation) replacementVoteOps.delete(slug);
    });
    return operation;
  };

  Object.assign(window.CanIVibecodeIt, { isReplacementVoted, setReplacementVote });

  $$('[data-vote]').forEach((btn) => {
    const slug = btn.dataset.vote;
    if (isReplacementVoted(slug)) voteLabel(btn, true);

    btn.addEventListener('click', async () => {
      const voted = isReplacementVoted(slug);
      btn.classList.remove('voted');
      void btn.offsetWidth; // restart animation
      btn.classList.add('voted');
      const result = await setReplacementVote(slug, !voted);
      if (!result.ok) {
        toast('something broke · try again');
        return;
      }

      window.MyStack?.setReplacement(slug, !voted);
      if (voted) {
        toast('vote taken back · target returned to your stack');
        track('unvote', { app: slug });
      } else if (result.alreadyCounted) {
        toast('already counted · marked replaced in your stack');
      } else {
        toast('☠ counted · subscription eliminated in your stack');
        track('vote', { app: slug });
      }
    });
  });

  // Reconcile pre-existing local state when an app detail page is visited.
  // This backfills at most the app currently on screen, avoiding burst writes.
  document.addEventListener('stack:ready', async (event) => {
    const statuses = new Map(
      (event.detail?.state?.items || []).map((item) => [item.slug, item.status])
    );
    for (const btn of $$('[data-vote]')) {
      const slug = btn.dataset.vote;
      if (isReplacementVoted(slug)) {
        window.MyStack?.setReplacement(slug, true);
      } else if (statuses.get(slug) === 'replaced') {
        const result = await setReplacementVote(slug, true);
        if (result.ok) track('vote_reconciled_from_stack', { app: slug });
      }
    }
  });

  /* ---------- share ---------- */
  $$('[data-share]').forEach((a) =>
    a.addEventListener('click', () => track('share', { app: a.dataset.share }))
  );

  /* ---------- waitlist ---------- */
  $$('form[data-waitlist]').forEach((form) => {
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
        toast("on the list — you'll hear about the scanner first");
        track('waitlist_signup');
      } else {
        toast(res?.status === 429 ? 'slow down a little' : 'that email looks off');
      }
    });
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
