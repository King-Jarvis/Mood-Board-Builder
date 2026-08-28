// The rail: the current board's zones, on every screen inside that board.
//
// You never lose sight of the whole board while working inside one zone. Every
// zone is listed with its live count and a fill meter, so "what's left to do"
// is answered without navigating. Save state sits at the bottom for the same
// reason -- work that has persisted should say so.
//
// On the dashboard there is no board in scope, so the rail collapses to the
// product name and the save state.

import { api, el, on, emit, parseHash } from './app.js';
import { createSprite } from './sprite.js';

// Zones rarely hold more than a dozen images; treat that as a full board for
// the meter so the scale stays meaningful.
const FULL = 10;

const ICONS = {
  board: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">'
    + '<rect x="1.6" y="2.2" width="12.8" height="11.6" rx="1"/>'
    + '<path d="M1.6 8h5.2M6.8 2.2v11.6M6.8 5.4h7.6"/></svg>',
  mosaic: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">'
    + '<rect x="1.6" y="2.2" width="5.4" height="5.4" rx="1"/>'
    + '<rect x="9" y="2.2" width="5.4" height="5.4" rx="1"/>'
    + '<rect x="1.6" y="8.4" width="5.4" height="5.4" rx="1"/>'
    + '<rect x="9" y="8.4" width="5.4" height="5.4" rx="1"/></svg>',
  back: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">'
    + '<path d="M9.5 3.5 5 8l4.5 4.5"/></svg>',
};

let sprite = null;
let refreshing = null;
let refreshPending = false;
let currentBoardId = null;

export function mountRail() {
  const host = document.getElementById('rail');
  sprite = createSprite();

  host.appendChild(el('div', { class: 'rail-head', id: 'rail-head' }));
  host.appendChild(el('nav', { class: 'rail-nav', id: 'rail-nav' }));
  host.appendChild(el('div', { class: 'rail-rooms' }, [
    el('div', { class: 'rail-rooms-head', id: 'rail-zones-head' }),
    el('div', { id: 'rail-list' }),
  ]));
  host.appendChild(el('div', { class: 'rail-foot' }, [
    sprite.el,
    el('div', { class: 'savestate saved', id: 'savestate' }, [
      el('div', { class: 's1', text: 'Ready' }),
      el('div', { class: 's2', text: 'everything saved' }),
    ]),
  ]));

  on('data', refresh);
  on('route', (target) => {
    if (target.boardId !== currentBoardId) {
      currentBoardId = target.boardId || null;
      refresh();
    } else {
      markActive();
    }
  });
  currentBoardId = parseHash().boardId || null;
  refresh();
}

export async function refresh() {
  // Coalesce rather than drop. The board changes while a refresh is already in
  // flight on every navigation into a board -- dropping the second call left
  // the rail showing the dashboard forever.
  if (refreshing) {
    refreshPending = true;
    return refreshing;
  }
  refreshing = (async () => {
    try {
      if (!currentBoardId) renderDashboardRail();
      else render(await api.getBoard(currentBoardId));
    } catch (err) {
      renderDashboardRail(err.message);
    }
  })();
  await refreshing;
  refreshing = null;
  if (refreshPending) {
    refreshPending = false;
    return refresh();
  }
  return undefined;
}

function renderDashboardRail(error) {
  document.getElementById('rail-head').innerHTML = '';
  document.getElementById('rail-head').append(
    el('h1', { class: 'rail-title', text: 'Mood Board Builder' }),
    el('div', { class: 'rail-sub', text: error || 'pick or make a board' }));
  document.getElementById('rail-nav').innerHTML = '';
  document.getElementById('rail-zones-head').innerHTML = '';
  document.getElementById('rail-list').innerHTML = '';
  if (sprite) sprite.rest('idle');
}

function render(board) {
  const label = board.zoneLabel || { one: 'Zone', many: 'Zones' };
  const counts = board.counts || {};
  const total = board.zones.length;
  const filled = board.zones.filter((z) => (counts[z.id] || {}).selected > 0).length;
  const images = board.zones.reduce((s, z) => s + ((counts[z.id] || {}).selected || 0), 0);

  const head = document.getElementById('rail-head');
  head.innerHTML = '';
  head.append(
    el('a', { class: 'rail-back', href: '#/', html: `${ICONS.back}<span>All boards</span>` }),
    el('h1', { class: 'rail-title', text: board.name }),
    el('div', {
      class: 'rail-sub',
      text: total
        ? `${filled} of ${total} ${label.many.toLowerCase()} · ${images} image${images === 1 ? '' : 's'}`
        : `no ${label.many.toLowerCase()} yet`,
    }));

  const nav = document.getElementById('rail-nav');
  nav.innerHTML = '';
  nav.append(
    el('a', {
      href: `#/b/${board.id}`, 'data-view': 'board',
      html: `${ICONS.board}<span>${board.background ? 'Plan' : 'Canvas'}</span>`,
    }),
    el('a', {
      href: `#/b/${board.id}/mosaic`, 'data-view': 'mosaic',
      html: `${ICONS.mosaic}<span>Mosaic View</span>`,
    }));

  const zhead = document.getElementById('rail-zones-head');
  zhead.innerHTML = '';
  zhead.append(
    el('span', { class: 'eyebrow', text: label.many }),
    el('span', { class: 'spacer' }),
    el('span', { class: 'num', text: total ? `${filled}/${total}` : '' }));

  const list = document.getElementById('rail-list');
  list.innerHTML = '';
  if (!total) {
    list.appendChild(el('div', { class: 'note muted tiny',
      text: `Draw ${label.many.toLowerCase()} on the board to see them here.` }));
    return;
  }
  for (const zone of board.zones) {
    const count = (counts[zone.id] || {}).selected || 0;
    const pending = (counts[zone.id] || {}).candidates || 0;
    list.appendChild(el('a', {
      class: `room-item${count ? '' : ' blank'}`,
      href: `#/b/${board.id}/z/${zone.id}`,
      'data-zone': zone.id,
      title: count
        ? `${count} on board${pending > count ? `, ${pending - count} waiting` : ''}`
        : (pending ? `${pending} waiting to be chosen` : 'no images yet'),
    }, [
      el('span', { class: 'dot', style: `background:${zone.color}` }),
      el('span', { class: 'nm', text: zone.name }),
      el('span', { class: 'ct', text: count ? String(count) : '—' }),
      el('span', { class: 'fill' }, [
        el('i', { style: `width:${Math.min(100, (count / FULL) * 100)}%` })]),
    ]));
  }
  markActive();
}

function markActive() {
  const target = parseHash();
  document.querySelectorAll('.rail-nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.view === target.name);
  });
  document.querySelectorAll('.room-item').forEach((a) => {
    a.classList.toggle('active', a.dataset.zone === target.zoneId);
  });
}

// -- save state -------------------------------------------------------------

let savedAt = null;
let tick = null;

export function setSaveState(kind, detail) {
  const node = document.getElementById('savestate');
  if (!node) return;
  node.className = `savestate ${kind}`;
  const [s1, s2] = node.children;
  if (kind === 'pending') {
    s1.textContent = 'Saving…';
    s2.textContent = detail || 'writing to disk';
  } else if (kind === 'failed') {
    s1.textContent = 'Not saved';
    s2.textContent = detail || 'check the server';
  } else {
    savedAt = Date.now();
    s1.textContent = 'Saved';
    s2.textContent = 'just now';
    clearInterval(tick);
    tick = setInterval(() => {
      const node2 = document.getElementById('savestate');
      if (!node2 || savedAt === null) return;
      const secs = Math.round((Date.now() - savedAt) / 1000);
      node2.children[1].textContent = secs < 5 ? 'just now'
        : secs < 60 ? `${secs}s ago` : `${Math.round(secs / 60)}m ago`;
    }, 5000);
  }
}

export function spriteReact(mood, hold) { if (sprite) sprite.react(mood, hold); }
export function spriteRest(mood) { if (sprite) sprite.rest(mood); }
