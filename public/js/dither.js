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
     density 0..1 decides how many cells light up; cell = dot pitch in px.
     boost(px, py) optionally adds cursor-reactive density per cell. */
  function ditherRect(ctx, x, y, w, h, rgb, density, cell = 3, boost) {
    ctx.fillStyle = `rgb(${rgb.join(',')})`;
    const x0 = Math.floor(x / cell), x1 = Math.ceil((x + w) / cell);
    const y0 = Math.floor(y / cell), y1 = Math.ceil((y + h) / cell);
    for (let cy = y0; cy < y1; cy++) {
      for (let cx = x0; cx < x1; cx++) {
        const d = boost ? Math.min(0.96, density + boost(cx * cell, cy * cell)) : density;
        if (BAYER[cy & 3][cx & 3] / 16 < d) {
          ctx.fillRect(cx * cell, cy * cell, cell - 1, cell - 1);
        }
      }
    }
  }

  /* Cursor aura: gaussian falloff that breathes and ripples outward, so the
     dots near the pointer wake up like a wave. */
  const aura = (mx, my, t) => (px, py) => {
    const dx = px - mx, dy = (py - my) * 1.6;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const ripple = 1 + 0.25 * Math.sin(dist / 14 - t / 180);
    return 0.85 * Math.exp(-(dist * dist) / (2 * 70 * 70)) * ripple * (0.85 + 0.15 * Math.sin(t / 320));
  };

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

    const draw = (progress = 1, cursor = null) => {
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
      const boost = cursor ? aura(cursor.x, cursor.y, cursor.t) : null;

      /* Elastic geometry: the curve pulls toward the cursor with a wide
         gaussian reach, and a ripple cascades outward through the whole
         line. amp eases in/out so enter/leave feel springy, not snappy. */
      const ys = visible.map((p, i) => {
        let y = Y(p.v);
        if (cursor && cursor.amp > 0.001) {
          const dx = X(i) - cursor.x;
          const reach = Math.exp(-(dx * dx) / (2 * (iw / 4) * (iw / 4)));
          const pull = (cursor.y - y) * 0.35 * reach;
          const ripple =
            7 * Math.sin(dx / 24 - cursor.t / 150) * Math.exp(-Math.abs(dx) / (iw * 0.6));
          y += (pull + ripple) * cursor.amp;
          y = Math.max(PAD.t + 2, Math.min(PAD.t + ih - 1, y));
        }
        return y;
      });

      /* dithered fill under the (displaced) line, density fading downward */
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(X(0), PAD.t + ih);
      ys.forEach((y, i) => ctx.lineTo(X(i), y));
      ctx.lineTo(X(visible.length - 1), PAD.t + ih);
      ctx.closePath();
      ctx.clip();
      const bands = 6;
      for (let b = 0; b < bands; b++) {
        const density = 0.55 * (1 - b / bands) + 0.06;
        ditherRect(ctx, PAD.l, PAD.t + (ih / bands) * b, iw, ih / bands + 1, rgb, density, 3, boost);
      }
      ctx.restore();

      /* the line itself, crisp, riding the displaced geometry */
      ctx.strokeStyle = t.data;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ys.forEach((y, i) => (i ? ctx.lineTo(X(i), y) : ctx.moveTo(X(i), y)));
      ctx.stroke();

      ctx.fillStyle = t.data;
      ctx.beginPath();
      ctx.arc(X(visible.length - 1), ys[ys.length - 1], 3.5, 0, Math.PI * 2);
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

    /* live cursor loop: amplitude springs up on enter and decays after leave,
       so the wave washes out of the graph instead of snapping off */
    let mouse = null;
    let amp = 0;
    let raf = null;
    const liveLoop = (now) => {
      const target = mouse ? 1 : 0;
      amp += (target - amp) * 0.12;
      if (!mouse && amp < 0.01) {
        amp = 0;
        raf = null;
        draw(1);
        return;
      }
      const c = mouse || liveLoop.last;
      liveLoop.last = c;
      draw(1, { x: c.x, y: c.y, t: now, amp });
      if (mouse) {
        const i = Math.round(((mouse.x - PAD.l) / iw) * (points.length - 1));
        if (i >= 0 && i < points.length) {
          ctx.strokeStyle = theme().muted;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(X(i), PAD.t);
          ctx.lineTo(X(i), PAD.t + ih);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      raf = requestAnimationFrame(liveLoop);
    };

    canvas.onmousemove = (e) => {
      const r = canvas.getBoundingClientRect();
      mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (reduced) {
        draw(1);
      } else if (!raf) {
        raf = requestAnimationFrame(liveLoop);
      }
      const i = Math.round(((mouse.x - PAD.l) / iw) * (points.length - 1));
      if (i < 0 || i >= points.length) return hideTip();
      const p = points[i];
      tooltip(
        `<b>${p.full}</b><br>${fmt(p.v)} ${opts.unit || 'views'}${p.extra ? `<br><span>${p.extra}</span>` : ''}`,
        e.clientX,
        e.clientY
      );
    };
    canvas.onmouseleave = () => {
      hideTip();
      mouse = null; // liveLoop keeps running until the wave decays out
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

    const draw = (progress = 1, hoverI = -1, tNow = 0) => {
      ctx.clearRect(0, 0, w, h);
      ctx.font = '11px "JetBrains Mono Variable", monospace';
      rows.forEach((r, i) => {
        const y = i * ROW + ROW / 2;
        const bw = Math.max(2, (r.n / max) * iw * progress);
        const hot = i === hoverI;
        ctx.fillStyle = hot ? t.ink : t.muted;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const label = r.label.length > 18 ? r.label.slice(0, 17) + '…' : r.label;
        ctx.fillText(label, 0, y);
        const density = hot ? 0.62 + 0.1 * Math.sin(tNow / 260) : 0.45;
        ditherRect(ctx, LABEL_W, y - BAR / 2, bw, BAR, rgb, density, 2);
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

    let hoverI = -1;
    let raf = null;
    const liveLoop = (now) => {
      if (hoverI < 0) return;
      draw(1, hoverI, now);
      raf = requestAnimationFrame(liveLoop);
    };

    canvas.onmousemove = (e) => {
      const r = canvas.getBoundingClientRect();
      const i = Math.floor((e.clientY - r.top) / ROW);
      if (i < 0 || i >= rows.length) {
        hoverI = -1;
        return hideTip();
      }
      hoverI = i;
      if (reduced) draw(1, i);
      else if (!raf) raf = requestAnimationFrame(liveLoop);
      tooltip(`<b>${rows[i].label}</b><br>${fmt(rows[i].n)} ${opts.unit || ''}`, e.clientX, e.clientY);
    };
    canvas.onmouseleave = () => {
      hideTip();
      hoverI = -1;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      draw(1);
    };

    return { redraw: () => draw(1) };
  }

  /* number count-up for the stat tiles */
  const countUp = (el, ms = 700) => {
    const target = Number((el.textContent || '').replace(/[^0-9]/g, ''));
    if (!Number.isFinite(target) || target === 0 || reduced) return;
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      el.textContent = fmt(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  /* ---------- bootstrap the /stats page ---------- */
  const mount = () => {
    /* staggered entrance for tiles + panels, charts draw as panels land */
    const entering = $$('.dash .tile, .dash .panel');
    entering.forEach((el, i) => {
      setTimeout(() => el.classList.add('in'), reduced ? 0 : 70 * i);
    });
    $$('.dash .tile .t-num').forEach((el, i) => {
      setTimeout(() => countUp(el), reduced ? 0 : 70 * i + 150);
    });

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
    // draw once the panels have landed so the sweep/grow animations are seen
    const drawDelay = reduced ? 0 : 420;
    const dayLabel = (iso) => {
      const d = new Date(iso + 'T00:00:00Z');
      return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
    };
    const fullLabel = (iso) =>
      new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', {
        weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
      });

    setTimeout(() => {
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
    }, drawDelay);

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
