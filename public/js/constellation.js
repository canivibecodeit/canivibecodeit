/* Interactive app constellation. It redraws only in response to interaction,
   filtering, resizing, or image loads so the full catalogue stays lightweight. */
(() => {
  const stage = document.querySelector('[data-constellation]');
  const canvas = stage?.querySelector('canvas');
  const nameplate = stage?.querySelector('[data-constellation-name]');
  const rowsRoot = document.querySelector('#rows');
  const viewButtons = [...document.querySelectorAll('[data-view]')];
  const listParts = [...document.querySelectorAll('[data-list-view]')];
  if (!stage || !canvas || !nameplate || !rowsRoot || !viewButtons.length) return;

  const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
  if (!ctx) return;

  const hash = (value) => {
    let result = 2166136261;
    for (let i = 0; i < value.length; i++) {
      result ^= value.charCodeAt(i);
      result = Math.imul(result, 16777619);
    }
    return result >>> 0;
  };

  const nodes = [...rowsRoot.querySelectorAll('.row')].map((row) => {
    const name = row.querySelector('.name')?.textContent?.trim() || row.dataset.name;
    return {
      row,
      name,
      href: row.getAttribute('href'),
      icon: row.querySelector('img')?.getAttribute('src'),
      verdict: row.dataset.verdict,
      seed: hash(`${row.dataset.category}:${name}`),
      image: null,
      loaded: false,
      visible: true,
      x: 0,
      y: 0,
      rx: 0,
      ry: 0,
      scale: 1,
    };
  });

  const pointer = { x: -1000, y: -1000, inside: false };
  const desktopView = matchMedia('(min-width: 761px)');
  let active = false;
  let onscreen = true;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let frame = 0;
  let layoutDirty = true;
  let baseSize = 12;
  let visibleNodes = nodes;
  let connections = [];
  let hovered = null;
  let namedNode = null;
  let touchSelection = null;
  let touchSelectionAt = 0;
  let loadIndex = 0;
  let loadTimer = 0;
  let palette = {};

  const readPalette = () => {
    const styles = getComputedStyle(document.documentElement);
    const color = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
    palette = {
      border: color('--border', '#262b26'),
      surface: color('--surface-2', '#1a1e1a'),
      yes: color('--primary', '#33e667'),
      kinda: color('--kinda-bg', '#ffb000'),
      no: color('--no-bg', '#ff4444'),
    };
  };
  readPalette();

  const requestDraw = () => {
    if (active && onscreen && !document.hidden && !frame) frame = requestAnimationFrame(draw);
  };

  const resize = () => {
    const nextWidth = Math.round(stage.clientWidth);
    const nextHeight = Math.round(stage.clientHeight);
    if (!nextWidth || !nextHeight) return;
    // A constellation does not benefit from retina-level detail; capping the
    // backing store avoids rendering four times as many pixels on dense screens.
    const nextDpr = Math.min(devicePixelRatio || 1, nextWidth < 600 ? 1 : 1.35);
    if (nextWidth === width && nextHeight === height && nextDpr === dpr) return;
    width = nextWidth;
    height = nextHeight;
    dpr = nextDpr;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layoutDirty = true;
    requestDraw();
  };

  const syncVisibility = () => {
    nodes.forEach((node) => {
      node.visible = node.row.style.display !== 'none';
    });
    visibleNodes = nodes.filter((node) => node.visible).sort((a, b) => a.seed - b.seed);
    if (touchSelection && !touchSelection.visible) touchSelection = null;
    layoutDirty = true;
    requestDraw();
  };

  const layout = () => {
    const count = visibleNodes.length;
    const padX = width < 600 ? 16 : 30;
    const padY = width < 600 ? 20 : 30;
    const usableWidth = Math.max(1, width - padX * 2);
    const usableHeight = Math.max(1, height - padY * 2);
    const columns = Math.max(1, Math.ceil(Math.sqrt((count * usableWidth) / usableHeight)));
    const rows = Math.max(1, Math.ceil(count / columns));
    const cellWidth = usableWidth / columns;
    const cellHeight = usableHeight / rows;
    const cell = Math.min(cellWidth, cellHeight);
    baseSize = Math.max(5, Math.min(18, Math.floor(cell * 0.56)));
    const spareX = Math.max(0, cellWidth - baseSize);
    const spareY = Math.max(0, cellHeight - baseSize);

    visibleNodes.forEach((node, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      // Small deterministic offsets break the rigid grid while retaining a
      // guaranteed collision-free gap between neighbouring icons.
      const jitterX = (((node.seed & 255) / 255) * 2 - 1) * spareX * 0.18;
      const jitterY = ((((node.seed >>> 8) & 255) / 255) * 2 - 1) * spareY * 0.18;
      node.x = padX + (column + 0.5) * cellWidth + jitterX;
      node.y = padY + (row + 0.5) * cellHeight + jitterY;
      node.rx = node.x;
      node.ry = node.y;
      node.scale = 1;
    });

    connections = [];
    for (let index = 0; index < count; index += 3) {
      if ((index + 1) % columns && visibleNodes[index + 1]) {
        connections.push([visibleNodes[index], visibleNodes[index + 1]]);
      }
      if (index % 2 === 0 && visibleNodes[index + columns]) {
        connections.push([visibleNodes[index], visibleNodes[index + columns]]);
      }
    }
    layoutDirty = false;
  };

  const loadNextBatch = () => {
    clearTimeout(loadTimer);
    if (!active || loadIndex >= nodes.length) return;
    for (let i = 0; i < 24 && loadIndex < nodes.length; i++, loadIndex++) {
      const node = nodes[loadIndex];
      if (!node.icon || node.image) continue;
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => {
        node.loaded = true;
        requestDraw();
      };
      image.src = node.icon;
      node.image = image;
    }
    loadTimer = window.setTimeout(loadNextBatch, 18);
  };

  const roundedSquare = (x, y, size, radius) => {
    const right = x + size;
    const bottom = y + size;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(right - radius, y);
    ctx.quadraticCurveTo(right, y, right, y + radius);
    ctx.lineTo(right, bottom - radius);
    ctx.quadraticCurveTo(right, bottom, right - radius, bottom);
    ctx.lineTo(x + radius, bottom);
    ctx.quadraticCurveTo(x, bottom, x, bottom - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  };

  const updateNameplate = (node) => {
    if (!node) {
      if (namedNode) nameplate.classList.remove('show');
      namedNode = null;
      canvas.style.cursor = 'crosshair';
      return;
    }
    if (namedNode !== node) nameplate.textContent = node.name;
    namedNode = node;
    // Use a fixed tooltip allowance instead of measuring the DOM on every
    // pointer movement, which would force a synchronous browser layout.
    const left = node.rx < width - 210 ? node.rx + 16 : node.rx - 206;
    const top = node.ry > 48 ? node.ry - 40 : node.ry + 18;
    nameplate.style.left = `${Math.max(10, left)}px`;
    nameplate.style.top = `${Math.max(10, Math.min(height - 42, top))}px`;
    nameplate.classList.add('show');
    canvas.style.cursor = 'pointer';
  };

  const positionNodes = () => {
    const lensRadius = width < 600 ? 78 : 118;
    let nearest = touchSelection;
    let nearestDistance = touchSelection ? 0 : Infinity;

    if (!touchSelection && pointer.inside) {
      visibleNodes.forEach((node) => {
        const distance = Math.hypot(node.x - pointer.x, node.y - pointer.y);
        if (distance < nearestDistance) {
          nearest = node;
          nearestDistance = distance;
        }
      });
      if (nearestDistance > Math.max(18, baseSize * 1.45)) nearest = null;
    }

    visibleNodes.forEach((node) => {
      const dx = node.x - pointer.x;
      const dy = node.y - pointer.y;
      const distance = pointer.inside ? Math.hypot(dx, dy) : Infinity;
      const influence = Math.max(0, 1 - distance / lensRadius);
      const strength = influence * influence * 1.35;
      // Scale distance and icon size together. Neighbours flow outward at the
      // same rate that they grow, preserving the collision-free packing.
      node.rx = pointer.inside ? pointer.x + dx * (1 + strength) : node.x;
      node.ry = pointer.inside ? pointer.y + dy * (1 + strength) : node.y;
      node.scale = 1 + strength;
      if (node === nearest) node.scale = Math.max(node.scale, 2.2);
    });
    hovered = nearest;
    if (pointer.inside) resolveCollisions();
  };

  const resolveCollisions = () => {
    const bucketSize = Math.max(18, baseSize * 3.2);
    const padding = 1.25;

    // Rebuild a small spatial index between passes. Each logo is compared only
    // with neighbours in its own or adjacent buckets, not all 600+ logos.
    const maxPasses = width < 600 ? 20 : 12;
    for (let pass = 0; pass < maxPasses; pass++) {
      const buckets = new Map();
      visibleNodes.forEach((node, index) => {
        node.collisionIndex = index;
        const key = `${Math.floor(node.rx / bucketSize)}:${Math.floor(node.ry / bucketSize)}`;
        const bucket = buckets.get(key);
        if (bucket) bucket.push(node);
        else buckets.set(key, [node]);
      });

      let moved = false;
      visibleNodes.forEach((node) => {
        const cellX = Math.floor(node.rx / bucketSize);
        const cellY = Math.floor(node.ry / bucketSize);
        for (let offsetX = -1; offsetX <= 1; offsetX++) {
          for (let offsetY = -1; offsetY <= 1; offsetY++) {
            const bucket = buckets.get(`${cellX + offsetX}:${cellY + offsetY}`) || [];
            bucket.forEach((other) => {
              if (other.collisionIndex <= node.collisionIndex) return;
              const required = (baseSize * (node.scale + other.scale)) / 2 + padding;
              const dx = node.rx - other.rx;
              const dy = node.ry - other.ry;
              const overlapX = required - Math.abs(dx);
              const overlapY = required - Math.abs(dy);
              if (overlapX <= 0 || overlapY <= 0) return;

              moved = true;
              const useX = overlapX < overlapY;
              const direction = (useX ? dx : dy) >= 0 ? 1 : -1;
              const amount = (useX ? overlapX : overlapY) + 0.1;
              const nodeFixed = node === hovered;
              const otherFixed = other === hovered;
              const nodeMove = nodeFixed ? 0 : otherFixed ? amount : amount / 2;
              const otherMove = otherFixed ? 0 : nodeFixed ? amount : amount / 2;

              if (useX) {
                node.rx += direction * nodeMove;
                other.rx -= direction * otherMove;
              } else {
                node.ry += direction * nodeMove;
                other.ry -= direction * otherMove;
              }
            });
          }
        }
      });
      if (!moved) break;
    }
  };

  function draw() {
    frame = 0;
    if (!active || !onscreen || !width || !height) return;
    if (layoutDirty) layout();
    positionNodes();
    ctx.clearRect(0, 0, width, height);

    ctx.strokeStyle = palette.border;
    ctx.lineWidth = 0.7;
    ctx.globalAlpha = 0.34;
    connections.forEach(([from, to]) => {
      ctx.beginPath();
      ctx.moveTo(from.rx, from.ry);
      ctx.lineTo(to.rx, to.ry);
      ctx.stroke();
    });
    ctx.globalAlpha = 1;

    const ordered = hovered
      ? [...visibleNodes.filter((node) => node !== hovered), hovered]
      : visibleNodes;
    ordered.forEach((node) => {
      const size = baseSize * node.scale;
      const x = node.rx - size / 2;
      const y = node.ry - size / 2;
      const color = palette[node.verdict] || palette.border;

      ctx.save();
      if (node === hovered) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 14;
      }
      ctx.fillStyle = color;
      roundedSquare(x - 1, y - 1, size + 2, Math.max(2, size * 0.22));
      ctx.fill();
      ctx.shadowBlur = 0;
      roundedSquare(x, y, size, Math.max(2, size * 0.19));
      ctx.clip();
      if (node.loaded && node.image) {
        ctx.drawImage(node.image, x, y, size, size);
      } else {
        ctx.fillStyle = palette.surface;
        ctx.fillRect(x, y, size, size);
      }
      ctx.restore();
    });
    updateNameplate(hovered);
  }

  const setPointer = (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = event.clientX - rect.left;
    pointer.y = event.clientY - rect.top;
    pointer.inside = true;
    if (event.pointerType !== 'touch') touchSelection = null;
    requestDraw();
  };

  const hitNode = () => {
    let result = null;
    let distance = Infinity;
    visibleNodes.forEach((node) => {
      const next = Math.hypot(node.rx - pointer.x, node.ry - pointer.y);
      if (next < distance && next < Math.max(18, (baseSize * node.scale) / 2 + 4)) {
        result = node;
        distance = next;
      }
    });
    return result;
  };

  canvas.addEventListener('pointermove', setPointer);
  canvas.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'touch' && touchSelection) return;
    pointer.inside = false;
    hovered = null;
    updateNameplate(null);
    requestDraw();
  });
  canvas.addEventListener('pointerup', (event) => {
    setPointer(event);
    positionNodes();
    const node = hitNode();
    if (!node) return;
    if (event.pointerType === 'touch') {
      const now = Date.now();
      if (touchSelection === node && now - touchSelectionAt < 2600) {
        location.href = node.href;
        return;
      }
      touchSelection = node;
      touchSelectionAt = now;
      requestDraw();
      return;
    }
    location.href = node.href;
  });
  canvas.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') viewButtons.find((button) => button.dataset.view === 'list')?.click();
  });

  const setView = (view) => {
    if (view === 'constellation' && !desktopView.matches) view = 'list';
    active = view === 'constellation';
    viewButtons.forEach((button) => {
      const selected = button.dataset.view === view;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    listParts.forEach((part) => (part.hidden = active));
    stage.hidden = !active;
    window.posthog?.capture('death_list_view', { view });

    if (active) {
      requestAnimationFrame(() => {
        resize();
        syncVisibility();
        loadNextBatch();
        requestDraw();
      });
    } else {
      cancelAnimationFrame(frame);
      frame = 0;
      clearTimeout(loadTimer);
      pointer.inside = false;
      touchSelection = null;
      updateNameplate(null);
    }
  };

  viewButtons.forEach((button) =>
    button.addEventListener('click', () => setView(button.dataset.view))
  );
  desktopView.addEventListener('change', (event) => {
    if (!event.matches && active) setView('list');
  });

  new ResizeObserver(resize).observe(stage);
  new IntersectionObserver(([entry]) => {
    onscreen = entry.isIntersecting;
    requestDraw();
  }).observe(stage);
  new MutationObserver(syncVisibility).observe(rowsRoot, {
    subtree: true,
    attributes: true,
    attributeFilter: ['style'],
  });
  new MutationObserver(() => {
    readPalette();
    requestDraw();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  document.addEventListener('visibilitychange', requestDraw);
})();
