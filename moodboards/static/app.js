// Router, API client, and the shared image cache.
//
// Every API call takes the board id as its first argument. The previous
// version pinned a single `HOUSE_ID` constant here, which is the only reason
// it could never hold more than one board -- the server was parameterised all
// along.

// -- api --------------------------------------------------------------------

async function request(method, path, body, headers = {}) {
  const options = { method, headers: { ...headers } };
  if (body instanceof Blob || body instanceof ArrayBuffer) {
    options.body = body;
  } else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const type = response.headers.get('Content-Type') || '';
  const payload = type.includes('json') ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error((payload && payload.error) || `${response.status} ${response.statusText}`);
  }
  return payload;
}

const B = (boardId) => `/api/boards/${encodeURIComponent(boardId)}`;
const Z = (boardId, zoneId) => `${B(boardId)}/zones/${encodeURIComponent(zoneId)}`;

export const api = {
  listBoards: () => request('GET', '/api/boards').then((r) => r.boards || []),
  createBoard: (attrs) => request('POST', '/api/boards', attrs),
  getBoard: (b) => request('GET', B(b)),
  putBoard: (b, board) => request('PUT', B(b), board),
  deleteBoard: (b, name) =>
    request('DELETE', `${B(b)}?confirm=${encodeURIComponent(name)}`),

  uploadBackground: (b, blob) => request('POST', `${B(b)}/background`, blob,
    { 'Content-Type': blob.type || 'image/png' }),
  clearBackground: (b) => request('DELETE', `${B(b)}/background`),

  getZone: (b, z) => request('GET', Z(b, z)),
  putZone: (b, z, zone) => request('PUT', Z(b, z), zone),
  renameZoneId: (b, z, newId) => request('POST', `${Z(b, z)}/rename-id`, { newId }),

  ingest: (b, z, urls) => request('POST', `${Z(b, z)}/ingest`, { urls }),
  upload: (b, z, blob, source) => request('POST', `${Z(b, z)}/upload`, blob,
    { 'Content-Type': blob.type || 'image/png', 'X-Source': source || 'pasted' }),
  removeImage: (b, z, sha) => request('DELETE', `${Z(b, z)}/images/${sha}`),

  saveExport: (blob, filename) => request('POST', '/api/export', blob,
    { 'Content-Type': 'image/png', 'X-Filename': filename }),
};

export function imageUrl(boardId, zoneId, meta) {
  return `/data/boards/${boardId}/zones/${zoneId}/images/${meta.file}`;
}

export function backgroundUrl(boardId, background) {
  return `/data/boards/${boardId}/${background.file}`;
}

export function coverUrl(boardId) {
  return `${B(boardId)}/cover`;
}

// -- image cache ------------------------------------------------------------
//
// Decoding is the slow part of redrawing a board, so every <img> is created
// once and reused by the zone view, the mosaic, the quick peek and every export.

const cache = new Map();

export function loadImage(url) {
  if (cache.has(url)) return cache.get(url);
  const image = new Image();
  const promise = new Promise((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`could not load ${url}`));
  });
  image.src = url;
  const entry = { image, promise };
  cache.set(url, entry);
  return entry;
}

export function cachedImage(url) {
  const entry = cache.get(url);
  return entry ? entry.image : null;
}

// -- colour -----------------------------------------------------------------

const swatchCanvas = document.createElement('canvas');

/** Average colour of an image, sampled small. Used for the palette strip. */
export function averageColor(image) {
  const size = 12;
  swatchCanvas.width = size;
  swatchCanvas.height = size;
  const ctx = swatchCanvas.getContext('2d', { willReadFrequently: true });
  try {
    ctx.drawImage(image, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);
    let r = 0; let g = 0; let b = 0; let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 8) continue;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n += 1;
    }
    if (!n) return null;
    const hex = (v) => Math.round(v / n).toString(16).padStart(2, '0');
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  } catch (err) {
    return null;
  }
}

// -- events -----------------------------------------------------------------

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, payload) {
  for (const fn of listeners.get(event) || []) {
    try { fn(payload); } catch (err) { /* a bad listener shouldn't break a view */ }
  }
}

// -- misc -------------------------------------------------------------------

/** Host of a URL, for compact provenance labels. */
export function sourceLabel(src) {
  if (!src) return 'local file';
  if (!/^https?:/i.test(src)) return src === 'clipboard' ? 'pasted' : src;
  try {
    return new URL(src).hostname.replace(/^www\./, '');
  } catch (err) {
    return 'link';
  }
}

export function relativeTime(iso) {
  if (!iso) return '';
  const then = new Date(iso.replace(' ', 'T'));
  if (isNaN(then)) return '';
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : then.toISOString().slice(0, 10);
}

export function debounce(fn, wait) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.flush = (...args) => { clearTimeout(timer); fn(...args); };
  return wrapped;
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

let toastTimer = null;
export function toast(message, kind = 'info') {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.className = 'toast'; }, kind === 'error' ? 6000 : 3000);
}

/** Download a canvas as PNG and mirror it into the data root's exports/. */
export async function exportPng(canvas, filename) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('canvas export failed');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  try {
    const saved = await api.saveExport(blob, filename);
    toast(`Exported — also saved to ${saved.saved}`);
  } catch (err) {
    toast(`Exported ${filename}`);
  }
}

// -- router -----------------------------------------------------------------
//
//   #/                       dashboard
//   #/b/<board>              board (zones over a background or canvas)
//   #/b/<board>/z/<zone>     one zone's triad
//   #/b/<board>/mosaic       the whole board, composited

const views = {};
let currentTeardown = null;
let generation = 0;

export function registerView(name, mount) {
  views[name] = mount;
}

export function parseHash() {
  const raw = (location.hash || '#/').replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean).map(decodeURIComponent);
  if (!parts.length) return { name: 'dashboard' };
  if (parts[0] !== 'b') return { name: 'dashboard' };
  const boardId = parts[1];
  if (!boardId) return { name: 'dashboard' };
  if (parts[2] === 'z' && parts[3]) {
    return { name: 'zone', boardId, zoneId: parts[3] };
  }
  if (parts[2] === 'mosaic') return { name: 'mosaic', boardId };
  return { name: 'board', boardId };
}

export async function route() {
  const target = parseHash();
  const mount = views[target.name] || views.dashboard;
  const root = document.getElementById('view');

  // Mounts are async, so a second route() could interleave and append two
  // copies of a view. Only the newest generation is allowed to commit.
  generation += 1;
  const mine = generation;

  if (currentTeardown) { try { currentTeardown(); } catch (e) { /* ignore */ } }
  currentTeardown = null;
  root.innerHTML = '';

  emit('route', target);

  const staging = document.createElement('div');
  staging.className = 'stage-root';
  try {
    const teardown = await mount(staging, target);
    if (mine !== generation) {
      if (teardown) try { teardown(); } catch (e) { /* ignore */ }
      return;
    }
    root.appendChild(staging);
    currentTeardown = teardown;
  } catch (err) {
    if (mine !== generation) return;
    root.appendChild(el('div', { class: 'empty-state', text: err.message }));
    toast(err.message, 'error');
  }
}

export function navigate(hash) {
  if (location.hash === hash) route(); else location.hash = hash;
}

window.addEventListener('hashchange', route);
