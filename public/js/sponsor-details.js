/* Sponsor details form: live preview card, tint sampling, submit. External
   file (not inline) so the site's CSP script allowlist stays hash-free for
   everything except the theme snippet. Config rides in on the form's data
   attributes; this script must not assume any server-templated values. */
(() => {
  const form = document.querySelector('[data-sponsor-details]');
  if (!form) return;
  const defaultTint = form.dataset.defaultTint;
  const maxTag = Number(form.dataset.maxTag);
  const $ = (id) => document.getElementById(id);
  const card = $('sp-preview-card');
  const iconEl = $('sp-preview-icon');
  const tintEl = $('sp-tint');

  const channels = (hex) =>
    [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ');

  const setTint = (hex) => {
    tintEl.value = hex;
    card.style.setProperty('--tint', channels(hex));
  };

  /* Once the sponsor picks a colour it is theirs: editing the URL afterwards
     must not silently overwrite it with whatever the new icon samples to. */
  let userPicked = false;
  tintEl.addEventListener('input', () => {
    userPicked = true;
    card.style.setProperty('--tint', channels(tintEl.value));
  });

  /* The icon suggests the starting colour. Cross-origin images usually taint
     the canvas, and that's fine: the site green is a perfectly good default,
     and the sponsor can pick anything they like from here. */
  const sampleTint = (img) => {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 16;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 16, 16);
      const { data } = ctx.getImageData(0, 0, 16, 16);
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3];
        if (alpha < 128) continue;
        const max = Math.max(data[i], data[i + 1], data[i + 2]);
        const min = Math.min(data[i], data[i + 1], data[i + 2]);
        // Skip near-greys: they average out to mud and lose the brand colour.
        if (max - min < 24) continue;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        n++;
      }
      if (!n) return defaultTint;
      const hex = (v) => Math.round(v / n).toString(16).padStart(2, '0');
      return `#${hex(r)}${hex(g)}${hex(b)}`;
    } catch {
      return defaultTint;
    }
  };

  // Mirrors cleanUrl on the server: a bare "superx.so" is a URL.
  const withScheme = (v) => {
    const s = String(v || '').trim();
    return !s || /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  };

  // What you see is what gets submitted.
  const normalize = (el) => {
    const next = withScheme(el.value);
    if (next !== el.value) el.value = next;
  };

  const loadIcon = () => {
    const explicit = withScheme($('sp-logo').value);
    let src = explicit;
    if (!src) {
      try {
        src = `https://www.google.com/s2/favicons?domain=${new URL(withScheme($('sp-url').value)).hostname}&sz=64`;
      } catch {
        src = '';
      }
    }
    if (!src) return;
    const probe = new Image();
    probe.crossOrigin = 'anonymous';
    probe.onload = () => {
      iconEl.src = src;
      if (!userPicked) setTint(sampleTint(probe));
    };
    probe.onerror = () => {
      iconEl.src = src;
      if (!userPicked) setTint(defaultTint);
    };
    probe.src = src;
  };

  const syncText = () => {
    $('sp-preview-name').textContent = $('sp-name').value.trim() || 'your product';
    $('sp-preview-tag').textContent = $('sp-tagline').value.trim() || 'your one line here';
    $('sp-tag-count').textContent = `${$('sp-tagline').value.length}/${maxTag}`;
  };

  $('sp-name').addEventListener('input', syncText);
  $('sp-tagline').addEventListener('input', syncText);
  for (const id of ['sp-url', 'sp-logo']) {
    const el = $(id);
    el.addEventListener('blur', () => {
      normalize(el);
      loadIcon();
    });
    el.addEventListener('change', loadIcon);
  }
  syncText();
  loadIcon();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const msg = $('sp-msg');
    btn.disabled = true;
    const res = await fetch('/api/sponsor/details', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    }).catch(() => null);
    const data = await res?.json().catch(() => ({}));
    if (res?.ok) {
      msg.textContent = "sent. we review every sponsor by hand; you'll get an email either way.";
      msg.className = 'sp-form-msg ok';
      btn.textContent = 'update it';
    } else {
      msg.textContent = data?.error || 'something broke · try again';
      msg.className = 'sp-form-msg bad';
    }
    btn.disabled = false;
  });
})();
