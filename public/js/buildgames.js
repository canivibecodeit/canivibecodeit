/* The Build Games: the pot fills, the figure counts, the clock ticks. All
   progressive — the page reads fine server-rendered without any of it.
   Follows the same ClientRouter contract as the other page scripts. */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const claim = (el) => {
    if (!el || el.dataset.bgBound) return null;
    el.dataset.bgBound = '1';
    return el;
  };

  let toastTimer;
  const toast = (msg) => {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  };

  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  const fmtUsd = (cents) => '$' + Math.round(cents / 100).toLocaleString('en-US');

  const init = () => {
    /* ---------- countdown (tabular, no jitter) ----------
       data-cd-pad = zero-padded two-digit segments (the game-ends clock);
       [data-cd-sec-cell] = seconds hidden until the final 24 hours. */
    const cd = claim($('[data-countdown]'));
    if (cd) {
      const target = Number(cd.dataset.target);
      const fmt = 'cdPad' in cd.dataset ? (n) => String(n).padStart(2, '0') : (n) => n;
      const d = $('[data-cd-days]', cd);
      const h = $('[data-cd-hours]', cd);
      const m = $('[data-cd-mins]', cd);
      const sec = $('[data-cd-secs]', cd);
      const secCell = $('[data-cd-sec-cell]', cd);
      // Reload only when zero is crossed while the tab is open. A page that
      // loads with the target already past would otherwise reload forever.
      const armed = target > Date.now();
      const tick = () => {
        const s = Math.max(0, Math.floor((target - Date.now()) / 1000));
        if (d) d.textContent = fmt(Math.floor(s / 86400));
        if (h) h.textContent = fmt(Math.floor((s % 86400) / 3600));
        if (m) m.textContent = fmt(Math.floor((s % 3600) / 60));
        if (sec) sec.textContent = fmt(s % 60);
        if (secCell) secCell.hidden = s >= 86400;
        if (s === 0 && armed && !cd.dataset.done) {
          cd.dataset.done = '1';
          setTimeout(() => location.reload(), 1500);
        }
      };
      tick();
      setInterval(tick, 1000);
    }

    /* ---------- the pool number: count-up on load + live poll ----------
       The number ([data-pot-amount]) exists in BOTH phases (pre-game orb
       readout, game-phase stat strip); the orb ([data-pot]) is pre-game
       only, so every orb behaviour is guarded and the poll runs without it. */
    const amountEl = claim($('[data-pot-amount]'));
    if (amountEl) {
      const stage = $('[data-pot]');
      const fillEls = [$('.bg-fill'), $('.bg-fill-top')].filter(Boolean);
      const drops = stage ? $('.bg-drops', stage) : null;
      // The server computes the asymptotic fill level (uncapped, never 100%);
      // the JS just applies it and re-applies on poll. No goal math here.
      let potCents = Number(stage?.dataset.potCents ?? amountEl.dataset.potCents) || 0;
      let fillTarget = Number(stage?.dataset.fill) || 0;

      const setFill = (frac) => {
        if (!stage) return;
        const f = Math.max(0, Math.min(1, frac));
        stage.style.setProperty('--fill', f.toFixed(4));
        fillEls.forEach((el) => el.style.setProperty('--fill', f.toFixed(4)));
      };
      setFill(fillTarget);

      // On first load: figure counts up from zero, fill rises from empty.
      if (amountEl && !reduced()) {
        const t0 = performance.now();
        const DUR = 1100;
        const step = (t) => {
          const p = Math.min(1, (t - t0) / DUR);
          const eased = 1 - Math.pow(1 - p, 3);
          amountEl.textContent = fmtUsd(potCents * eased);
          if (p < 1) requestAnimationFrame(step);
          else amountEl.textContent = fmtUsd(potCents);
        };
        setFill(0);
        requestAnimationFrame(() => setFill(fillTarget));
        requestAnimationFrame(step);
      }

      // Bills fall INSIDE the orb (SVG rects, clipped to the sphere) when the
      // pool grows. Animated via the Web Animations API so it works on SVG.
      const rain = (n) => {
        if (!drops || reduced()) return;
        for (let i = 0; i < n; i += 1) {
          const bill = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          bill.setAttribute('class', 'bg-drop');
          bill.setAttribute('x', String(120 + Math.random() * 60));
          bill.setAttribute('y', '150');
          bill.setAttribute('width', '24');
          bill.setAttribute('height', '11');
          bill.setAttribute('rx', '1.5');
          drops.appendChild(bill);
          const spin = 180 + Math.random() * 180;
          bill.animate(
            [
              { transform: 'translateY(0) rotate(0deg)', opacity: 0.95 },
              { transform: `translateY(210px) rotate(${spin}deg)`, opacity: 0 },
            ],
            { duration: 750 + Math.random() * 250, delay: i * 60, easing: 'cubic-bezier(0.4,0,0.7,1)', fill: 'forwards' }
          ).finished.then(() => bill.remove()).catch(() => bill.remove());
        }
      };

      // A poke rains a few bills — satisfying, free, and honest (the total
      // never changes). Reduced-motion users get stillness via rain()'s gate.
      if (stage) stage.addEventListener('click', () => rain(4));

      // Poll: when the pot grows, count the figure up (and, orb present,
      // raise the fill and rain bills).
      setInterval(async () => {
        if (document.hidden || !document.contains(amountEl)) return;
        try {
          const res = await fetch('/api/thebuildgames/stats');
          if (!res.ok) return;
          const data = await res.json();
          // Live "here right now" figure rides the same poll.
          const onlineEl = $('[data-bg-online]');
          if (onlineEl && typeof data.online === 'number') onlineEl.textContent = data.online;
          if (typeof data.pot_cents !== 'number' || data.pot_cents === potCents) return;
          const grew = data.pot_cents > potCents;
          const from = potCents;
          potCents = data.pot_cents;
          if (typeof data.fill === 'number') setFill(data.fill);
          if (amountEl && !reduced()) {
            const t0 = performance.now();
            const DUR = 700;
            const step = (t) => {
              const p = Math.min(1, (t - t0) / DUR);
              const eased = 1 - Math.pow(1 - p, 3);
              amountEl.textContent = fmtUsd(from + (potCents - from) * eased);
              if (p < 1) requestAnimationFrame(step);
              else amountEl.textContent = fmtUsd(potCents);
            };
            requestAnimationFrame(step);
          } else if (amountEl) {
            amountEl.textContent = fmtUsd(potCents);
          }
          if (grew) rain(6);
        } catch {
          /* next poll gets another chance */
        }
      }, 30000);
    }

    /* ---------- bid form: reveal + submit ---------- */
    // The "add a tagline, icon or email" link opens the FULL form — selected
    // explicitly, never first-match (the claim bar is also a [data-bid-form]).
    const bidOpen = claim($('[data-bid-open]'));
    if (bidOpen) {
      const form = $('[data-bid-form][data-collapsible]');
      bidOpen.addEventListener('click', (e) => {
        e.preventDefault();
        if (!form) return;
        form.hidden = !form.hidden;
        if (!form.hidden) {
          form.scrollIntoView({ block: 'center', behavior: 'smooth' });
          form.querySelector('input[name="link"]').focus();
        }
      });
    }

    // "take the top spot": one URL field, amount pre-locked to the cost of #1.
    const topOpen = claim($('[data-top-open]'));
    if (topOpen) {
      const form = $('[data-top-form]');
      topOpen.addEventListener('click', () => {
        if (!form) return;
        form.hidden = !form.hidden;
        if (!form.hidden) form.querySelector('input[name="link"]').focus();
      });
    }
    // One submit path, two forms: the top claim bar and the full form below
    // post the same fields to the same endpoint, and the only difference is
    // which optional inputs exist in the DOM. One handler means the money path
    // has a single client implementation instead of two that drift apart.
    $$('[data-bid-form]').forEach((rawForm) => {
      const bidForm = claim(rawForm);
      if (!bidForm) return;
      bidForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('button[type="submit"]', bidForm);
        const label = btn.textContent;
        const err = $('[data-bid-err]', bidForm);
        err.hidden = true;
        btn.disabled = true;
        btn.textContent = 'starting checkout…';
        try {
          const fd = new FormData(bidForm);
          const amountCents = Math.round(Number(fd.get('amount_dollars')) * 100);
          const icon = fd.get('icon');
          const hasIcon = icon && typeof icon === 'object' && icon.size > 0;
          let res;
          if (hasIcon) {
            // Multipart only when there's a file to carry.
            fd.set('amount_cents', String(amountCents));
            fd.delete('amount_dollars');
            res = await fetch(bidForm.action, { method: 'POST', body: fd });
          } else {
            const data = Object.fromEntries(fd.entries());
            res = await fetch(bidForm.action, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                link: data.link,
                tagline: data.tagline,
                amount_cents: amountCents,
                email: data.email,
                email_optin: data.email_optin,
                website: data.website,
              }),
            });
          }
          const out = await res.json().catch(() => ({}));
          if (!res.ok) {
            err.textContent = out.error || 'something broke — try again';
            err.hidden = false;
            return;
          }
          if (out.url) {
            // Off to Stripe; the webhook lists the placement when payment lands.
            window.location.href = out.url;
            return;
          }
          toast(out.message || 'bid placed');
          bidForm.reset();
          // Only the collapsible full form folds away again; the claim bar is
          // permanent furniture and has to stay on screen.
          if (bidForm.dataset.collapsible) bidForm.hidden = true;
        } catch {
          err.textContent = 'network hiccup — try again';
          err.hidden = false;
        } finally {
          btn.disabled = false;
          btn.textContent = label;
        }
      });
    });

    /* ---------- entry form (game phase): submit, then to the edit page ---------- */
    const entryForm = claim($('[data-entry-form]'));
    if (entryForm) {
      /* Draft persistence: a mid-fill navigation (terms link, back button,
         mobile tab discard) must never eat a half-filled entry. Text fields
         only, sessionStorage only (per-tab, dies with the session), cleared
         on successful submit. */
      const DRAFT_KEY = 'bg-entry-draft';
      const DRAFT_FIELDS = ['name', 'handle', 'demo_url', 'repo_url', 'blurb', 'email'];
      try {
        const saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || '{}');
        DRAFT_FIELDS.forEach((f) => {
          const el = entryForm.elements[f];
          if (el && !el.value && typeof saved[f] === 'string') el.value = saved[f];
        });
      } catch {
        /* a broken draft never blocks the form */
      }
      entryForm.addEventListener('input', (e) => {
        if (!DRAFT_FIELDS.includes(e.target?.name)) return;
        const draft = {};
        DRAFT_FIELDS.forEach((f) => {
          const el = entryForm.elements[f];
          if (el) draft[f] = el.value;
        });
        try {
          sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
        } catch {
          /* storage full/blocked: the form still works, just no belt */
        }
      });

      entryForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('button[type="submit"]', entryForm);
        const label = btn.textContent;
        const err = $('[data-entry-err]', entryForm);
        err.hidden = true;
        btn.disabled = true;
        btn.textContent = 'submitting…';
        try {
          const data = Object.fromEntries(new FormData(entryForm).entries());
          const res = await fetch(entryForm.action, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
          });
          const out = await res.json().catch(() => ({}));
          if (!res.ok) {
            err.textContent = out.error || 'something broke — try again';
            err.hidden = false;
            return;
          }
          if (out.token) {
            try {
              sessionStorage.removeItem(DRAFT_KEY);
            } catch {
              /* draft cleanup is best-effort */
            }
            // The success screen IS the edit page (private, noindex).
            window.location.href = '/thebuildgames/entry?token=' + encodeURIComponent(out.token) + '&submitted=1';
            return;
          }
          toast('entry received');
          entryForm.reset();
        } catch {
          err.textContent = 'network hiccup — try again';
          err.hidden = false;
        } finally {
          btn.disabled = false;
          btn.textContent = label;
        }
      });
    }

    /* ---------- the claim bar: pick a spot, see its price ---------- */
    // Two controls over one number. `cents` is the state; the spot label is
    // always DERIVED from it, never asserted, so the bar can't offer a spot
    // the money wouldn't actually buy. Nothing here is authoritative — the
    // server re-derives every floor and the board re-ranks on cleared totals —
    // so this is a calculator, and the note under it says exactly that.
    const claimBar = claim($('[data-claim]'));
    if (claimBar) {
      let totals = [];
      try {
        totals = JSON.parse(claimBar.dataset.totals || '[]');
      } catch {
        totals = [];
      }
      const STEP = Number(claimBar.dataset.step) || 25000;
      const MIN = Number(claimBar.dataset.min) || 50000;
      const MAX = Number(claimBar.dataset.max) || 1500000;
      // The first unclaimed spot: everything above it is someone else's to beat.
      const OPEN = Math.max(1, Number(claimBar.dataset.openRank) || totals.length + 1);

      const rankEl = $('[data-claim-rank]', claimBar);
      const amtEl = $('[data-claim-amt]', claimBar);
      const amountInput = $('[data-claim-amount]', claimBar);
      const rankDn = $('[data-rank-dn]', claimBar);
      const rankUp = $('[data-rank-up]', claimBar);
      const amtDn = $('[data-amt-dn]', claimBar);
      const amtUp = $('[data-amt-up]', claimBar);

      // What a payment of `cents` actually buys. A tie does NOT take the spot
      // (the board breaks ties on who cleared first), so `>=` is deliberate:
      // it under-promises rather than over-promises.
      const rankOf = (cents) => totals.filter((t) => t >= cents).length + 1;
      // Beat whoever holds spot n, floored at the entry minimum the API
      // enforces for a link's first appearance and capped at the per-payment
      // ceiling. Mirrors the server's arithmetic.
      const costOf = (n) => {
        const held = totals[n - 1];
        return held == null ? MIN : Math.min(MAX, Math.max(MIN, held + STEP));
      };

      // Only spots that a SINGLE payment can genuinely take. Where two
      // sponsors sit closer together than one increment, the money for the
      // lower spot would actually land you higher — so that rung is dropped
      // instead of being advertised as something it isn't. Same for a leader
      // sitting at the per-payment ceiling: unbeatable in one go, so not
      // offered.
      const rungs = [];
      for (let n = 1; n <= OPEN; n += 1) {
        const c = costOf(n);
        if (rankOf(c) === n) rungs.push({ rank: n, cents: c });
      }
      if (!rungs.length) rungs.push({ rank: rankOf(MIN), cents: MIN });

      let cents = rungs[0].cents;

      const render = () => {
        const rank = rankOf(cents);
        const at = rungs.findIndex((r) => r.rank === rank);
        if (rankEl) rankEl.textContent = '#' + rank;
        if (amtEl) amtEl.textContent = fmtUsd(cents);
        // The server takes whole dollars; round UP so the rounding can never
        // land the buyer a cent short of the spot the bar just promised.
        if (amountInput) amountInput.value = String(Math.ceil(cents / 100));
        if (rankDn) rankDn.disabled = at <= 0;
        if (rankUp) rankUp.disabled = at < 0 || at >= rungs.length - 1;
        if (amtDn) amtDn.disabled = cents <= MIN;
        if (amtUp) amtUp.disabled = cents >= MAX;
      };

      const setCents = (next) => {
        cents = Math.min(MAX, Math.max(MIN, Math.round(next)));
        render();
      };
      // The spot stepper walks the rungs; + is a lower (cheaper) spot.
      const stepRank = (dir) => {
        const at = rungs.findIndex((r) => r.rank === rankOf(cents));
        const to = at < 0 ? 0 : Math.min(rungs.length - 1, Math.max(0, at + dir));
        setCents(rungs[to].cents);
      };

      if (rankDn) rankDn.addEventListener('click', () => stepRank(-1));
      if (rankUp) rankUp.addEventListener('click', () => stepRank(1));
      // Money moves on the increment grid so repeated taps stay on round numbers.
      if (amtDn) amtDn.addEventListener('click', () => setCents(Math.ceil(cents / STEP) * STEP - STEP));
      if (amtUp) amtUp.addEventListener('click', () => setCents(Math.floor(cents / STEP) * STEP + STEP));

      render();
    }

    /* ---------- outbound click beacons (board rows) ---------- */
    $$('[data-bg-out]').forEach((raw) => {
      const a = claim(raw);
      if (!a) return;
      a.addEventListener('click', () => {
        try {
          navigator.sendBeacon('/api/thebuildgames/click', JSON.stringify({ id: a.dataset.bgOut }));
        } catch {
          /* the navigation always wins */
        }
      });
    });

    /* ---------- back from Stripe: say what happened, once ---------- */
    const paid = new URLSearchParams(location.search).get('paid');
    if (paid !== null && !document.body.dataset.bgPaidToast) {
      document.body.dataset.bgPaidToast = '1';
      toast(paid === '1' ? 'payment received · your placement lists in a moment' : 'checkout cancelled — nothing was charged');
      history.replaceState(null, '', location.pathname);
      if (paid === '1') setTimeout(() => location.reload(), 4000);
    }
  };

  init();
  document.addEventListener('astro:page-load', init);
})();
