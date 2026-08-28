// The board: zones laid out over a background, or drawn on a blank canvas.
//
// Zone rects are normalised 0-1, which is what lets a board work either way --
// with an image behind them or nothing at all, the geometry is identical, so
// the mosaic and the export do not care which kind of board this is.

import {
  api, backgroundUrl, el, toast, navigate, debounce, emit,
} from './app.js';
import { setSaveState, spriteReact, spriteRest } from './rail.js';

const PALETTE = ['#c8a882', '#8ea9a1', '#b79098', '#9aa7c0', '#c2b280',
  '#a89bb0', '#8fa88b', '#c49a7c', '#93a5b5', '#b3a293'];

const MIN_SIZE = 0.015;

function slug(name) {
  return (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'zone').slice(0, 48);
}

export async function mountBoard(root, target) {
  const boardId = target.boardId;
  const board = await api.getBoard(boardId);
  const label = board.zoneLabel || { one: 'Zone', many: 'Zones' };
  let selectedId = null;
  let saveQueued = false;

  const save = debounce(async () => {
    saveQueued = false;
    try {
      await api.putBoard(boardId, board);
      setSaveState('saved');
      emit('data');
    } catch (err) {
      setSaveState('failed', err.message);
      toast(err.message, 'error');
    }
  }, 350);
  const touch = () => { saveQueued = true; setSaveState('pending'); save(); };

  const fileInput = el('input', { type: 'file', accept: 'image/*', class: 'hidden' });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) uploadBackground(fileInput.files[0]);
  });

  const facts = el('div', { class: 'facts' });
  const bar = el('div', { class: 'bar' }, [
    el('h1', { text: board.name }),
    el('div', { class: 'divider' }),
    facts,
    el('span', { class: 'spacer' }),
    el('span', { class: 'sub', text: `drag to add a ${label.one.toLowerCase()}` }),
    el('button', { class: 'ghost small', text: board.background ? 'Replace image' : 'Add image',
      onclick: () => fileInput.click() }),
    board.background
      ? el('button', { class: 'ghost small', text: 'Use blank canvas', onclick: clearBackground })
      : null,
    el('a', { class: 'primary btn small', href: `#/b/${boardId}/mosaic`, text: 'Mosaic View →' }),
  ]);

  const editor = el('div', { class: 'facts', id: 'zone-editor' });
  const editorStrip = el('div', { class: 'bar', style: 'padding:6px 16px' }, [editor]);
  const stage = el('div', { class: 'plan-stage' });

  root.append(bar, editorStrip, fileInput, stage);

  function renderFacts() {
    facts.innerHTML = '';
    const counts = board.counts || {};
    const filled = board.zones.filter((z) => (counts[z.id] || {}).selected > 0).length;
    const images = board.zones.reduce((s, z) => s + ((counts[z.id] || {}).selected || 0), 0);
    const items = [
      [String(board.zones.length), label.many],
      [`${filled}/${board.zones.length}`, 'filled'],
      [String(images), 'images'],
      [board.background ? `${board.background.w}×${board.background.h}` : 'blank canvas',
        board.background ? 'image' : 'no image'],
    ];
    for (const [value, name] of items) {
      facts.appendChild(el('span', { class: 'fact' }, [
        el('b', { class: 'num', text: value }), el('span', { text: name })]));
    }
  }

  // -- background -----------------------------------------------------------

  async function uploadBackground(file) {
    try {
      toast('Uploading…');
      const updated = await api.uploadBackground(boardId, file);
      board.background = updated.background;
      setSaveState('saved');
      emit('data');
      spriteReact('happy');
      toast(`Image added — ${updated.background.w}×${updated.background.h}`);
      render();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function clearBackground() {
    if (!confirm('Remove the background image? Your zones and images stay exactly where they are.')) return;
    try {
      const updated = await api.clearBackground(boardId);
      board.background = updated.background;
      setSaveState('saved');
      emit('data');
      toast('Now a blank canvas');
      render();
    } catch (err) { toast(err.message, 'error'); }
  }

  ['dragover', 'drop'].forEach((type) => {
    stage.addEventListener(type, (event) => {
      event.preventDefault();
      stage.classList.toggle('dragging', type === 'dragover');
      if (type === 'drop') {
        stage.classList.remove('dragging');
        const file = event.dataTransfer.files[0];
        if (file && file.type.startsWith('image/')) uploadBackground(file);
      }
    });
  });
  stage.addEventListener('dragleave', () => stage.classList.remove('dragging'));

  // -- zone editor ----------------------------------------------------------

  function renderEditor() {
    editor.innerHTML = '';
    const zone = board.zones.find((z) => z.id === selectedId);
    if (!zone) {
      editor.appendChild(el('span', { class: 'sub',
        text: board.zones.length
          ? `no ${label.one.toLowerCase()} selected`
          : `drag a box to add your first ${label.one.toLowerCase()}` }));
      return;
    }
    const counts = (board.counts || {})[zone.id] || { selected: 0 };

    const nameInput = el('input', { type: 'text', class: 'field inline', value: zone.name });
    nameInput.addEventListener('input', () => {
      zone.name = nameInput.value;
      touch();
      drawZones(stage.querySelector('.plan-svg'));
      renderEditor.updateIdHint();
    });

    const swatch = el('input', { type: 'color', value: zone.color });
    swatch.addEventListener('input', () => {
      zone.color = swatch.value;
      touch();
      drawZones(stage.querySelector('.plan-svg'));
    });

    const notes = el('input', { type: 'text', class: 'field', value: zone.notes || '',
      placeholder: 'notes — materials, mood, anything' });
    notes.addEventListener('input', () => { zone.notes = notes.value; touch(); });

    // The folder id is minted from the name at creation and then frozen, so a
    // typo made once would otherwise live on disk forever.
    const idHint = el('span', { class: 'tiny muted' });
    const fixBtn = el('button', { class: 'ghost small', text: 'Fix folder name',
      onclick: () => fixFolder(zone) });
    renderEditor.updateIdHint = () => {
      const want = slug(zone.name || zone.id);
      const stale = want !== zone.id;
      idHint.textContent = `folder: ${zone.id}`;
      fixBtn.style.display = stale ? '' : 'none';
    };

    editor.append(
      el('span', { style: `background:${zone.color};width:9px;height:9px;border-radius:2px;flex:none` }),
      nameInput, swatch, notes,
      el('span', { class: 'sub', text: counts.selected ? `${counts.selected} on board` : 'empty' }),
      idHint, fixBtn,
      el('button', { class: 'ghost small', text: 'Open',
        onclick: () => navigate(`#/b/${boardId}/z/${zone.id}`) }),
      el('button', { class: 'icon danger', title: `Delete ${label.one} (⌫)`, text: '×',
        onclick: () => removeZone(zone) }));
    renderEditor.updateIdHint();
  }

  async function fixFolder(zone) {
    const want = slug(zone.name || zone.id);
    if (!confirm(`Rename this ${label.one.toLowerCase()}'s folder from "${zone.id}" to "${want}"? Its images move with it.`)) return;
    try {
      const updated = await api.renameZoneId(boardId, zone.id, want);
      board.zones = updated.zones;
      board.counts = updated.counts;
      selectedId = updated.newId;
      emit('data');
      toast(`Folder renamed to ${updated.newId}`);
      render();
    } catch (err) { toast(err.message, 'error'); }
  }

  function removeZone(zone) {
    if (!confirm(`Remove "${zone.name}" from this board? Its images stay on disk.`)) return;
    board.zones = board.zones.filter((z) => z.id !== zone.id);
    selectedId = null;
    touch();
    render();
  }

  // -- rendering ------------------------------------------------------------

  function render() {
    renderFacts();
    renderEditor();
    stage.innerHTML = '';
    spriteRest(board.zones.length ? 'idle' : 'sleep');

    const bg = board.background;
    const ar = bg && bg.w && bg.h
      ? bg.w / bg.h
      : (board.canvas.w / board.canvas.h) || 1.6;

    const hold = el('div', { class: 'plan-hold' });
    const frame = el('div', {
      class: `plan-frame${bg ? '' : ' canvas-mode'}`,
      style: `aspect-ratio:${ar};--ar:${ar}`,
    });
    if (bg) {
      frame.appendChild(el('img', { class: 'plan-img', src: backgroundUrl(boardId, bg), alt: '' }));
    }

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'plan-svg');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('viewBox', '0 0 1000 1000');
    frame.appendChild(svg);
    hold.appendChild(frame);
    stage.appendChild(hold);

    if (!bg && !board.zones.length) {
      stage.appendChild(el('div', { class: 'canvas-hint' }, [
        el('strong', { text: `Drag a box to add a ${label.one.toLowerCase()}` }),
        el('span', { text: 'or drop an image here to trace over instead' }),
      ]));
    }

    drawZones(svg);
    wireDrawing(svg, frame);
  }

  function drawZones(svg) {
    if (!svg) return;
    const NS = 'http://www.w3.org/2000/svg';
    const counts = board.counts || {};
    svg.innerHTML = '';
    for (const zone of board.zones) {
      const count = (counts[zone.id] || {}).selected || 0;
      const group = document.createElementNS(NS, 'g');
      group.setAttribute('class', `hotspot${zone.id === selectedId ? ' selected' : ''}`);
      group.dataset.id = zone.id;

      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', zone.rect.x * 1000);
      rect.setAttribute('y', zone.rect.y * 1000);
      rect.setAttribute('width', zone.rect.w * 1000);
      rect.setAttribute('height', zone.rect.h * 1000);
      rect.setAttribute('fill', zone.color);
      rect.setAttribute('fill-opacity', Math.min(0.42, count * 0.045).toFixed(3));
      rect.setAttribute('stroke', zone.color);
      rect.setAttribute('vector-effect', 'non-scaling-stroke');
      rect.setAttribute('stroke-width', '2');
      group.appendChild(rect);

      for (const handle of ['nw', 'ne', 'sw', 'se']) {
        const dot = document.createElementNS(NS, 'rect');
        const cx = zone.rect.x + (handle.includes('e') ? zone.rect.w : 0);
        const cy = zone.rect.y + (handle.includes('s') ? zone.rect.h : 0);
        dot.setAttribute('x', cx * 1000 - 6);
        dot.setAttribute('y', cy * 1000 - 6);
        dot.setAttribute('width', 12);
        dot.setAttribute('height', 12);
        dot.setAttribute('class', `handle handle-${handle}`);
        dot.setAttribute('fill', zone.color);
        dot.dataset.handle = handle;
        dot.dataset.id = zone.id;
        group.appendChild(dot);
      }
      svg.appendChild(group);
    }

    // Labels are HTML so they keep a constant readable size whatever the
    // board is scaled to.
    const frame = svg.parentElement;
    frame.querySelectorAll('.hotspot-label').forEach((n) => n.remove());
    for (const zone of board.zones) {
      const count = (counts[zone.id] || {}).selected || 0;
      const pending = (counts[zone.id] || {}).candidates || 0;
      const waiting = Math.max(0, pending - count);
      frame.appendChild(el('button', {
        class: 'hotspot-label',
        style: `left:${(zone.rect.x + zone.rect.w / 2) * 100}%;`
             + `top:${(zone.rect.y + zone.rect.h / 2) * 100}%;--tint:${zone.color}`,
        title: `Open ${zone.name}`,
        onclick: (event) => { event.stopPropagation(); navigate(`#/b/${boardId}/z/${zone.id}`); },
      }, [
        el('span', { class: 'l1', text: zone.name }),
        el('span', { class: 'l2',
          text: count ? `${count} on board${waiting ? ` · ${waiting} waiting` : ''}`
            : (waiting ? `${waiting} waiting` : 'empty') }),
      ]));
    }
  }

  // -- pointer interaction --------------------------------------------------

  function wireDrawing(svg, frame) {
    let mode = null;
    let origin = null;
    let targetZone = null;
    let handle = null;
    let ghost = null;

    const toNorm = (event) => {
      const box = frame.getBoundingClientRect();
      return {
        x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
        y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
      };
    };

    svg.addEventListener('pointerdown', (event) => {
      const point = toNorm(event);
      const node = event.target;
      svg.setPointerCapture(event.pointerId);

      if (node.dataset && node.dataset.handle) {
        mode = 'resize';
        handle = node.dataset.handle;
        targetZone = board.zones.find((z) => z.id === node.dataset.id);
        selectedId = targetZone.id;
      } else if (node.parentElement && node.parentElement.dataset.id) {
        mode = 'move';
        targetZone = board.zones.find((z) => z.id === node.parentElement.dataset.id);
        selectedId = targetZone.id;
        origin = { ...point, rect: { ...targetZone.rect } };
      } else {
        mode = 'draw';
        origin = point;
        selectedId = null;
        ghost = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        ghost.setAttribute('class', 'ghost');
        svg.appendChild(ghost);
      }
      drawZones(svg);
      renderEditor();
      if (ghost) svg.appendChild(ghost);
    });

    svg.addEventListener('pointermove', (event) => {
      if (!mode) return;
      const point = toNorm(event);
      if (mode === 'draw' && ghost) {
        ghost.setAttribute('x', Math.min(origin.x, point.x) * 1000);
        ghost.setAttribute('y', Math.min(origin.y, point.y) * 1000);
        ghost.setAttribute('width', Math.abs(point.x - origin.x) * 1000);
        ghost.setAttribute('height', Math.abs(point.y - origin.y) * 1000);
        return;
      }
      if (mode === 'move' && targetZone) {
        const r = targetZone.rect;
        r.x = Math.min(1 - r.w, Math.max(0, origin.rect.x + point.x - origin.x));
        r.y = Math.min(1 - r.h, Math.max(0, origin.rect.y + point.y - origin.y));
      }
      if (mode === 'resize' && targetZone) {
        const r = targetZone.rect;
        const right = r.x + r.w;
        const bottom = r.y + r.h;
        if (handle.includes('w')) { r.x = Math.min(point.x, right - MIN_SIZE); r.w = right - r.x; }
        if (handle.includes('e')) { r.w = Math.max(MIN_SIZE, point.x - r.x); }
        if (handle.includes('n')) { r.y = Math.min(point.y, bottom - MIN_SIZE); r.h = bottom - r.y; }
        if (handle.includes('s')) { r.h = Math.max(MIN_SIZE, point.y - r.y); }
      }
      drawZones(svg);
    });

    svg.addEventListener('pointerup', (event) => {
      const point = toNorm(event);
      if (mode === 'draw' && ghost) {
        ghost.remove();
        ghost = null;
        const rect = {
          x: Math.min(origin.x, point.x), y: Math.min(origin.y, point.y),
          w: Math.abs(point.x - origin.x), h: Math.abs(point.y - origin.y),
        };
        if (rect.w > MIN_SIZE && rect.h > MIN_SIZE) addZone(rect);
      } else if (mode) {
        touch();
      }
      mode = null; targetZone = null; handle = null; origin = null;
      render();
    });

    svg.addEventListener('pointercancel', () => {
      if (ghost) { ghost.remove(); ghost = null; }
      mode = null;
    });
  }

  function addZone(rect) {
    const name = prompt(`${label.one} name`, label.one);
    if (!name || !name.trim()) return;
    const base = slug(name);
    let id = base;
    let n = 2;
    while (board.zones.some((z) => z.id === id)) { id = `${base}-${n}`; n += 1; }
    board.zones.push({
      id, name: name.trim(), rect,
      color: PALETTE[board.zones.length % PALETTE.length], notes: '',
    });
    selectedId = id;
    touch();
    spriteReact('happy');
  }

  function onKey(event) {
    if (event.key === 'Backspace' && selectedId
        && !/input|textarea/i.test(document.activeElement.tagName)) {
      event.preventDefault();
      const zone = board.zones.find((z) => z.id === selectedId);
      if (zone) removeZone(zone);
    }
  }
  window.addEventListener('keydown', onKey);

  render();

  return () => {
    window.removeEventListener('keydown', onKey);
    if (saveQueued) save.flush();
  };
}
