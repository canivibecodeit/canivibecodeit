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

  /* toLocaleString builds a fresh formatter per call — noticeable when the
     entrance animations format gridline/bar labels every frame. One cached
     NumberFormat, same output. */
  const NF = new Intl.NumberFormat('en-US');
  const fmt = (n) => NF.format(Number(n));
  // Chart labels (page paths, agent names, app names) originate from PostHog
  // events, which anyone can spoof, and land in tooltip innerHTML below. Escape
  // them so a crafted label can't inject markup.
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* shared tooltip. Writing innerHTML then reading getBoundingClientRect
     forces a synchronous layout — cheap once, but onmousemove can fire far
     more than 60x/sec on a high-poll-rate mouse/trackpad, and each of those
     was forcing its own reflow. Batching through rAF caps it at one
     measure+write per frame no matter how many mousemove events land in it. */
  let tip;
  let tipFrame = null;
  let pendingTip = null;
  let tipHtml = null; // what's currently in the tip, so unchanged frames skip innerHTML + measure
  let tipW = 0, tipH = 0;
  const tooltip = (html, x, y) => {
    pendingTip = { html, x, y };
    if (tipFrame) return;
    tipFrame = requestAnimationFrame(() => {
      tipFrame = null;
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'chart-tip';
        document.body.appendChild(tip);
      }
      tip.style.display = 'block';
      /* content only changes when the cursor crosses to another data point;
         between crossings this is position-only — no innerHTML, no reflow */
      if (pendingTip.html !== tipHtml) {
        tipHtml = pendingTip.html;
        tip.innerHTML = tipHtml;
        const r = tip.getBoundingClientRect();
        tipW = r.width;
        tipH = r.height;
      }
      tip.style.left = `${Math.min(pendingTip.x + 14, innerWidth - tipW - 10)}px`;
      tip.style.top = `${Math.max(pendingTip.y - tipH - 12, 8)}px`;
    });
  };
  const hideTip = () => {
    if (tipFrame) {
      cancelAnimationFrame(tipFrame);
      tipFrame = null;
    }
    if (tip) tip.style.display = 'none';
  };

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

  /* The Bayer matrix is a 4x4 tile, so for a constant density the set of lit
     cells repeats every 4 cells in both directions. Render that tile once
     per (color, density, cell size) into a tiny offscreen canvas and reuse
     it as a fill pattern — one fillRect call paints an arbitrarily large
     area instead of one fillRect per lit cell (thousands, for a chart-sized
     fill). This wasn't a JS-speed problem: on a GPU-driver-limited machine,
     cutting the per-fill cell count ~9x (tested by bumping the cell size)
     cut a multi-second load freeze by the same proportion — draw-call count
     itself was the cost, not what the calls did or how often they ran.
     createPattern tiles from the canvas's own origin, same as the old
     per-cell loop's absolute cx/cy % 4 lookup, so adjacent fills (e.g. this
     function's stacked density bands) still line up seamlessly.
     Patterns are scaled by the context transform, and setupCanvas scales
     every chart context by devicePixelRatio — a CSS-pixel tile would get
     upscaled with image smoothing and blur every dot on retina screens.
     So the tile is rendered at device resolution and the pattern carries
     the inverse scale, keeping tile pixels 1:1 with device pixels. */
  const patternCache = new Map();
  const ditherPattern = (ctx, rgb, density, cell) => {
    const scale = ctx.getTransform().a;
    const key = `${rgb.join(',')}|${density}|${cell}|${scale}`;
    let pattern = patternCache.get(key);
    if (pattern) return pattern;
    const tile = document.createElement('canvas');
    tile.width = tile.height = Math.round(cell * 4 * scale);
    const tctx = tile.getContext('2d');
    tctx.scale(scale, scale);
    tctx.fillStyle = `rgb(${rgb.join(',')})`;
    for (let cy = 0; cy < 4; cy++) {
      for (let cx = 0; cx < 4; cx++) {
        if (BAYER[cy][cx] / 16 < density) tctx.fillRect(cx * cell, cy * cell, cell - 1, cell - 1);
      }
    }
    pattern = ctx.createPattern(tile, 'repeat');
    pattern.setTransform(new DOMMatrix().scale(1 / scale));
    patternCache.set(key, pattern);
    return pattern;
  };

  /* Dithered fill: paint through the Bayer threshold matrix. density 0..1
     decides how many cells light up; cell = dot pitch in px. boost(px, py)
     optionally adds cursor-reactive density per cell — that needs the slow
     per-cell path since density then varies within the fill, but nothing
     currently calls this with a boost (the live cursor aura patches its own
     small region separately via ditherRectBoostOnly below). */
  function ditherRect(ctx, x, y, w, h, rgb, density, cell = 3, boost) {
    if (!boost) {
      ctx.fillStyle = ditherPattern(ctx, rgb, density, cell);
      ctx.fillRect(x, y, w, h);
      return;
    }
    ctx.fillStyle = `rgb(${rgb.join(',')})`;
    const x0 = Math.floor(x / cell), x1 = Math.ceil((x + w) / cell);
    const y0 = Math.floor(y / cell), y1 = Math.ceil((y + h) / cell);
    for (let cy = y0; cy < y1; cy++) {
      for (let cx = x0; cx < x1; cx++) {
        const d = Math.min(0.96, density + boost(cx * cell, cy * cell));
        if (BAYER[cy & 3][cx & 3] / 16 < d) {
          ctx.fillRect(cx * cell, cy * cell, cell - 1, cell - 1);
        }
      }
    }
  }

  /* Same threshold rule as ditherRect, but paints only the cells the boost
     newly lights up (boost only ever adds density, never removes it, so
     anything already on stays on). Used to patch a cursor-reactive aura onto
     an already-rendered static bitmap instead of redrawing the whole fill
     just to move a highlight. */
  function ditherRectBoostOnly(ctx, x, y, w, h, rgb, density, cell, boost) {
    ctx.fillStyle = `rgb(${rgb.join(',')})`;
    const x0 = Math.floor(x / cell), x1 = Math.ceil((x + w) / cell);
    const y0 = Math.floor(y / cell), y1 = Math.ceil((y + h) / cell);
    for (let cy = y0; cy < y1; cy++) {
      for (let cx = x0; cx < x1; cx++) {
        const b = boost(cx * cell, cy * cell);
        if (b <= 0.0008) continue;
        const thresh = BAYER[cy & 3][cx & 3] / 16;
        if (thresh >= density && thresh < Math.min(0.96, density + b)) {
          ctx.fillRect(cx * cell, cy * cell, cell - 1, cell - 1);
        }
      }
    }
  }

  /* Cursor aura: a calm gaussian glow in the dither field around the pointer.
     Localized on purpose (a full-field pulse proved headache-inducing), and it
     only ever touches dot density, never the data geometry. */
  const aura = (mx, my) => (px, py) => {
    const dx = px - mx, dy = (py - my) * 1.6;
    const dist2 = dx * dx + dy * dy;
    return 0.7 * Math.exp(-dist2 / (2 * 70 * 70));
  };

  /* ---------- area chart ---------- */
  function areaChart(canvas, points, opts = {}) {
    let t = theme();
    let rgb = hexRgb(t.data);
    const { ctx, w, h } = setupCanvas(canvas);
    const PAD = { l: 44, r: 10, t: 12, b: 24 };
    const iw = w - PAD.l - PAD.r;
    const ih = h - PAD.t - PAD.b;
    /* sqrt scale: a single viral day can be 30x+ a normal one, and a linear
       axis flattens every other point to the floor while that one day spikes
       through the ceiling. Square-rooting both the axis and the gridline
       labels below compresses the outlier without hiding it or lying about
       the smaller days. */
    const max = Math.max(1, ...points.map((p) => p.v));
    const nice = Math.sqrt(max);
    const X = (i) => PAD.l + (i / Math.max(1, points.length - 1)) * iw;
    const Y = (v) => PAD.t + ih - (Math.sqrt(v) / nice) * ih;
    // static per dataset; formatting them inside draw() ran every frame
    const gridLabels = [0, 1, 2, 3, 4].map((g) => fmt(Math.round(((nice * (4 - g)) / 4) ** 2)));
    // the data geometry never changes either: y per point + the fill clip
    const ysAll = points.map((p) => Y(p.v));
    const clipPath = new Path2D();
    clipPath.moveTo(X(0), PAD.t + ih);
    ysAll.forEach((y, i) => clipPath.lineTo(X(i), y));
    clipPath.lineTo(X(points.length - 1), PAD.t + ih);
    clipPath.closePath();

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
        ctx.fillText(gridLabels[g], PAD.l - 8, gy + 3);
      }

      ctx.textAlign = 'center';
      const step = Math.ceil(points.length / 5);
      points.forEach((p, i) => {
        if (i % step === 0) ctx.fillText(p.label, X(i), h - 8);
      });

      const upto = Math.max(2, Math.floor(points.length * progress));
      const visible = points.slice(0, upto);
      /* The line is data: it never moves. Only the fill's dither density
         carries the cursor wave, scaled by the eased amplitude. */
      const raw = cursor && cursor.amp > 0.001 ? aura(cursor.x, cursor.y) : null;
      const boost = raw ? (px, py) => raw(px, py) * cursor.amp : null;
      const ys = visible.map((p) => Y(p.v));

      /* dithered fill under the line, density fading downward */
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(X(0), PAD.t + ih);
      ys.forEach((y, i) => ctx.lineTo(X(i), y));
      ctx.lineTo(X(visible.length - 1), PAD.t + ih);
      ctx.closePath();
      ctx.clip();
      /* only dither the revealed extent: the clip already hides the rest, but
         the cell loop doesn't know that and was walking the full width on
         every entrance frame */
      const fillW = X(visible.length - 1) - PAD.l;
      const bands = 6;
      for (let b = 0; b < bands; b++) {
        const density = 0.55 * (1 - b / bands) + 0.06;
        ditherRect(ctx, PAD.l, PAD.t + (ih / bands) * b, fillW, ih / bands + 1, rgb, density, 3, boost);
      }
      ctx.restore();

      /* the line itself, crisp and truthful */
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

    /* Static bitmap cache: draw() redraws gridlines, labels, the ~12k-cell
       dithered fill and the line — real work, fine once. The hover loop
       below used to call it 60x/sec just to move a small cursor glow, which
       is what actually made the chart laggy under the mouse. snapshot()
       freezes the finished picture into an offscreen canvas so hover only
       has to blit it plus the tiny aura patch, not redraw everything. */
    let bg = null;
    let bgSeq = 0;
    const snapshot = () => {
      const seq = ++bgSeq;
      bg?.close?.();
      bg = null; // until the capture lands, hover falls back to a full draw
      if (typeof createImageBitmap !== 'function') {
        const c = document.createElement('canvas');
        c.width = canvas.width;
        c.height = canvas.height;
        c.getContext('2d').drawImage(canvas, 0, 0);
        bg = c;
        return;
      }
      /* async on purpose: the sync canvas→canvas copy was a ~100ms block
         landing exactly at entrance end, on top of everything else animating */
      createImageBitmap(canvas).then((bm) => {
        if (seq !== bgSeq) return bm.close();
        bg = bm;
      }).catch(() => {});
    };

    if (reduced) {
      draw(1);
      snapshot();
    } else {
      const t0 = performance.now();
      /* the reveal is quantized to whole data points, so most 60fps ticks
         would repaint a pixel-identical frame — only draw when the revealed
         point count actually advances (~14 paints instead of ~39) */
      let lastUpto = -1;
      const tick = (now) => {
        const p = Math.min(1, (now - t0) / 650);
        const eased = 1 - Math.pow(1 - p, 3);
        const upto = Math.max(2, Math.floor(points.length * eased));
        if (upto !== lastUpto) {
          lastUpto = upto;
          draw(eased);
        }
        if (p < 1) requestAnimationFrame(tick);
        else snapshot();
      };
      requestAnimationFrame(tick);
    }

    /* live cursor loop: amplitude springs up on enter and decays after leave,
       so the wave washes out of the graph instead of snapping off */
    let mouse = null;
    let amp = 0;
    let raf = null;
    // Bounds the patch. 260 is where the gaussian actually falls under the
    // 0.0008 floor ditherRectBoostOnly skips at; a tighter bound clips a ring
    // of cells that were still (barely) lighting up.
    const AURA_R = 260;
    const liveLoop = (now) => {
      const target = mouse ? 1 : 0;
      amp += (target - amp) * 0.12;
      if (!mouse && amp < 0.01) {
        amp = 0;
        raf = null;
        /* decay is over and nothing changed the data or theme, so the cached
           bitmap is still the correct final picture. The old draw(1) +
           snapshot() here cost ~100ms in one block, which is exactly the hitch
           people felt right after moving the cursor off the chart. */
        if (bg) {
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(bg, 0, 0, w, h);
        } else {
          draw(1);
          snapshot();
        }
        return;
      }
      const c = mouse || liveLoop.last;
      liveLoop.last = c;

      if (!bg) {
        // hovered before the entrance animation finished caching a bitmap:
        // fall back to a full draw for this one frame rather than blit garbage
        draw(1, { x: c.x, y: c.y, t: now, amp });
      } else {
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(bg, 0, 0, w, h);

        /* The gaussian is separable (exp(-(dx²+dy²)) = exp(-dx²)·exp(-dy²))
           and the cells sit on a fixed 3px lattice, so cache the per-column
           and per-row factors: ~250 Math.exp per frame instead of ~11k (the
           six band passes re-walk the same columns). Same numbers out. */
        const expX = [], expY = [];
        const A = amp;
        const boost = (px, py) => {
          const xi = (px / 3) | 0;
          let ex = expX[xi];
          if (ex === undefined) {
            const dx = px - c.x;
            ex = expX[xi] = Math.exp(-(dx * dx) / 9800);
          }
          const yi = (py / 3) | 0;
          let ey = expY[yi];
          if (ey === undefined) {
            const dy = (py - c.y) * 1.6;
            ey = expY[yi] = Math.exp(-(dy * dy) / 9800);
          }
          return 0.7 * ex * ey * A;
        };

        ctx.save();
        ctx.clip(clipPath);
        const bx0 = Math.max(PAD.l, c.x - AURA_R);
        const bx1 = Math.min(w - PAD.r, c.x + AURA_R);
        if (bx1 > bx0) {
          const bands = 6;
          for (let b = 0; b < bands; b++) {
            const density = 0.55 * (1 - b / bands) + 0.06;
            ditherRectBoostOnly(ctx, bx0, PAD.t + (ih / bands) * b, bx1 - bx0, ih / bands + 1, rgb, density, 3, boost);
          }
        }
        ctx.restore();
      }

      if (mouse) {
        const i = Math.round(((mouse.x - PAD.l) / iw) * (points.length - 1));
        if (i >= 0 && i < points.length) {
          // t, not theme(): theme() is 5 getComputedStyle reads, per frame here
          ctx.strokeStyle = t.muted;
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
      /* Reduced motion never gets the aura or the cursor rule (both live in
         liveLoop), so redrawing here repainted a pixel-identical chart on
         every mousemove: ~9k fillRects for nothing. The tooltip below is the
         whole hover affordance in that mode. */
      if (!reduced && !raf) raf = requestAnimationFrame(liveLoop);
      const i = Math.round(((mouse.x - PAD.l) / iw) * (points.length - 1));
      if (i < 0 || i >= points.length) return hideTip();
      const p = points[i];
      tooltip(
        `<b>${esc(p.full)}</b><br>${fmt(p.v)} ${esc(opts.unit || 'views')}${p.extra ? `<br><span>${esc(p.extra)}</span>` : ''}`,
        e.clientX,
        e.clientY
      );
    };
    canvas.onmouseleave = () => {
      hideTip();
      mouse = null; // liveLoop keeps running until the wave decays out
    };

    return {
      redraw: () => {
        // re-read the palette: redraw's callers are theme flips, and the
        // colors were captured at chart creation
        t = theme();
        rgb = hexRgb(t.data);
        draw(1);
        snapshot();
      },
    };
  }

  /* ---------- horizontal bars ---------- */
  function barChart(canvas, rows, opts = {}) {
    let t = theme();
    let rgb = hexRgb(t.data);
    const { ctx, w, h } = setupCanvas(canvas);
    const ROW = h / Math.max(1, rows.length);
    const BAR = Math.min(16, ROW * 0.44);
    const LABEL_W = opts.labelWidth ?? 130;
    const max = Math.max(1, ...rows.map((r) => r.n));
    const iw = w - LABEL_W - 54;
    // static per dataset; formatting/truncating inside draw() ran every frame
    const labels = rows.map((r) => (r.label.length > 18 ? r.label.slice(0, 17) + '…' : r.label));
    const valLabels = rows.map((r) => fmt(r.n));

    const draw = (progress = 1, hoverI = -1) => {
      ctx.clearRect(0, 0, w, h);
      ctx.font = '11px "JetBrains Mono Variable", monospace';
      rows.forEach((r, i) => {
        const y = i * ROW + ROW / 2;
        const bw = Math.max(2, (r.n / max) * iw * progress);
        const hot = i === hoverI;
        ctx.fillStyle = hot ? t.ink : t.muted;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(labels[i], 0, y);
        const density = hot ? 0.62 : 0.45;
        ditherRect(ctx, LABEL_W, y - BAR / 2, bw, BAR, rgb, density, 2);
        ctx.fillStyle = t.data;
        ctx.fillRect(LABEL_W + bw - 3, y - BAR / 2, 3, BAR);
        ctx.fillStyle = t.ink;
        ctx.fillText(valLabels[i], LABEL_W + bw + 8, y);
      });
    };

    if (reduced) draw(1);
    else {
      const t0 = performance.now();
      // 30fps: a 550ms eased grow on dithered bars can't show the difference,
      // and four charts animate this window at once
      let lastF = 0;
      const tick = (now) => {
        const p = Math.min(1, (now - t0) / 550);
        if (p === 1 || now - lastF >= 28) {
          lastF = now;
          draw(1 - Math.pow(1 - p, 3));
        }
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    /* Nothing here animates continuously: the hover highlight only changes
       when the hovered ROW changes, so redraw on that transition instead of
       the old 60fps loop that repainted an identical frame all hover long. */
    let hoverI = -1;
    canvas.onmousemove = (e) => {
      const r = canvas.getBoundingClientRect();
      const i = Math.floor((e.clientY - r.top) / ROW);
      if (i < 0 || i >= rows.length) {
        if (hoverI !== -1) {
          hoverI = -1;
          draw(1);
        }
        return hideTip();
      }
      if (i !== hoverI) {
        hoverI = i;
        draw(1, i);
      }
      tooltip(`<b>${esc(rows[i].label)}</b><br>${valLabels[i]} ${esc(opts.unit || '')}`, e.clientX, e.clientY);
    };
    canvas.onmouseleave = () => {
      hideTip();
      hoverI = -1;
      draw(1);
    };

    return {
      redraw: () => {
        t = theme();
        rgb = hexRgb(t.data);
        draw(1);
      },
    };
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
  /* Module-level so the astro:before-swap teardown below can reach them: with
     ClientRouter the theme observer and the resize-reload listener would
     otherwise follow the visitor to every other page. */
  let mo = null;
  let resizeCtl = null;
  let rt;

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
    // one cached formatter; toLocaleDateString builds a fresh one per call
    const fullDF = new Intl.DateTimeFormat('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
    });
    const fullLabel = (iso) => fullDF.format(new Date(iso + 'T00:00:00Z'));

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
    mo = new MutationObserver(() => charts.forEach((c) => c.redraw()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    /* Width changes only: on phones, scrolling collapses the URL bar, which
       fires resize with a new HEIGHT — reloading on that made the page
       flicker on every scroll. */
    let lastW = innerWidth;
    resizeCtl = new AbortController();
    addEventListener('resize', () => {
      if (innerWidth === lastW) return;
      lastW = innerWidth;
      clearTimeout(rt);
      rt = setTimeout(() => location.reload(), 400);
    }, { signal: resizeCtl.signal });
  };

  let mounted = false;
  const boot = () => {
    if (mounted) return;
    mounted = true;
    mount();
  };
  document.addEventListener('astro:page-load', boot);
  document.addEventListener('astro:before-swap', () => {
    mounted = false;
    mo?.disconnect();
    mo = null;
    resizeCtl?.abort();
    resizeCtl = null;
    clearTimeout(rt);
  });
  // astro:page-load also fires on the initial load; the fallback only matters
  // if the router ever goes away.
  document.readyState === 'loading'
    ? addEventListener('DOMContentLoaded', () => setTimeout(boot, 20))
    : setTimeout(boot, 20);
})();
