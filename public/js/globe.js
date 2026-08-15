/* Homepage visitor globe. Hand-rolled orthographic dot-sphere on a 2D canvas:
   no WebGL, no libraries, same Bayer-dither language as /js/dither.js.
   Land is a coarse polygon mask sampled into ~1,300 dots at init; per frame we
   only rotate + project points, which is cheap enough for phones. Visitor pins
   are country centroids only — the site never knows or shows anything finer. */
(() => {
  /* Re-mountable under ClientRouter: mount() wires the current document and
     returns a teardown; astro:before-swap runs it so the draw loop and the
     30s poll never outlive the page the globe sits on. */
  const mount = () => {
    const strip = document.getElementById('globe-strip');
    const canvas = document.getElementById('globe-canvas');
    if (!strip || !canvas) return null;

    /* window/document listeners below hang off this so teardown is one abort */
    const page = new AbortController();

    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const D2R = Math.PI / 180;

    /* ---------- geography (coarse on purpose — it renders as ~2px dots) ---------- */
    const POLYS = [
      // North America
      [[70,-165],[71,-125],[68,-95],[62,-80],[52,-56],[46,-60],[41,-70],[35,-76],[30,-81],[25,-80],[29,-90],[26,-98],[18,-95],[15,-92],[8,-80],[8,-84],[15,-97],[23,-106],[32,-117],[40,-124],[48,-125],[60,-140],[58,-158],[65,-165]],
      // Greenland
      [[83,-35],[80,-20],[70,-22],[60,-43],[65,-53],[76,-58],[80,-55]],
      // South America
      [[11,-72],[5,-52],[-2,-44],[-8,-35],[-13,-38],[-23,-41],[-34,-53],[-39,-62],[-47,-66],[-54,-68],[-53,-72],[-42,-73],[-30,-71],[-18,-70],[-5,-81],[2,-79],[8,-77]],
      // Europe
      [[71,25],[68,42],[60,30],[55,21],[50,32],[45,29],[41,23],[37,-6],[43,-9],[44,-1],[48,-5],[51,2],[53,8],[57,8],[59,5],[63,10],[66,14]],
      // UK + Ireland
      [[59,-3],[56,-2],[53,0],[51,1],[50,-4],[53,-6],[55,-8],[57,-6]],
      // Africa
      [[35,-6],[37,10],[33,11],[31,32],[22,37],[11,43],[12,51],[2,46],[-11,40],[-20,35],[-26,33],[-34,20],[-33,18],[-23,14],[-17,12],[-8,13],[-1,9],[4,6],[4,-8],[9,-13],[14,-17],[21,-17],[28,-13],[32,-9]],
      // Asia mainland
      [[70,45],[73,80],[71,110],[70,140],[66,170],[62,163],[60,150],[54,137],[43,132],[39,126],[35,120],[30,122],[23,117],[17,109],[10,105],[6,101],[1,104],[8,98],[16,94],[22,91],[21,88],[16,82],[8,77],[15,74],[21,70],[25,67],[25,57],[27,51],[30,49],[37,44],[41,37],[42,27],[47,32],[50,40],[55,45],[62,42]],
      // Japan
      [[45,142],[43,145],[38,141],[34,135],[31,131],[34,132],[38,138],[42,140]],
      // Indonesia / SE Asia islands
      [[-2,95],[2,99],[-1,104],[-4,106],[-7,110],[-8,115],[-9,120],[-8,126],[-4,133],[-2,140],[-6,143],[-9,141],[-8,131],[-10,124],[-9,116],[-8,112],[-6,106],[-5,102]],
      // Australia
      [[-11,132],[-12,136],[-16,141],[-11,142],[-16,146],[-21,149],[-27,153],[-33,152],[-38,147],[-38,140],[-35,136],[-32,133],[-31,125],[-34,119],[-33,115],[-28,114],[-22,114],[-18,122],[-14,127]],
      // New Zealand
      [[-35,173],[-38,178],[-41,175],[-44,171],[-46,167],[-42,172],[-38,174]],
      // Madagascar
      [[-12,49],[-16,50],[-22,48],[-25,47],[-22,44],[-16,44]],
    ];

    /* Country centroids, [lat, lon]. Enough for pins; unknown codes just don't pin. */
    const CENTROIDS = {
      AD:[42.5,1.5],AE:[24,54],AF:[33,66],AL:[41,20],AM:[40,45],AO:[-12,17],AR:[-34,-64],AT:[47.5,14],
      AU:[-25,134],AZ:[40.5,47.5],BA:[44,18],BD:[24,90],BE:[50.8,4.5],BF:[12,-2],BG:[43,25],BH:[26,50.5],
      BJ:[9.5,2.3],BN:[4.5,114.7],BO:[-17,-65],BR:[-10,-52],BW:[-22,24],BY:[53,28],CA:[56,-106],CD:[-3,23],
      CH:[47,8],CI:[8,-5],CL:[-32,-71],CM:[6,12],CN:[35,105],CO:[4,-73],CR:[10,-84],CU:[22,-79],
      CY:[35,33],CZ:[49.8,15.5],DE:[51,10],DK:[56,10],DO:[19,-70.5],DZ:[28,3],EC:[-1.5,-78.5],EE:[59,26],
      EG:[27,30],ES:[40,-4],ET:[9,39],FI:[62,26],FR:[46.5,2.5],GB:[54,-2],GE:[42,43.5],GH:[8,-1],
      GR:[39,22],GT:[15.5,-90],HK:[22.3,114.2],HN:[15,-86.5],HR:[45.5,16],HU:[47,20],ID:[-2,118],IE:[53,-8],
      IL:[31.5,35],IN:[22,79],IQ:[33,44],IR:[32,53],IS:[65,-18],IT:[43,12],JM:[18,-77.3],JO:[31,36.5],
      JP:[36,138],KE:[0.5,38],KG:[41.5,74.5],KH:[12.5,105],KR:[36.5,128],KW:[29.3,47.6],KZ:[48,68],LA:[18,104],
      LB:[33.9,35.9],LK:[7.5,80.8],LT:[55,24],LU:[49.8,6.1],LV:[57,25],LY:[27,17],MA:[32,-6],MD:[47,28.5],
      ME:[42.5,19.3],MK:[41.6,21.7],MM:[21,96],MN:[46.9,103.8],MO:[22.2,113.5],MT:[35.9,14.4],MU:[-20.3,57.6],
      MX:[23.5,-102.5],MY:[3.5,102],MZ:[-18,35],NA:[-22,17],NG:[9.5,8],NI:[13,-85],NL:[52.2,5.3],NO:[62,8],
      NP:[28,84],NZ:[-42,172],OM:[21,57],PA:[8.5,-80],PE:[-9,-75],PH:[12,122],PK:[30,69],PL:[52,19],
      PR:[18.2,-66.4],PT:[39.5,-8],PY:[-23,-58],QA:[25.3,51.2],RO:[46,25],RS:[44,21],RU:[60,90],RW:[-2,30],
      SA:[24,45],SE:[62,15],SG:[1.35,103.8],SI:[46.1,14.8],SK:[48.7,19.5],SN:[14.5,-14.5],SV:[13.8,-88.9],
      TH:[15,101],TN:[34,9],TR:[39,35],TT:[10.4,-61.3],TW:[23.7,121],TZ:[-6,35],UA:[49,32],UG:[1.4,32.3],
      US:[39.8,-98.6],UY:[-33,-56],UZ:[41.5,64],VE:[7,-66],VN:[16,107],ZA:[-29,25],ZM:[-13,28],ZW:[-19,29.8],
    };

    const inPoly = (lat, lon, poly) => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [yi, xi] = poly[i], [yj, xj] = poly[j];
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)
          inside = !inside;
      }
      return inside;
    };
    const isLand = (lat, lon) => POLYS.some((p) => inPoly(lat, lon, p));

    const BAYER = [
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5],
    ];

    /* Sample the mask once into unit vectors (y up). Sizes carry the dither. */
    const dots = [];
    const STEP = 3.4;
    for (let lat = -84; lat <= 84; lat += STEP) {
      const lonStep = STEP / Math.max(0.25, Math.cos(lat * D2R));
      for (let lon = -180; lon < 180; lon += lonStep) {
        const land = isLand(lat, lon);
        const bayer = BAYER[Math.abs(Math.round(lat / STEP)) & 3][Math.abs(Math.round(lon / STEP)) & 3] / 16;
        if (!land && bayer >= 0.22) continue;
        const φ = lat * D2R, λ = lon * D2R;
        dots.push({
          x: Math.cos(φ) * Math.sin(λ),
          y: Math.sin(φ),
          zc: Math.cos(φ) * Math.cos(λ),
          land,
          big: bayer < 0.5,
        });
      }
    }

    /* ---------- theme + data ---------- */
    const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    let theme = {};
    const readTheme = () => {
      theme = { land: cssVar('--primary'), pin: cssVar('--kinda-bg'), rim: cssVar('--border'), ink: cssVar('--fg') };
    };
    readTheme();

    let data = null;
    try {
      data = JSON.parse(document.getElementById('globe-data')?.textContent || 'null');
      if (data?.unavailable) data = null;
    } catch { data = null; }
    // dataAt is when the snapshot was COMPUTED, not fetched: the server says how
    // many seconds it already spent in its cache, so "ago" drift stays honest.
    let dataAt = Date.now() - (data?.age || 0) * 1000;

    let pins = [];
    let hasFresh = false; // any pin young enough to pulse (checked per payload, not per frame)
    const buildPins = () => {
      pins = (data?.pins || [])
        .map((p) => {
          const c = CENTROIDS[p.c];
          if (!c) return null;
          const φ = c[0] * D2R, λ = c[1] * D2R;
          const latest = (data.feed || []).find((f) => f.c === p.c);
          return {
            ...p,
            latest,
            x: Math.cos(φ) * Math.sin(λ),
            y: Math.sin(φ),
            zc: Math.cos(φ) * Math.cos(λ),
          };
        })
        .filter(Boolean);
      hasFresh = pins.some((p) => p.ago < 300);
    };
    buildPins();

    /* ---------- projection + drawing ---------- */
    let W = 0, H = 0, R = 0, CX = 0, CY = 0, ctx = null;
    const setup = () => {
      const box = canvas.parentElement.getBoundingClientRect();
      const size = Math.min(box.width, 420);
      if (!size) return;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      W = H = size;
      R = size * 0.46;
      CX = CY = size / 2;
    };

    let lon0 = -20; // start over the Atlantic: Americas + Europe/Africa both visible
    let lat0 = 22;
    let hoverPin = null;

    const project = (d, sinLon, cosLon, sinLat, cosLat) => {
      // yaw (lon0) about the y axis, then pitch (lat0) about the x axis
      const x1 = d.x * cosLon - d.zc * sinLon;
      const z1 = d.x * sinLon + d.zc * cosLon;
      const y1 = d.y * cosLat - z1 * sinLat;
      const z2 = d.y * sinLat + z1 * cosLat;
      return { sx: CX + R * x1, sy: CY - R * y1, z: z2 };
    };

    const pinScreen = []; // refreshed every draw, used for hover hit-tests
    const draw = (t = 0) => {
      if (!ctx) return;
      ctx.clearRect(0, 0, W, H);
      const sinLon = Math.sin(-lon0 * D2R), cosLon = Math.cos(-lon0 * D2R);
      const sinLat = Math.sin(lat0 * D2R), cosLat = Math.cos(lat0 * D2R);

      ctx.strokeStyle = theme.rim;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(CX, CY, R + 4, 0, Math.PI * 2);
      ctx.stroke();

      const k = R / 220; // dot sizes were tuned at R=220
      ctx.fillStyle = theme.land;
      for (const d of dots) {
        const p = project(d, sinLon, cosLon, sinLat, cosLat);
        if (p.z <= 0.02) continue;
        if (d.land) {
          ctx.globalAlpha = 0.3 + 0.62 * p.z;
          const r = (1.05 + 0.8 * p.z) * (d.big ? 1.22 : 0.92) * k;
          ctx.fillRect(p.sx - r, p.sy - r, r * 2, r * 2);
        } else {
          ctx.globalAlpha = 0.08 + 0.13 * p.z;
          ctx.fillRect(p.sx - 0.9 * k, p.sy - 0.9 * k, 1.8 * k, 1.8 * k);
        }
      }
      ctx.globalAlpha = 1;

      pinScreen.length = 0;
      ctx.fillStyle = theme.pin;
      for (const pin of pins) {
        const p = project(pin, sinLon, cosLon, sinLat, cosLat);
        if (p.z <= 0.05) continue;
        const fresh = pin.ago < 300;
        const base = (2.2 + Math.min(2.6, Math.log2(1 + pin.n))) * k;
        const pulse = fresh && !reduced ? 1 + 0.35 * Math.sin(t / 350 + pin.x * 7) : 1;
        const hot = hoverPin === pin;
        ctx.globalAlpha = 0.16;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, base * 2.4 * pulse, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = hot ? 1 : 0.95;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, base * (hot ? 1.25 : 1), 0, Math.PI * 2);
        ctx.fill();
        pinScreen.push({ pin, sx: p.sx, sy: p.sy, r: base * 2.4 });
      }
      ctx.globalAlpha = 1;
    };

    /* ---------- interaction ---------- */
    const SPIN = 4.2; // deg/s
    let dragging = false;
    let hovering = false;
    // far in the past, or the 4s post-interaction grace period would also
    // cover the first 4s after page load and hold the globe still
    let lastPointer = -1e9;
    let px = 0, py = 0;

    const flag = (cc) =>
      /^[A-Z]{2}$/.test(cc || '')
        ? String.fromCodePoint(...[...cc].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65))
        : '';
    let regionNames;
    try { regionNames = new Intl.DisplayNames(['en'], { type: 'region' }); } catch {}
    const bareCountry = (cc) => {
      try { return regionNames?.of(cc) || cc; } catch { return cc; }
    };
    // sentence form: countries whose English names take "the"
    const THE = ['US', 'GB', 'NL', 'PH', 'AE', 'DO', 'CD'];
    const country = (cc) => (THE.includes(cc) ? `the ${bareCountry(cc)}` : bareCountry(cc));
    const agoStr = (sec) =>
      sec < 10 ? 'just now' : sec < 60 ? `${sec}s ago` : sec < 3600 ? `${Math.floor(sec / 60)}m ago` : `${Math.floor(sec / 3600)}h ago`;
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    let tip;
    const showTip = (pin, cx, cy) => {
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'chart-tip';
        document.body.appendChild(tip);
      }
      const drift = Math.floor((Date.now() - dataAt) / 1000);
      const f = pin.latest;
      const head = `${flag(pin.c)} ${esc(bareCountry(pin.c))}${pin.n > 1 ? ` · ${pin.n} people this hour` : ''}`;
      let lines = `<b>${head}</b>`;
      if (f) {
        const verb = f.copy ? `copied the ${esc(f.app || 'app')} prompt` : `${f.ago + drift < 120 ? 'reading' : 'read'} ${esc(f.path)}`;
        lines += `<br>${verb}${f.device ? ` · ${esc(f.device.toLowerCase())}` : ''}`;
        if (f.ref && f.ref !== '$direct') lines += `<br><span>arrived from ${esc(f.ref.replace(/^www\./, ''))}</span>`;
        lines += `<br><span>${agoStr(f.ago + drift)}</span>`;
      } else {
        lines += `<br><span>last seen ${agoStr(pin.ago + drift)}</span>`;
      }
      tip.innerHTML = lines;
      tip.style.display = 'block';
      const r = tip.getBoundingClientRect();
      tip.style.left = `${Math.min(cx + 14, innerWidth - r.width - 10)}px`;
      tip.style.top = `${Math.max(cy - r.height - 12, 8)}px`;
    };
    const hideTip = () => tip && (tip.style.display = 'none');

    const hitPin = (x, y) => {
      let best = null, bestD = Infinity;
      for (const s of pinScreen) {
        const dx = x - s.sx, dy = y - s.sy;
        const d = dx * dx + dy * dy;
        const reach = (s.r + 8) * (s.r + 8);
        if (d < reach && d < bestD) { best = s; bestD = d; }
      }
      return best;
    };

    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      lastPointer = performance.now();
      px = e.clientX;
      py = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      lastPointer = performance.now();
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      if (dragging) {
        lon0 += (e.clientX - px) * 0.35;
        lat0 = Math.max(-70, Math.min(70, lat0 + (e.clientY - py) * 0.35));
        px = e.clientX;
        py = e.clientY;
        hideTip();
        if (reduced) draw(performance.now());
        return;
      }
      hovering = true;
      const hit = hitPin(x, y);
      if ((hit ? hit.pin : null) !== hoverPin) dirty = true; // hot-pin highlight changed
      hoverPin = hit ? hit.pin : null;
      canvas.style.cursor = hit ? 'pointer' : 'grab';
      if (hit) showTip(hit.pin, e.clientX, e.clientY);
      else hideTip();
      if (reduced) draw(performance.now());
    });
    const release = () => {
      dragging = false;
      lastPointer = performance.now();
    };
    canvas.addEventListener('pointerup', (e) => {
      // a tap (no real drag) on mobile: try the tooltip
      release();
      const rect = canvas.getBoundingClientRect();
      const hit = hitPin(e.clientX - rect.left, e.clientY - rect.top);
      if (hit && e.pointerType !== 'mouse') {
        showTip(hit.pin, e.clientX, e.clientY);
        setTimeout(hideTip, 3500);
      }
    });
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('pointerleave', () => {
      hovering = false;
      if (hoverPin) dirty = true;
      hoverPin = null;
      hideTip();
      canvas.style.cursor = 'grab';
    });

    /* ---------- loop, only while on screen ---------- */
    let visible = false;
    let raf = null;
    let lastT = 0;
    let dirty = true; // something changed while the loop wasn't animating (hover, poll, theme)
    const loop = (t) => {
      raf = null;
      if (!visible) return;
      raf = requestAnimationFrame(loop);
      /* 30fps cap unless dragging: a 4.2 deg/s drift and a slow pin pulse
         can't show the difference, and on /stats the globe shares the main
         thread with four animating charts. Skipped frames leave lastT alone,
         so dt still spans the real elapsed time. */
      if (!dragging && t - lastT < 28) return;
      // dt spans any off-screen gap (and, on the first frame, the whole time
      // since page load): the globe appears to have been spinning all along
      // instead of waking up when scrolled to.
      const dt = t - lastT;
      lastT = t;
      const idle = performance.now() - lastPointer > 4000;
      const spinning = !dragging && !hovering && idle;
      if (spinning) lon0 = (lon0 + (SPIN * dt) / 1000) % 360;
      // paused (pointer resting on it), nothing pulsing, no state change:
      // repainting would produce the identical frame, so don't
      if (!spinning && !dragging && !hasFresh && !dirty) return;
      dirty = false;
      draw(t);
    };
    const start = () => {
      if (reduced) { draw(0); return; }
      if (!raf) raf = requestAnimationFrame(loop);
    };

    let onScreen = false;
    const io = new IntersectionObserver(
      (entries) => {
        onScreen = entries[0].isIntersecting;
        visible = onScreen && !document.hidden;
        if (visible) start();
      },
      { rootMargin: '120px' }
    );

    document.addEventListener('visibilitychange', () => {
      visible = onScreen && !document.hidden;
      if (visible) start();
    }, { signal: page.signal });

    const mo = new MutationObserver(() => { readTheme(); dirty = true; if (reduced) draw(0); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    /* Width changes only: mobile URL-bar collapse fires height-only resizes
       on every scroll, and re-initing the canvas for those reads as flicker. */
    let rt;
    let lastW = innerWidth;
    addEventListener('resize', () => {
      if (innerWidth === lastW) return;
      lastW = innerWidth;
      clearTimeout(rt);
      rt = setTimeout(() => { setup(); dirty = true; if (reduced) draw(0); }, 200);
    }, { signal: page.signal });

    /* ---------- keep the numbers and feed fresh ---------- */
    const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
    const renderData = () => {
      if (!data) return;
      const live = document.getElementById('g-live');
      const sub = document.getElementById('g-sub');
      const feedEl = document.getElementById('g-feed');
      const chips = document.getElementById('g-chips');
      if (live) live.textContent = fmt(data.live);
      if (sub) {
        const since = data.allTime?.since
          ? ` since ${new Date(data.allTime.since + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).toLowerCase()}`
          : '';
        sub.textContent = `from ${fmt(data.liveCountries)} ${data.liveCountries === 1 ? 'country' : 'countries'} · ${fmt(data.allTime?.views)} visits${since}`;
      }
      if (feedEl) {
        const drift = Math.floor((Date.now() - dataAt) / 1000);
        feedEl.innerHTML = (data.feed || [])
          .slice(0, 4)
          .map((f, i) => {
            const ago = f.ago + drift;
            const text = f.copy
              ? `someone in ${esc(country(f.c))} copied the ${esc(f.app || 'app')} prompt`
              : `someone in ${esc(country(f.c))} ${ago < 120 ? 'is reading' : 'read'} ${esc(f.path)}`;
            return `<li${i === 0 ? ' class="fresh"' : ''}><span class="g-dot"></span><span class="g-line">${flag(f.c)} ${text}</span><span class="g-ago">${agoStr(ago)}</span></li>`;
          })
          .join('');
      }
      if (chips) {
        chips.innerHTML =
          (data.topCountries || [])
            .map((r) => `<span class="g-chip">${flag(r.c)} ${esc(r.c)} ${fmt(r.n)}</span>`)
            .join('') +
          (data.moreCountries > 0 ? `<span class="g-more">+ ${data.moreCountries} more</span>` : '');
      }
    };

    const poll = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch('/api/globe');
        const next = await res.json();
        if (next && !next.unavailable) {
          data = next;
          dataAt = Date.now() - (next.age || 0) * 1000;
          buildPins();
          renderData();
          dirty = true;
          if (reduced) draw(0);
        }
      } catch { /* keep the last picture */ }
    };
    const pollIv = setInterval(poll, 30_000);
    // A tab coming back from the background skipped its polls; catch up now
    // instead of showing stale numbers for up to another interval.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - dataAt > 30_000) poll();
    }, { signal: page.signal });

    /* ---------- boot ---------- */
    // Dev preview only: PostHog creds never exist on dev boxes, so ?demo=1
    // fakes a plausible payload to exercise the pins, tooltips and feed.
    // Never renders on the production domain.
    if (!data && location.hostname !== 'canivibecodeit.com' && new URLSearchParams(location.search).has('demo')) {
      data = {
        live: 23,
        liveCountries: 11,
        allTime: { views: 118412, countries: 89, since: '2026-07-29' },
        topCountries: [
          { c: 'US', n: 4812 }, { c: 'IN', n: 2304 }, { c: 'DE', n: 1187 },
          { c: 'GB', n: 976 }, { c: 'FR', n: 611 },
        ],
        moreCountries: 74,
        feed: [
          { c: 'FI', copy: false, path: '/notion', app: '', device: 'Mobile', ref: 'google.com', ago: 8 },
          { c: 'US', copy: true, path: '', app: 'Calendly', device: 'Desktop', ref: '$direct', ago: 44 },
          { c: 'DE', copy: false, path: '/alternatives/figma', app: '', device: 'Desktop', ref: 'news.ycombinator.com', ago: 70 },
          { c: 'IN', copy: false, path: '/moats/network-effects', app: '', device: 'Mobile', ref: 'x.com', ago: 130 },
        ],
        pins: [
          { c: 'FI', n: 1, ago: 8 }, { c: 'US', n: 6, ago: 44 }, { c: 'DE', n: 3, ago: 70 },
          { c: 'IN', n: 4, ago: 130 }, { c: 'GB', n: 2, ago: 400 }, { c: 'BR', n: 1, ago: 900 },
          { c: 'JP', n: 1, ago: 1400 }, { c: 'AU', n: 2, ago: 2100 },
        ],
      };
      dataAt = Date.now();
      buildPins();
      renderData();
    }
    setup();
    canvas.style.cursor = 'grab';
    // pan-y: horizontal touch drags rotate the globe, vertical ones still
    // scroll the page (a mid-page canvas must never trap the scroll)
    canvas.style.touchAction = 'pan-y';
    draw(0); // paint immediately: the globe must never be blank when scrolled to
    io.observe(canvas);

    return () => {
      page.abort();
      clearInterval(pollIv);
      io.disconnect();
      mo.disconnect();
      visible = false;
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      clearTimeout(rt);
    };
  };

  let teardown = null;
  const boot = () => {
    if (!teardown) teardown = mount();
  };
  document.addEventListener('astro:page-load', boot);
  document.addEventListener('astro:before-swap', () => {
    if (teardown) teardown();
    teardown = null;
  });
  // astro:page-load also fires on the initial load; the fallback only matters
  // if the router ever goes away.
  document.readyState === 'loading'
    ? addEventListener('DOMContentLoaded', () => setTimeout(boot, 20))
    : setTimeout(boot, 20);
})();
