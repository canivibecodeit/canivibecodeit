/* Tiny dithered-chart engine. Zero dependencies, one <canvas> per chart.
   Bayer-matrix ordered dithering gives fills their CRT texture — which also
   doubles as the non-color encoding for prints and colorblind readers.
   Theme-aware (reads CSS custom properties), DPR-aware, hover tooltips. */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const BAYER = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ];

  const cssVar = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const theme = () => ({
    ink: cssVar('--fg'),
    muted: cssVar('--muted'),
    grid: cssVar('--border'),
    data: cssVar('--primary'),
    surface: cssVar('--surface'),
  });

  const hexRgb = (hex) => {
    const h = hex.replace('#', '');
    const v = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
    return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
  };

  const fmt = (n) => Number(n).toLocaleString('en-US');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* shared tooltip */
  let tip;
  const tooltip = (html, x, y) => {
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'chart-tip';
      document.body.appendChild(tip);
    }
    tip.innerHTML = html;
    tip.style.display = 'block';
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(x + 14, innerWidth - r.width - 10)}px`;
    tip.style.top = `${Math.max(y - r.height - 12, 8)}px`;
  };
  const hideTip = () => tip && (tip.style.display = 'none');

  function setupCanvas(canvas) {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    return { ctx, w, h };
  }

  /* Dithered fill: paint cell-by-cell through the Bayer threshold matrix.
     density 0..1 decides how many cells light up; cell = dot pitch in px. */
  function ditherRect(ctx, x, y, w, h, rgb, density, cell = 3) {
    ctx.fillStyle = `rgb(${rgb.join(',')})`;
    const x0 = Math.floor(x / cell), x1 = Math.ceil((x + w) / cell);
    const y0 = Math.floor(y / cell), y1 = Math.ceil((y + h) / cell);
    for (let cy = y0; cy < y1; cy++) {
      for (let cx = x0; cx < x1; cx++) {
        if (BAYER[cy & 3][cx & 3] / 16 < density) {
          ctx.fillRect(cx * cell, cy * cell, cell - 1, cell - 1);
        }
      }
    }
  }

  /* ---------- area chart ---------- */
  function areaChart(canvas, points, opts = {}) {
    const t = theme();
    const rgb = hexRgb(t.data);
    const { ctx, w, h } = setupCanvas(canvas);
    const PAD = { l: 44, r: 10, t: 12, b: 24 };
    const iw = w - PAD.l - PAD.r;
    const ih = h - PAD.t - PAD.b;
    const max = Math.max(1, ...points.map((p) => p.v));
    const nice = Math.ceil(max / 4) * 4;
    const X = (i) => PAD.l + (i / Math.max(1, points.length - 1)) * iw;
    const Y = (v) => PAD.t + ih - (v / nice) * ih;

    const draw = (progress = 1) => {
      ctx.clearRect(0, 0, w, h);
      ctx.font = '10px "JetBrains Mono Variable", monospace';
      ctx.fillStyle = t.muted;
      ctx.strokeStyle = t.grid;
      ctx.lineWidth = 1;

      for (let g = 0; g <= 4; g++) {
        const gy = PAD.t + (ih / 4) * g;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(PAD.l, gy);
        ctx.lineTo(w - PAD.r, gy);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.textAlign = 'right';
        ctx.fillText(fmt(nice - (nice / 4) * g), PAD.l - 8, gy + 3);
      }

      ctx.textAlign = 'center';
      const step = Math.ceil(points.length / 5);
      points.forEach((p, i) => {
        if (i % step === 0) ctx.fillText(p.label, X(i), h - 8);
      });

      const upto = Math.max(2, Math.floor(points.length * progress));
      const visible = points.slice(0, upto);

      /* dithered fill under the line, density fading downward */
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(X(0), Y(0 * 0) + ih + PAD.t);
      ctx.moveTo(X(0), PAD.t + ih);
      visible.forEach((p, i) => ctx.lineTo(X(i), Y(p.v)));
      ctx.lineTo(X(visible.length - 1), PAD.t + ih);
      ctx.closePath();
      ctx.clip();
      const bands = 6;
      for (let b = 0; b < bands; b++) {
        const density = 0.55 * (1 - b / bands) + 0.06;
        ditherRect(ctx, PAD.l, PAD.t + (ih / bands) * b, iw, ih / bands + 1, rgb, density);
      }
      ctx.restore();

      /* the line itself, crisp */
      ctx.strokeStyle = t.data;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      visible.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p.v)) : ctx.moveTo(X(i), Y(p.v))));
      ctx.stroke();

      const last = visible[visible.length - 1];
      ctx.fillStyle = t.data;
      ctx.beginPath();
      ctx.arc(X(visible.length - 1), Y(last.v), 3.5, 0, Math.PI * 2);
      ctx.fill();
    };

    if (reduced) draw(1);
    else {
      const t0 = performance.now();
      const tick = (now) => {
        const p = Math.min(1, (now - t0) / 650);
        draw(1 - Math.pow(1 - p, 3));
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    canvas.onmousemove = (e) => {
      const r = canvas.getBoundingClientRect();
      const i = Math.round(((e.clientX - r.left - PAD.l) / iw) * (points.length - 1));
      if (i < 0 || i >= points.length) return hideTip();
      const p = points[i];
      draw(1);
      const t2 = theme();
      ctx.strokeStyle = t2.muted;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(X(i), PAD.t);
      ctx.lineTo(X(i), PAD.t + ih);
      ctx.stroke();
      ctx.setLineDash([]);
      tooltip(
        `<b>${p.full}</b><br>${fmt(p.v)} ${opts.unit || 'views'}${p.extra ? `<br><span>${p.extra}</span>` : ''}`,
        e.clientX,
        e.clientY
      );
    };
    canvas.onmouseleave = () => {
      hideTip();
      draw(1);
    };

    return { redraw: () => draw(1) };
  }

  /* ---------- horizontal bars ---------- */
  function barChart(canvas, rows, opts = {}) {
    const t = theme();
    const rgb = hexRgb(t.data);
    const { ctx, w, h } = setupCanvas(canvas);
    const ROW = h / Math.max(1, rows.length);
    const BAR = Math.min(16, ROW * 0.44);
    const LABEL_W = opts.labelWidth ?? 130;
    const max = Math.max(1, ...rows.map((r) => r.n));
    const iw = w - LABEL_W - 54;

    const draw = (progress = 1) => {
      ctx.clearRect(0, 0, w, h);
      ctx.font = '11px "JetBrains Mono Variable", monospace';
      rows.forEach((r, i) => {
        const y = i * ROW + ROW / 2;
        const bw = Math.max(2, (r.n / max) * iw * progress);
        ctx.fillStyle = t.muted;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const label = r.label.length > 18 ? r.label.slice(0, 17) + '…' : r.label;
        ctx.fillText(label, 0, y);
        ditherRect(ctx, LABEL_W, y - BAR / 2, bw, BAR, rgb, 0.45, 2);
        ctx.fillStyle = t.data;
        ctx.fillRect(LABEL_W + bw - 3, y - BAR / 2, 3, BAR);
        ctx.fillStyle = t.ink;
        ctx.fillText(fmt(r.n), LABEL_W + bw + 8, y);
      });
    };

    if (reduced) draw(1);
    else {
      const t0 = performance.now();
      const tick = (now) => {
        const p = Math.min(1, (now - t0) / 550);
        draw(1 - Math.pow(1 - p, 3));
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    canvas.onmousemove = (e) => {
      const r = canvas.getBoundingClientRect();
      const i = Math.floor((e.clientY - r.top) / ROW);
      if (i < 0 || i >= rows.length) return hideTip();
      tooltip(`<b>${rows[i].label}</b><br>${fmt(rows[i].n)} ${opts.unit || ''}`, e.clientX, e.clientY);
    };
    canvas.onmouseleave = hideTip;

    return { redraw: () => draw(1) };
  }

  /* ---------- bootstrap the /stats page ---------- */
  const mount = () => {
    const dataEl = $('#dash-data');
    if (!dataEl) return;
    let data;
    try {
      data = JSON.parse(dataEl.textContent);
    } catch {
      return;
    }
    if (!data || data.unavailable) return;

    const charts = [];
    const dayLabel = (iso) => {
      const d = new Date(iso + 'T00:00:00Z');
      return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
    };
    const fullLabel = (iso) =>
      new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', {
        weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
      });

    const areaEl = $('#chart-views');
    if (areaEl && data.byDay?.length > 1) {
      charts.push(
        areaChart(
          areaEl,
          data.byDay.map((r) => ({
            v: r.views,
            label: dayLabel(r.d),
            full: fullLabel(r.d),
            extra: `${fmt(r.visitors)} visitors`,
          })),
          { unit: 'views' }
        )
      );
    }

    const AGENT_NAMES = {
      'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', raw: 'raw copy',
      unknown: 'unknown',
    };
    const pairs = [
      ['#chart-pages', data.pages?.map((r) => ({ label: r.p, n: r.n })), 'views · 7d', 150],
      ['#chart-agents', data.agents?.map((r) => ({ label: AGENT_NAMES[r.a] || r.a, n: r.n })), 'copies · 7d', 110],
      ['#chart-prompts', data.topPrompts?.map((r) => ({ label: r.app, n: r.n })), 'copies · 7d', 110],
    ];
    for (const [sel, rows, unit, labelWidth] of pairs) {
      const el = $(sel);
      if (el && rows?.length) charts.push(barChart(el, rows, { unit, labelWidth }));
    }

    /* redraw on theme flip or resize */
    new MutationObserver(() => charts.forEach((c) => c.redraw())).observe(
      document.documentElement,
      { attributes: true, attributeFilter: ['data-theme'] }
    );
    let rt;
    addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => location.reload(), 400);
    });
  };

  document.readyState === 'loading'
    ? addEventListener('DOMContentLoaded', mount)
    : mount();
})();
