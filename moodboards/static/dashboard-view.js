// The dashboard: every board you have, and the way to make another.
//
// A board is any subject you want to collect imagery for -- a house, a van
// build, a wedding, a wardrobe. Each one chooses its own word for its regions,
// so a house says "Rooms" and a van build says "Areas", while the engine
// underneath treats them identically.

import {
  api, coverUrl, el, toast, navigate, relativeTime, emit,
} from './app.js';
import { spriteRest, spriteReact } from './rail.js';

const PRESETS = [
  { label: 'House', subject: 'Home', one: 'Room', many: 'Rooms' },
  { label: 'Garden', subject: 'Outdoor', one: 'Bed', many: 'Beds' },
  { label: 'Van build', subject: 'Vehicle', one: 'Area', many: 'Areas' },
  { label: 'Event', subject: 'Event', one: 'Moment', many: 'Moments' },
  { label: 'Wardrobe', subject: 'Style', one: 'Look', many: 'Looks' },
  { label: 'Anything', subject: '', one: 'Zone', many: 'Zones' },
];

export async function mountDashboard(root) {
  let boards = await api.listBoards();
  spriteRest(boards.length ? 'idle' : 'sleep');

  const grid = el('div', { class: 'board-grid' });
  const facts = el('div', { class: 'facts' });

  root.appendChild(el('div', { class: 'bar' }, [
    el('h1', { text: 'Boards' }),
    el('div', { class: 'divider' }),
    facts,
    el('span', { class: 'spacer' }),
    el('button', { class: 'primary', text: 'New board', onclick: () => openEditor(null) }),
  ]));
  root.appendChild(el('div', { class: 'dash-stage' }, [grid]));

  function renderFacts() {
    facts.innerHTML = '';
    const zones = boards.reduce((s, b) => s + b.zones, 0);
    const images = boards.reduce((s, b) => s + b.images, 0);
    for (const [value, label] of [
      [String(boards.length), boards.length === 1 ? 'board' : 'boards'],
      [String(zones), 'zones'],
      [String(images), 'images'],
    ]) {
      facts.appendChild(el('span', { class: 'fact' }, [
        el('b', { class: 'num', text: value }), el('span', { text: label })]));
    }
  }

  function render() {
    renderFacts();
    grid.innerHTML = '';
    if (!boards.length) {
      grid.appendChild(el('div', { class: 'empty-state' }, [
        el('p', { text: 'No boards yet.' }),
        el('p', { class: 'muted',
          text: 'A board is any subject you want to gather a feel for — a house, a garden, a trip, a wardrobe. Give it a background to trace, or start on a blank canvas.' }),
        el('button', { class: 'primary', text: 'Make your first board',
          onclick: () => openEditor(null) }),
      ]));
      return;
    }
    for (const board of boards) grid.appendChild(card(board));
  }

  function card(board) {
    const label = board.zoneLabel || { one: 'Zone', many: 'Zones' };
    const cover = board.cover
      ? el('img', { src: coverUrl(board.id), alt: '', loading: 'lazy' })
      : el('div', { class: 'cover-blank', text: board.hasBackground ? 'no images yet' : 'blank canvas' });

    return el('article', { class: 'board-card' }, [
      el('a', { class: 'cover', href: `#/b/${board.id}`, title: `Open ${board.name}` }, [cover]),
      el('div', { class: 'card-body' }, [
        el('a', { class: 'card-name', href: `#/b/${board.id}`, text: board.name }),
        el('div', { class: 'card-sub', text: board.subject || '—' }),
        el('div', { class: 'card-stats' }, [
          el('span', { class: 'num', text: `${board.filled}/${board.zones}` }),
          el('span', { text: label.many.toLowerCase() }),
          el('span', { class: 'dotsep', text: '·' }),
          el('span', { class: 'num', text: String(board.images) }),
          el('span', { text: 'images' }),
        ]),
        el('div', { class: 'card-foot' }, [
          el('span', { class: 'tiny muted', text: relativeTime(board.updated) }),
          el('span', { class: 'spacer' }),
          el('button', { class: 'icon', title: 'Edit details', text: '✎',
            onclick: () => openEditor(board) }),
          el('button', { class: 'icon danger', title: 'Delete board', text: '×',
            onclick: () => remove(board) }),
        ]),
      ]),
    ]);
  }

  // -- create / edit --------------------------------------------------------

  function openEditor(board) {
    const isNew = !board;
    const values = {
      name: board ? board.name : '',
      subject: board ? board.subject : '',
      one: board ? board.zoneLabel.one : 'Room',
      many: board ? board.zoneLabel.many : 'Rooms',
    };

    const nameInput = el('input', { type: 'text', value: values.name,
      placeholder: 'Our House', class: 'field' });
    const subjectInput = el('input', { type: 'text', value: values.subject,
      placeholder: 'Home renovation', class: 'field' });
    const oneInput = el('input', { type: 'text', value: values.one, class: 'field short' });
    const manyInput = el('input', { type: 'text', value: values.many, class: 'field short' });

    const presets = el('div', { class: 'presets' },
      PRESETS.map((p) => el('button', {
        class: 'ghost small', text: p.label,
        onclick: () => {
          subjectInput.value = p.subject;
          oneInput.value = p.one;
          manyInput.value = p.many;
        },
      })));

    const body = el('div', { class: 'form' }, [
      field('Name', nameInput, 'What is this board of?'),
      field('Subject', subjectInput, 'Optional — a short description.'),
      isNew ? el('div', { class: 'form-row' }, [
        el('label', { class: 'form-label', text: 'Start from' }), presets,
      ]) : null,
      el('div', { class: 'form-row' }, [
        el('label', { class: 'form-label', text: 'Call its parts' }),
        el('div', { class: 'pair' }, [
          oneInput, el('span', { class: 'muted tiny', text: 'one' }),
          manyInput, el('span', { class: 'muted tiny', text: 'many' }),
        ]),
      ]),
      el('p', { class: 'form-hint',
        text: 'A house has Rooms; a van build has Areas. This wording is used everywhere inside the board.' }),
    ]);

    modal(isNew ? 'New board' : 'Board details', body, async () => {
      const name = nameInput.value.trim();
      if (!name) { toast('Give the board a name', 'error'); return false; }
      const attrs = {
        name,
        subject: subjectInput.value.trim(),
        zoneLabel: {
          one: oneInput.value.trim() || 'Zone',
          many: manyInput.value.trim() || 'Zones',
        },
      };
      try {
        if (isNew) {
          const created = await api.createBoard(attrs);
          spriteReact('cheer');
          toast(`Created “${created.name}”`);
          navigate(`#/b/${created.id}`);
          return true;
        }
        const full = await api.getBoard(board.id);
        Object.assign(full, attrs);
        await api.putBoard(board.id, full);
        boards = await api.listBoards();
        render();
        emit('data');
        toast('Saved');
        return true;
      } catch (err) {
        toast(err.message, 'error');
        return false;
      }
    }, isNew ? 'Create' : 'Save');

    setTimeout(() => nameInput.focus(), 30);
  }

  // Typing the name is the confirmation: a board is a lot of curation to lose.
  function remove(board) {
    const confirmInput = el('input', { type: 'text', class: 'field',
      placeholder: board.name });
    const body = el('div', { class: 'form' }, [
      el('p', { text: `Delete “${board.name}” and everything in it — ${board.zones} zones and ${board.images} images. This cannot be undone.` }),
      field('Type the board name to confirm', confirmInput, ''),
    ]);
    modal('Delete board', body, async () => {
      if (confirmInput.value.trim() !== board.name) {
        toast('Name does not match', 'error');
        return false;
      }
      try {
        await api.deleteBoard(board.id, board.name);
        boards = await api.listBoards();
        render();
        emit('data');
        toast(`Deleted “${board.name}”`);
        return true;
      } catch (err) {
        toast(err.message, 'error');
        return false;
      }
    }, 'Delete', true);
    setTimeout(() => confirmInput.focus(), 30);
  }

  render();
  return () => closeModal();
}

// -- small form + modal helpers ---------------------------------------------

function field(label, input, hint) {
  return el('div', { class: 'form-row' }, [
    el('label', { class: 'form-label', text: label }),
    el('div', { class: 'form-control' }, [
      input, hint ? el('span', { class: 'form-hint', text: hint }) : null,
    ]),
  ]);
}

let openModal = null;

function closeModal() {
  if (openModal) { openModal.remove(); openModal = null; }
  document.removeEventListener('keydown', onModalKey);
}

function onModalKey(event) {
  if (event.key === 'Escape') closeModal();
}

function modal(title, body, onConfirm, confirmLabel = 'Save', danger = false) {
  closeModal();
  const confirmBtn = el('button', {
    class: danger ? 'primary danger-btn' : 'primary',
    text: confirmLabel,
    onclick: async () => {
      confirmBtn.disabled = true;
      const done = await onConfirm();
      confirmBtn.disabled = false;
      if (done) closeModal();
    },
  });
  const sheet = el('div', { class: 'modal-sheet' }, [
    el('div', { class: 'modal-head' }, [el('h2', { text: title })]),
    el('div', { class: 'modal-body' }, [body]),
    el('div', { class: 'modal-foot' }, [
      el('span', { class: 'spacer' }),
      el('button', { class: 'ghost', text: 'Cancel', onclick: closeModal }),
      confirmBtn,
    ]),
  ]);
  sheet.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') confirmBtn.click();
  });
  openModal = el('div', { class: 'modal-backdrop',
    onclick: (e) => { if (e.target === openModal) closeModal(); } }, [sheet]);
  document.body.appendChild(openModal);
  document.addEventListener('keydown', onModalKey);
}

export { modal, field, closeModal };
