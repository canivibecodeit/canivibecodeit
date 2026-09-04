/* /submit — post the form, then poll the pipeline until it lands somewhere.
   Same ClientRouter contract as app.js: wiring happens per page visit via
   astro:page-load, timers are cleared on astro:before-swap so soft
   navigations don't leave a poll running against a page that's gone. */
(() => {
  let pollTimer = null;

  const stopPolling = () => {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  };

  const STATUS_LINES = {
    queued: 'queued · the bot picks it up in a second',
    drafting: 'drafting the entry with AI · takes about a minute',
    opening: 'draft validated · opening the pull request',
  };

  const init = () => {
    const form = document.getElementById('submit-form');
    if (!form || form.dataset.wired) return;
    form.dataset.wired = '1';

    const btn = document.getElementById('submit-go');
    const status = document.getElementById('submit-status');
    const statusText = document.getElementById('submit-status-text');
    const result = document.getElementById('submit-result');
    const resultText = document.getElementById('submit-result-text');
    const resultLink = document.getElementById('submit-result-link');
    const resultApp = document.getElementById('submit-result-app');

    /* The digest ask after a successful submission. app.js wires the card's
       form, one-click and dismiss; this only decides whether the moment has
       earned the ask (same keys app.js maintains — subscribed is permanent,
       dismissal is one shared 90-day clock). */
    const showDigestAsk = () => {
      try {
        if (localStorage.getItem('digest_subscribed')) return;
        if (localStorage.getItem('digest_dismissed') || localStorage.getItem('digest_bar_dismissed')) return;
        const at = Number(localStorage.getItem('digest_ask_dismissed'));
        if (at && Date.now() - at < 90 * 24 * 60 * 60 * 1000) return;
      } catch {}
      const r = document.getElementById('digest-reveal');
      if (!r || !r.hidden) return;
      r.hidden = false;
      requestAnimationFrame(() => r.classList.add('in'));
    };

    const showStatus = (line) => {
      result.hidden = true;
      status.hidden = false;
      statusText.textContent = line;
    };

    // All strings land via textContent; the one attribute (href) only accepts
    // URLs on the repo itself, however trusted the API response looks.
    const finish = ({ line, tone = 'ok', prUrl = null, appSlug = null }) => {
      stopPolling();
      status.hidden = true;
      result.hidden = false;
      result.dataset.tone = tone;
      resultText.textContent = line;
      const safePr =
        typeof prUrl === 'string' &&
        prUrl.startsWith('https://github.com/vibecodeit/vibecodeit/');
      resultLink.hidden = !safePr;
      if (safePr) resultLink.href = prUrl;
      const safeSlug = typeof appSlug === 'string' && /^[a-z0-9-]{1,60}$/.test(appSlug);
      resultApp.hidden = !safeSlug;
      if (safeSlug) {
        resultApp.href = `/${appSlug}`;
        resultApp.textContent = `see its page → /${appSlug}`;
      }
      btn.disabled = false;
    };

    const poll = (id) => {
      pollTimer = setTimeout(async () => {
        let data;
        try {
          const res = await fetch(`/api/submit?id=${encodeURIComponent(id)}`);
          data = await res.json();
        } catch {
          return poll(id); // transient network blip: keep waiting
        }
        const s = data.status;
        if (STATUS_LINES[s]) {
          showStatus(STATUS_LINES[s]);
          return poll(id);
        }
        if (s === 'done') {
          window.posthog?.capture('app_submitted');
          showDigestAsk();
          return finish({
            line: 'done. the entry is up as a pull request, a human reviews it before it goes live.',
            prUrl: data.prUrl,
          });
        }
        if (s === 'duplicate') {
          return finish({
            line: 'turns out this app is already in review.',
            prUrl: data.prUrl,
          });
        }
        if (s === 'rejected') {
          return finish({
            line: data.message || 'the bot decided this one does not belong on the list.',
            tone: 'bad',
          });
        }
        // failed / stalled / anything unexpected
        return finish({
          line: 'the pipeline choked on this one. try again later, or open the PR yourself via the link below.',
          tone: 'bad',
        });
      }, 3000);
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      const payload = {
        name: form.elements.name.value,
        url: form.elements.url.value,
        take: form.elements.take.value,
        submitter: form.elements.submitter.value,
        website: form.elements.website.value,
      };
      if (!payload.name.trim() || !payload.url.trim()) {
        return finish({ line: 'the app needs a name and a website.', tone: 'bad' });
      }
      btn.disabled = true;
      showStatus('checking the list for duplicates');
      let res, data;
      try {
        res = await fetch('/api/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        data = await res.json();
      } catch {
        return finish({ line: 'could not reach the server. try again in a minute.', tone: 'bad' });
      }
      if (res.status === 202 && data.id) {
        showStatus(STATUS_LINES.queued);
        return poll(data.id);
      }
      if (res.status === 409 && data.existingSlug) {
        return finish({
          line: 'good news: this app is already on the list.',
          appSlug: data.existingSlug,
        });
      }
      if (res.status === 409 && data.prUrl) {
        return finish({ line: data.error || 'already in review.', prUrl: data.prUrl });
      }
      return finish({
        line: data.error || 'something went sideways. try again in a minute.',
        tone: 'bad',
      });
    });
  };

  document.addEventListener('astro:page-load', init);
  document.addEventListener('astro:before-swap', stopPolling);
  init();
})();
