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

  search?.addEventListener('input', applyFilter);
  search?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const visible = rows.filter((r) => r.style.display !== 'none');
    if (visible.length >= 1) visible[0].click();
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

      const agent = AGENTS[btn.dataset.agent];
      copyText(prompt); // best-effort backup; don't block the deeplink on it
      flashCopied(btn, 'opening…');
      toast(`opening ${agent.name} · prompt prefilled (and copied, just in case)`);
      const url = agent.link(prompt);
      if (agent.newTab) window.open(url, '_blank', 'noopener');
      else window.location.href = url;
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
