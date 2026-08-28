// Screen 3 -- the conglomerate board.
//
// Each zone's images reflow into its own footprint, so adjacency becomes
// visible: on a board, the living zone's warmth sits directly against the
// kitchen's palette, in the arrangement you'd actually walk through.

import {
  api, imageUrl, backgroundUrl, loadImage, cachedImage,
  el, toast, debounce, exportPng, emit, sourceLabel,
} from './app.js';
import { setSaveState, spriteRest, spriteReact } from './rail.js';
import { layout, drawBoxes } from './layout.js';

const EXPORT_WIDTH = 3200;

export async function mountMosaic(root, target) {
  const boardId = target.boardId;
  const board = await api.getBoard(boardId);
  const bgUrl = () => (board.background ? backgroundUrl(boardId, board.background) : '');
  const label = board.zoneLabel || { one: 'Zone', many: 'Zones' };
  if (!board.zones.length) {
    throw new Error(`Draw some ${label.many.toLowerCase()} on the board first.`);
  }

  const settings = Object.assign(
    { roomGutter: 14, imageGutter: 6, bg: '#fff0d6', showPlan: true, showLabels: true },
    board.stitch || {},
  );

  // Pull every zone in parallel, then preload every image once.
  const zones = await Promise.all(board.zones.map(async (meta) => {
    const zone = await api.getZone(boardId, meta.id);
    return { meta, zone };
  }));

  const urls = [];
  for (const { meta, zone } of zones) {
    for (const entry of zone.selected) {
      const image = zone.images[entry.sha];
      if (image) urls.push(imageUrl(boardId, meta.id, image));
    }
  }
  if (settings.showPlan && board.background) urls.push(bgUrl());

  const filled = zones.filter(({ zone }) => zone.selected.length);
  const empty = zones.filter(({ zone }) => !zone.selected.length);

  const canvas = el('canvas', { class: 'stitch-canvas' });
  const stage = el('div', { class: 'stitch-stage' }, [canvas]);

  const save = debounce(async () => {
    board.stitch = settings;
    try {
      await api.putBoard(boardId, board);
      setSaveState('saved');
    } catch (err) {
      setSaveState('failed', err.message);
      toast(err.message, 'error');
    }
  }, 400);
  const touch = () => { setSaveState('pending'); save(); };

  function slider(label, key, min, max) {
    const input = el('input', { type: 'range', min: String(min), max: String(max),
      step: '1', value: String(settings[key]) });
    const out = el('span', { class: 'num', text: String(settings[key]) });
    input.addEventListener('input', () => {
      settings[key] = Number(input.value);
      out.textContent = input.value;
      touch();
      schedule();
    });
    return el('label', { class: 'ctl' }, [el('span', { text: label }), input, out]);
  }

  function toggle(label, key) {
    const input = el('input', { type: 'checkbox' });
    input.checked = Boolean(settings[key]);
    input.addEventListener('change', () => {
      settings[key] = input.checked;
      touch();
      if (key === 'showPlan' && input.checked && board.background) {
        loadImage(bgUrl()).promise.then(schedule).catch(() => {});
      }
      schedule();
    });
    return el('label', { class: 'ctl' }, [input, el('span', { text: label })]);
  }

  const bgInput = el('input', { type: 'color', value: settings.bg });
  bgInput.addEventListener('input', () => { settings.bg = bgInput.value; save(); schedule(); });

  const controls = el('div', { class: 'stitch-controls' }, [
    slider(`Between ${label.many.toLowerCase()}`, 'roomGutter', 0, 60),
    slider('Between images', 'imageGutter', 0, 40),
    el('label', { class: 'ctl' }, [el('span', { text: 'Ground' }), bgInput]),
    board.background ? toggle('Plan underneath', 'showPlan') : null,
    toggle(`${label.one} labels`, 'showLabels'),
    el('span', { class: 'spacer' }),
    el('button', { class: 'primary', text: 'Export board PNG', onclick: exportHouse }),
  ]);

  const totalImages = zones.reduce((s, r) => s + r.zone.selected.length, 0);
  const exportH = Math.round(EXPORT_WIDTH / planRatio());
  const facts = el('div', { class: 'facts' }, [
    el('span', { class: 'fact' }, [
      el('b', { class: 'num', text: `${filled.length}/${zones.length}` }),
      el('span', { text: `${label.many.toLowerCase()} with images` })]),
    el('span', { class: 'fact' }, [
      el('b', { class: 'num', text: String(totalImages) }),
      el('span', { text: 'images' })]),
    el('span', { class: 'fact' }, [
      el('b', { class: 'num', text: `${EXPORT_WIDTH}×${exportH}` }),
      el('span', { text: 'export size' })]),
  ]);

  const remaining = empty.length
    ? el('div', { class: 'facts' }, [
      el('span', { class: 'sub', text: 'Still empty:' }),
      ...empty.flatMap(({ meta }, i) => [
        i ? el('span', { class: 'sub', text: '·' }) : null,
        el('a', { class: 'sel-src', href: `#/b/${boardId}/z/${meta.id}`, text: meta.name }),
      ].filter(Boolean)),
    ])
    : el('span', { class: 'sub', text: `Every ${label.one.toLowerCase()} has images.` });

  root.appendChild(el('div', { class: 'bar' }, [
    el('h1', { text: 'Mosaic View' }),
    el('div', { class: 'divider' }),
    facts,
    el('span', { class: 'spacer' }),
    el('a', { class: 'ghost btn small', href: `#/b/${boardId}`, text: 'Board' }),
  ]));
  root.appendChild(el('div', { class: 'bar', style: 'padding:6px 16px' }, [remaining]));
  root.appendChild(stage);
  root.appendChild(controls);
  spriteRest(filled.length ? 'idle' : 'sleep');

  // -- render ---------------------------------------------------------------

  /**
   * Paint the composite at an arbitrary width. Gutters are expressed in
   * export-scale pixels and scaled down for the preview so what you see on
   * screen is proportionally identical to what you export.
   */
  // `collect` is non-null only for the on-screen draw. The export calls
  // paint() too, at 3200px, and if it overwrote these rects every click would
  // land on the wrong image.
  function paint(ctx, width, height, collect) {
    const scale = width / EXPORT_WIDTH;
    ctx.fillStyle = settings.bg;
    ctx.fillRect(0, 0, width, height);

    if (settings.showPlan && board.background) {
      const plan = cachedImage(bgUrl());
      if (plan && plan.complete) {
        ctx.save();
        ctx.globalAlpha = 0.16;
        ctx.drawImage(plan, 0, 0, width, height);
        ctx.restore();
      }
    }

    const roomPad = settings.roomGutter * scale;
    const imageGutter = Math.max(1, settings.imageGutter * scale);
    const labelSize = Math.max(9, 26 * scale);

    for (const { meta, zone } of zones) {
      const x = meta.rect.x * width + roomPad / 2;
      const y = meta.rect.y * height + roomPad / 2;
      const w = meta.rect.w * width - roomPad;
      const h = meta.rect.h * height - roomPad;
      if (w <= 2 || h <= 2) continue;

      const labelBand = settings.showLabels ? labelSize * 1.5 : 0;
      const boardH = Math.max(4, h - labelBand);

      const items = zone.selected.map((entry) => {
        const image = zone.images[entry.sha];
        if (!image) return null;
        const aspect = image.w && image.h ? image.w / image.h : 1;
        return { key: imageUrl(boardId, meta.id, image), aspect, feature: entry.feature };
      }).filter(Boolean);

      if (items.length) {
        const boxes = layout(items, { width: w, height: boardH, gutter: imageGutter });
        ctx.save();
        ctx.translate(x, y + labelBand);
        drawBoxes(ctx, boxes, cachedImage, { radius: 2 * (width / 1000) });
        ctx.restore();
        if (collect) {
          for (const box of boxes) {
            collect.push({
              x: x + box.x, y: y + labelBand + box.y, w: box.w, h: box.h,
              key: box.key, zoneId: meta.id, zoneName: meta.name,
            });
          }
        }
      } else {
        // An empty zone stays visible as its outline, so the board still reads.
        ctx.save();
        ctx.strokeStyle = meta.color;
        ctx.globalAlpha = 0.5;
        ctx.setLineDash([6 * scale * 2, 5 * scale * 2]);
        ctx.lineWidth = Math.max(1, 3 * scale);
        ctx.strokeRect(x, y + labelBand, w, boardH);
        ctx.restore();
      }

      if (settings.showLabels) {
        ctx.save();
        ctx.fillStyle = meta.color;
        ctx.font = `600 ${labelSize}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        ctx.fillText(meta.name.toUpperCase(), x, y);
        ctx.restore();
      }
    }
  }

  function planRatio() {
    const bg = board.background;
    if (bg && bg.w && bg.h) return bg.w / bg.h;
    return (board.canvas && board.canvas.w / board.canvas.h) || 1.6;
  }

  // Cell rects from the last on-screen draw, in canvas CSS pixels.
  let hitBoxes = [];

  function hitTest(event) {
    const box = canvas.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    for (const b of hitBoxes) {
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
    }
    return null;
  }

  function onCanvasMove(event) {
    canvas.style.cursor = hitTest(event) ? 'zoom-in' : 'default';
  }

  function onCanvasClick(event) {
    const hit = hitTest(event);
    if (hit) openPeek(hit);
  }

  canvas.addEventListener('mousemove', onCanvasMove);
  canvas.addEventListener('click', onCanvasClick);

  // -- quick peek -----------------------------------------------------------
  //
  // The mosaic crops every image to tile its footprint. This is the one place
  // that shows one whole and uncropped -- a look, not a trip to Pinterest, so
  // the source link is offered but never followed for you.

  let peek = null;

  function closePeek() {
    if (peek) { peek.remove(); peek = null; }
    document.removeEventListener('keydown', onPeekKey);
  }

  function onPeekKey(event) {
    if (event.key === 'Escape') closePeek();
  }

  function openPeek(hit) {
    closePeek();
    const zone = (zones.find((r) => r.meta.id === hit.zoneId) || {}).zone;
    const meta = zone && Object.values(zone.images || {})
      .find((m) => hit.key.endsWith(m.file));

    const img = el('img', { class: 'peek-img', src: hit.key, alt: '' });
    const caption = el('div', { class: 'peek-caption' }, [
      el('span', { class: 'peek-zone', text: hit.zoneName }),
      meta && meta.w ? el('span', { class: 'num', text: `${meta.w}×${meta.h}` }) : null,
      el('span', { class: 'spacer' }),
      meta && meta.src && /^https?:/i.test(meta.src)
        ? el('a', { class: 'peek-src', href: meta.src, target: '_blank',
          rel: 'noreferrer', text: `${sourceLabel(meta.src)} ↗`,
          onclick: (e) => e.stopPropagation() })
        : el('span', { class: 'peek-src muted', text: sourceLabel(meta && meta.src) }),
      el('button', { class: 'icon', title: 'Close (Esc)', text: '×', onclick: closePeek }),
    ]);

    peek = el('div', { class: 'peek-backdrop', onclick: closePeek }, [
      el('figure', { class: 'peek-figure' }, [img, caption]),
    ]);
    document.body.appendChild(peek);
    document.addEventListener('keydown', onPeekKey);
  }

  let frame = null;
  function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  }

  function draw() {
    const box = stage.getBoundingClientRect();
    const ratio = planRatio();
    let w = Math.max(200, box.width - 32);
    let h = w / ratio;
    const maxH = Math.max(240, box.height - 32);
    if (h > maxH) { h = maxH; w = h * ratio; }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hitBoxes = [];
    paint(ctx, w, h, hitBoxes);
  }

  async function exportHouse() {
    if (!filled.length) { toast(`No ${label.one.toLowerCase()} has images yet`, 'error'); return; }
    toast('Rendering…');
    const width = EXPORT_WIDTH;
    const height = Math.round(width / planRatio());
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    paint(out.getContext('2d'), width, height, null);
    await exportPng(out, `${boardId}-mosaic.png`);
    spriteReact('cheer', 2200);
    emit('data');
  }

  const observer = new ResizeObserver(schedule);
  observer.observe(stage);

  schedule();
  // Draw immediately with whatever is cached, then again once everything
  // has decoded -- a big board shouldn't show a blank canvas while loading.
  Promise.all(urls.map((url) => loadImage(url).promise.catch(() => null))).then(schedule);

  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
    canvas.removeEventListener('mousemove', onCanvasMove);
    canvas.removeEventListener('click', onCanvasClick);
    closePeek();
  };
}
