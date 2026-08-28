// Screen 2 -- the triad: Pinterest intake | Selected | Board.
//
// Pinterest has no public search API, so discovery happens in a real
// Pinterest tab beside this one. Three ways in, fastest first:
//   Cmd+V an image copied from anywhere  ->  /upload
//   paste a pin link (or several)        ->  /ingest, resolved via og:image
//   drag files from Finder               ->  /upload

import {
  api, imageUrl, loadImage, cachedImage, averageColor,
  el, toast, debounce, exportPng, emit, sourceLabel,
} from './app.js';
import { setSaveState, spriteReact, spriteRest } from './rail.js';
import { layout, drawBoxes } from './layout.js';

export async function mountZone(root, target) {
  const boardId = target.boardId;
  const zoneId = target.zoneId;
  const board = await api.getBoard(boardId);
  const label = board.zoneLabel || { one: 'Zone', many: 'Zones' };
  const meta = board.zones.find((z) => z.id === zoneId);
  if (!meta) throw new Error(`No ${label.one.toLowerCase()} "${zoneId}" on this board.`);
  const room = await api.getZone(boardId, zoneId);

  let dirty = false;
  const save = debounce(async () => {
    dirty = false;
    try {
      await api.putZone(boardId, zoneId, room);
      setSaveState('saved');
      emit('data');
    } catch (err) {
      setSaveState('failed', err.message);
      toast(err.message, 'error');
    }
  }, 400);
  const touch = () => { dirty = true; setSaveState('pending'); save(); };

  // -- chrome ---------------------------------------------------------------

  const ratio = meta.rect.w / meta.rect.h;
  const roomPx = board.background
    ? `${Math.round(meta.rect.w * board.background.w)}×${Math.round(meta.rect.h * board.background.h)}`
    : '';
  const roomFacts = el('div', { class: 'facts', id: 'room-facts' });

  const bar = el('div', { class: 'bar' }, [
    el('a', { class: 'ghost btn small', href: `#/b/${boardId}`, text: '← Board' }),
    el('span', { style: `background:${meta.color};width:9px;height:9px;border-radius:2px;flex:none` }),
    el('h1', { text: meta.name }),
    el('div', { class: 'divider' }),
    roomFacts,
    el('span', { class: 'spacer' }),
    el('a', { class: 'primary btn small', href: `#/b/${boardId}/mosaic`, text: 'Mosaic View →' }),
  ]);

  /** Footprint numbers, so the board you're building is never abstract. */
  function renderRoomFacts(fill) {
    roomFacts.innerHTML = '';
    const waiting = room.candidates.filter(
      (sha) => !room.selected.some((s) => s.sha === sha)).length;
    const items = [
      ['Footprint', roomPx],
      ['Shape', `${ratio.toFixed(2)}:1`],
      ['On board', String(room.selected.length)],
    ];
    if (waiting) items.push(['Waiting', String(waiting)]);
    if (fill) items.push(['Fills', fill]);
    for (const [label, value] of items) {
      if (!value) continue;
      roomFacts.appendChild(el('span', { class: 'fact' }, [
        el('b', { class: 'num', text: value }),
        el('span', { text: label }),
      ]));
    }
  }

  const triad = el('div', { class: 'triad' });
  root.appendChild(bar);
  root.appendChild(triad);

  // -- pane 1: intake -------------------------------------------------------

  const urlBox = el('textarea', {
    class: 'url-box',
    rows: '3',
    placeholder: 'Paste pin links or image URLs here — one per line, or several at once',
  });
  urlBox.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      addUrls();
    }
  });

  const candidateGrid = el('div', { class: 'cand-grid' });
  const ledger = el('div', { class: 'ledger' });
  const candCount = el('span', { class: 'num' });

  const intake = el('section', { class: 'pane pane-intake' }, [
    el('div', { class: 'pane-head' }, [
      el('span', { class: 'eyebrow', text: 'Pinterest' }),
      candCount,
      el('button', {
        class: 'ghost small',
        title: 'Pinterest blocks embedding, so it opens in its own window — keep it beside this one',
        text: 'Open ↗',
        onclick: () => window.open('https://www.pinterest.com/search/pins/?q=' +
          encodeURIComponent(`${meta.name} ${board.subject || ''}`.trim()), 'pinterest',
        'width=900,height=1000'),
      }),
    ]),
    el('div', { class: 'intake-form' }, [
      urlBox,
      el('div', { class: 'intake-actions' }, [
        el('button', { class: 'primary small', onclick: addUrls, text: 'Add' }),
        el('span', { class: 'tiny muted', text: '⌘V an image · drop files · ⌘↵ to add' }),
      ]),
    ]),
    ledger,
    candidateGrid,
  ]);

  // The ledger keeps the last handful of ingest attempts on screen. A failure
  // that only flashed past as a toast is a failure the user can't act on.
  const LEDGER_MAX = 6;

  function logLine(kind, text, meta_) {
    const mark = { ok: '●', dupe: '◐', err: '✕', work: '◌' }[kind] || '·';
    const row = el('div', { class: `ledger-row ${kind}` }, [
      el('span', { class: 'mk', text: mark }),
      el('span', { class: 'tx', text, title: text }),
      el('span', { class: 'mt', text: meta_ || '' }),
    ]);
    ledger.insertBefore(row, ledger.firstChild);
    while (ledger.children.length > LEDGER_MAX) ledger.removeChild(ledger.lastChild);
    return row;
  }

  async function addUrls() {
    const urls = urlBox.value.split(/\s+/).map((u) => u.trim()).filter(Boolean);
    if (!urls.length) return;
    urlBox.value = '';
    const working = logLine('work',
      `Fetching ${urls.length} link${urls.length > 1 ? 's' : ''}…`, '');
    const started = Date.now();
    try {
      const result = await api.ingest(boardId, zoneId, urls);
      working.remove();
      absorb(result, started);
    } catch (err) {
      working.remove();
      logLine('err', err.message);
      toast(err.message, 'error');
    }
  }

  async function addBlob(blob, source) {
    const working = logLine('work', `Saving ${source || 'image'}…`, '');
    const started = Date.now();
    try {
      const result = await api.upload(boardId, zoneId, blob, source);
      working.remove();
      absorb(result, started);
    } catch (err) {
      working.remove();
      logLine('err', err.message);
      toast(err.message, 'error');
    }
  }

  function absorb(result, started) {
    Object.assign(room.images, result.room.images);
    room.candidates = result.room.candidates;
    const secs = started ? `${((Date.now() - started) / 1000).toFixed(1)}s` : '';

    for (const added of result.added) {
      logLine('ok', `${sourceLabel(added.src)} — added`,
        added.w ? `${added.w}×${added.h}` : secs);
    }
    for (const sha of result.skipped) {
      const known = room.images[sha];
      logLine('dupe', `${sourceLabel(known && known.src)} — already here`, 'skipped');
    }
    for (const error of result.errors) {
      logLine('err', error.error, sourceLabel(error.url));
      toast(error.error, 'error');
    }
    if (result.added.length) spriteReact('happy');

    renderCandidates();
    renderSelected();
    schedule();
    emit('data');
  }

  function renderCandidates() {
    candidateGrid.innerHTML = '';
    const chosen = new Set(room.selected.map((s) => s.sha));
    const pending = room.candidates.filter((sha) => !chosen.has(sha) && room.images[sha]);
    candCount.textContent = pending.length ? `${pending.length} waiting` : '';

    if (!pending.length) {
      candidateGrid.appendChild(el('p', {
        class: 'note',
        text: room.candidates.length
          ? 'Everything collected here is on the board. Paste more links, or ⌘V an image, to keep curating.'
          : 'Nothing collected yet. Open Pinterest beside this window, right-click a pin, Copy Image, then press ⌘V here.',
      }));
      return;
    }
    for (const sha of pending) {
      const image = room.images[sha];
      const url = imageUrl(boardId, zoneId, image);
      const dims = image.w ? `${image.w}×${image.h}` : '';
      const thumb = el('button', {
        class: 'cand',
        title: `Add to board — ${dims} from ${sourceLabel(image.src)}`,
        onclick: () => select(sha),
      }, [
        el('img', { src: url, loading: 'lazy', alt: '' }),
        el('span', { class: 'meta', text: dims }),
      ]);
      thumb.appendChild(el('span', {
        class: 'del',
        title: 'Delete permanently',
        text: '×',
        onclick: async (event) => {
          event.stopPropagation();
          try {
            const updated = await api.removeImage(boardId, zoneId, sha);
            room.images = updated.images;
            room.candidates = updated.candidates;
            room.selected = updated.selected;
            logLine('dupe', `${sourceLabel(image.src)} — deleted`, 'removed');
            renderCandidates();
            renderSelected();
            schedule();
            emit('data');
          } catch (err) { toast(err.message, 'error'); }
        },
      }));
      candidateGrid.appendChild(thumb);
      register(sha, url);
    }
  }

  // -- pane 2: selected -----------------------------------------------------

  const selectedList = el('div', { class: 'sel-list' });
  const paletteStrip = el('div', { class: 'palette' });
  const selectedCount = el('span', { class: 'pane-count' });

  const selectedPane = el('section', { class: 'pane pane-selected' }, [
    el('div', { class: 'pane-head' }, [
      el('span', { class: 'eyebrow', text: 'On the board' }),
      selectedCount,
    ]),
    selectedList,
    el('div', { class: 'palette-wrap' }, [
      el('span', { class: 'eyebrow', text: 'Palette' }),
      paletteStrip,
    ]),
  ]);

  function select(sha) {
    if (room.selected.some((s) => s.sha === sha)) return;
    const wasEmpty = room.selected.length === 0;
    room.selected.push({ sha, feature: false });
    touch();
    renderCandidates();
    renderSelected();
    schedule();
    spriteReact(wasEmpty ? 'cheer' : 'happy');
  }

  function deselect(sha) {
    room.selected = room.selected.filter((s) => s.sha !== sha);
    if (!room.candidates.includes(sha)) room.candidates.unshift(sha);
    touch();
    renderCandidates();
    renderSelected();
    schedule();
  }

  let dragFrom = null;

  function renderSelected() {
    selectedList.innerHTML = '';
    selectedCount.textContent = room.selected.length ? `${room.selected.length}` : '';

    if (!room.selected.length) {
      selectedList.appendChild(el('p', {
        class: 'note',
        text: `Click images on the left to build this ${label.one.toLowerCase()}. The order here is the order on the canvas.`,
      }));
    }

    room.selected.forEach((entry, index) => {
      const image = room.images[entry.sha];
      if (!image) return;
      const url = imageUrl(boardId, zoneId, image);

      const row = el('div', {
        class: `sel-row${entry.feature ? ' featured' : ''}`,
        draggable: 'true',
        'data-key': url,
      }, [
        el('span', { class: 'grip', text: '⠿' }),
        el('img', { src: url, loading: 'lazy', alt: '' }),
        el('div', { class: 'sel-meta' }, [
          el('div', { class: 'r1' }, [
            el('span', { class: 'sel-idx', text: `${index + 1}` }),
            el('span', { class: 'sel-dim', text: image.w ? `${image.w}×${image.h}` : '' }),
            el('span', { class: 'crop' }),
          ]),
          image.src && image.src.startsWith('http')
            ? el('a', { class: 'sel-src', href: image.src, target: '_blank',
              rel: 'noreferrer', text: sourceLabel(image.src), title: image.src })
            : el('span', { class: 'sel-src', text: sourceLabel(image.src) }),
        ]),
        el('button', {
          class: `icon star${entry.feature ? ' on' : ''}`,
          title: 'Hero row — full width, taller than the rows around it',
          text: '★',
          onclick: () => { entry.feature = !entry.feature; touch(); schedule(); renderSelected(); },
        }),
        el('button', {
          class: 'icon', title: 'Remove from board', text: '×',
          onclick: () => deselect(entry.sha),
        }),
      ]);

      row.addEventListener('dragstart', (event) => {
        dragFrom = index;
        row.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(index));
      });
      row.addEventListener('dragend', () => { dragFrom = null; renderSelected(); });
      row.addEventListener('dragover', (event) => {
        event.preventDefault();
        if (dragFrom === null || dragFrom === index) return;
        const [moved] = room.selected.splice(dragFrom, 1);
        room.selected.splice(index, 0, moved);
        dragFrom = index;
        touch();
        renderSelected();
        schedule();
      });

      selectedList.appendChild(row);
      register(entry.sha, url);
    });

    renderPalette();
    renderCrops();
  }

  /**
   * Patch the crop readouts in place from the last drawn layout.
   *
   * Deliberately not part of renderSelected: the numbers come from the draw,
   * and re-rendering the list from inside a draw would loop.
   */
  function renderCrops() {
    for (const row of selectedList.querySelectorAll('.sel-row')) {
      const node = row.querySelector('.crop');
      if (!node) continue;
      const box = lastBoxes.find((b) => b.key === row.dataset.key);
      const natural = box && box.item ? box.item.aspect : null;
      if (!box || !natural) { node.textContent = ''; node.className = 'crop'; continue; }
      const cell = box.w / box.h;
      const shown = Math.min(1, cell / natural, natural / cell);
      const pct = Math.round(shown * 100);
      node.textContent = `${pct}% shown`;
      node.className = `crop${pct >= 80 ? '' : pct >= 55 ? ' warn' : ' hot'}`;
      node.title = pct >= 99
        ? 'the whole image is visible on the board'
        : `${100 - pct}% is cropped away to fill its tile`;
    }
  }

  function renderPalette() {
    paletteStrip.innerHTML = '';
    const colors = room.selected
      .map((entry) => room.images[entry.sha] && room.images[entry.sha].color)
      .filter(Boolean);
    if (!colors.length) {
      paletteStrip.appendChild(el('span', { class: 'muted tiny', text: 'appears as images load' }));
      return;
    }
    for (const color of colors.slice(0, 14)) {
      paletteStrip.appendChild(el('span', { class: 'chip', style: `background:${color}`, title: color }));
    }
  }

  // -- pane 3: board --------------------------------------------------------

  const canvas = el('canvas', { class: 'board-canvas' });
  const gutter = el('input', { type: 'range', min: '0', max: '48', step: '1',
    value: String(room.gutter ?? 8) });
  const bg = el('input', { type: 'color', value: room.bg || '#ffffff' });
  const gutterOut = el('span', { class: 'num', text: String(room.gutter ?? 8) });

  let aspectMode = 'room';
  const aspectToggle = el('div', { class: 'seg' }, [
    el('button', { class: 'seg-btn', 'data-mode': 'room', text: 'Room shape' }),
    el('button', { class: 'seg-btn', 'data-mode': 'fit', text: 'Fit panel' }),
  ]);
  aspectToggle.addEventListener('click', (event) => {
    const mode = event.target.dataset.mode;
    if (!mode) return;
    aspectMode = mode;
    syncSeg();
    schedule();
  });
  function syncSeg() {
    aspectToggle.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset.mode === aspectMode);
    });
  }
  syncSeg();

  gutter.addEventListener('input', () => {
    room.gutter = Number(gutter.value);
    gutterOut.textContent = gutter.value;
    touch();
    schedule();
  });
  bg.addEventListener('input', () => { room.bg = bg.value; touch(); schedule(); });

  const boardWrap = el('div', { class: 'board-wrap' }, [canvas]);
  const boardPane = el('section', { class: 'pane pane-board' }, [
    el('div', { class: 'pane-head' }, [
      el('span', { class: 'eyebrow', text: 'Board' }),
      aspectToggle,
    ]),
    boardWrap,
    el('div', { class: 'board-controls' }, [
      el('label', { class: 'ctl' }, [el('span', { text: 'Buffer' }), gutter, gutterOut]),
      el('label', { class: 'ctl' }, [el('span', { text: 'Ground' }), bg]),
      el('span', { class: 'spacer' }),
      el('button', { class: 'primary small', text: 'Export PNG', onclick: exportRoom }),
    ]),
  ]);

  triad.appendChild(intake);
  triad.appendChild(selectedPane);
  triad.appendChild(boardPane);

  // -- image metadata backfill ---------------------------------------------
  //
  // Intrinsic size comes from the server's header parse where it can manage
  // it; anything it could not read (and every average colour) is filled in
  // here once the browser has actually decoded the file, then persisted.

  const persistMeta = debounce(() => { touch(); }, 800);

  function register(sha, url) {
    const image = room.images[sha];
    if (!image) return;
    const entry = loadImage(url);
    entry.promise.then((loaded) => {
      let changed = false;
      if (!image.w || !image.h) {
        image.w = loaded.naturalWidth;
        image.h = loaded.naturalHeight;
        changed = true;
      }
      if (!image.color) {
        image.color = averageColor(loaded);
        changed = true;
      }
      if (changed) { persistMeta(); renderPalette(); }
      schedule();
    }).catch(() => {});
  }

  function items() {
    return room.selected.map((entry) => {
      const image = room.images[entry.sha];
      if (!image) return null;
      const aspect = image.w && image.h ? image.w / image.h : 1;
      return { key: imageUrl(boardId, zoneId, image), aspect, feature: entry.feature, sha: entry.sha };
    }).filter(Boolean);
  }

  // -- drawing --------------------------------------------------------------

  let frame = null;
  let lastBoxes = [];
  function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  }

  function boardBox() {
    const box = boardWrap.getBoundingClientRect();
    const pad = 16;
    const availW = Math.max(80, box.width - pad * 2);
    const availH = Math.max(80, box.height - pad * 2);
    if (aspectMode === 'fit') return { w: availW, h: availH };
    // Match the room's true footprint so the preview is what you'll stitch.
    const ratio = meta.rect.w / meta.rect.h;
    let w = availW;
    let h = w / ratio;
    if (h > availH) { h = availH; w = h * ratio; }
    return { w, h };
  }

  function draw() {
    const { w, h } = boardBox();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = room.bg || '#ffffff';
    ctx.fillRect(0, 0, w, h);

    const list = items();
    if (!list.length) {
      lastBoxes = [];
      ctx.fillStyle = 'rgba(140,132,118,.8)';
      ctx.font = '400 12.5px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('this room has no board yet', w / 2, h / 2);
      renderRoomFacts(null);
      spriteRest('sleep');
      return;
    }

    const pad = Math.max(6, room.gutter ?? 8);
    const innerW = w - pad * 2;
    const innerH = h - pad * 2;
    const boxes = layout(list, { width: innerW, height: innerH, gutter: room.gutter ?? 8 });
    ctx.save();
    ctx.translate(pad, pad);
    drawBoxes(ctx, boxes, cachedImage, { radius: 3 });
    ctx.restore();

    lastBoxes = boxes;
    spriteRest('idle');

    // Report how much of the footprint the board actually covers.
    const spanW = Math.max(...boxes.map((b) => b.x + b.w)) - Math.min(...boxes.map((b) => b.x));
    const spanH = Math.max(...boxes.map((b) => b.y + b.h)) - Math.min(...boxes.map((b) => b.y));
    const fw = Math.round((spanW / innerW) * 100);
    const fh = Math.round((spanH / innerH) * 100);
    renderRoomFacts(fw >= 99 && fh >= 99 ? 'edge to edge' : `${fw}%×${fh}%`);
    renderCrops();
  }

  async function exportRoom() {
    const list = items();
    if (!list.length) { toast('Nothing on this board yet', 'error'); return; }
    const ratio = aspectMode === 'fit'
      ? canvas.clientWidth / canvas.clientHeight
      : meta.rect.w / meta.rect.h;
    const width = 2400;
    const height = Math.round(width / ratio);
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = room.bg || '#ffffff';
    ctx.fillRect(0, 0, width, height);

    // Scale the buffer with the canvas so spacing matches the preview.
    const scale = width / canvas.clientWidth;
    const g = (room.gutter ?? 8) * scale;
    const pad = Math.max(6 * scale, g);
    const boxes = layout(list, { width: width - pad * 2, height: height - pad * 2, gutter: g });
    ctx.save();
    ctx.translate(pad, pad);
    drawBoxes(ctx, boxes, cachedImage, { radius: 3 * scale });
    ctx.restore();

    await exportPng(out, `${boardId}-${zoneId}.png`);
  }

  // -- input wiring ---------------------------------------------------------

  function onPaste(event) {
    if (/input|textarea/i.test(document.activeElement.tagName) &&
        document.activeElement !== document.body) {
      // A text paste into the URL box is handled by the box itself; only
      // intercept when the clipboard actually carries an image.
      const hasImage = [...(event.clipboardData?.items || [])]
        .some((item) => item.type.startsWith('image/'));
      if (!hasImage) return;
    }
    const items_ = [...(event.clipboardData?.items || [])];
    const imageItem = items_.find((item) => item.type.startsWith('image/'));
    if (imageItem) {
      event.preventDefault();
      const blob = imageItem.getAsFile();
      if (blob) addBlob(blob, 'clipboard');
      return;
    }
    const text = event.clipboardData?.getData('text/plain') || '';
    if (/^https?:\/\//i.test(text.trim()) && document.activeElement !== urlBox) {
      event.preventDefault();
      urlBox.value = text.trim();
      addUrls();
    }
  }
  window.addEventListener('paste', onPaste);

  ['dragover', 'drop', 'dragleave'].forEach((type) => {
    intake.addEventListener(type, (event) => {
      event.preventDefault();
      intake.classList.toggle('dragging', type === 'dragover');
      if (type !== 'drop') return;
      const files = [...(event.dataTransfer.files || [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) {
        files.forEach((file) => addBlob(file, file.name));
        return;
      }
      const text = event.dataTransfer.getData('text/uri-list') ||
        event.dataTransfer.getData('text/plain');
      if (text) { urlBox.value = text; addUrls(); }
    });
  });

  const observer = new ResizeObserver(schedule);
  observer.observe(boardWrap);

  renderRoomFacts(null);
  renderCandidates();
  renderSelected();
  spriteRest(room.selected.length ? 'idle' : 'sleep');
  schedule();

  return () => {
    window.removeEventListener('paste', onPaste);
    observer.disconnect();
    cancelAnimationFrame(frame);
    if (dirty) save.flush();
  };
}
