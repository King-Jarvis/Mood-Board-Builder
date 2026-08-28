// Justified-rows layout that fills a box edge to edge.
//
// A board is stored as an ordered list, never as fixed coordinates, because
// every room footprint has a different aspect ratio. The same list has to
// reflow into a wide living room and a narrow hallway and look deliberate in
// both. One engine, two callers: the room view draws at panel size, the
// stitch view draws at each room's true footprint size.
//
// The subtlety: with a handful of images the achievable heights are
// quantised -- four images can only be broken into one, two, three or four
// rows, so there is usually NO row height that lands exactly on the
// footprint height. Searching for one leaves a gap. Instead we enumerate the
// possible row structures, take the closest, and stretch it to fit; cells
// then deviate slightly from their natural aspect and are cover-cropped.

const STRUCTURE_SAMPLES = 120;

// How far a cell may be stretched from its natural aspect before we'd rather
// leave a gap than mangle the image.
const MIN_STRETCH = 0.45;
const MAX_STRETCH = 2.2;

// A ★ row spans the full width, and its height is a multiple of an ORDINARY
// row's in the same pack -- deliberately not the image's own `width / aspect`,
// and deliberately not a multiple of the trial height.
//
// Natural height would let a tall pin demand a row one and a half times the
// board's width, overflowing the footprint and shrinking the whole board to
// compensate. Trial height is worse in a subtler way: the fit search would
// just drive the trial towards zero and collapse the hero to a sliver, since
// that also "fits". Sizing it against its siblings is what makes ★ mean
// "bigger than the others" at any footprint.
const FEATURE_MIN = 1.15;
const FEATURE_MAX = 1.75;

// Ceiling on ANY row's height, as a multiple of the trial height.
//
// A row that filled up normally already resolves to about the trial height.
// An under-filled one does not: a single leftover portrait resolves to
// `width / 0.56` -- roughly three times a room's height -- which blows the
// total past the footprint and drags the whole board down with it. Starring an
// image in the MIDDLE of the list is the common way to get there, because the
// hero splits the ordinary images and strands one on its own row.
//
// Capping every row keeps the total proportional to the trial height, so the
// sweep can land on the footprint exactly. Under-filled rows get scaled out to
// full width and cover-cropped, which reads as deliberate.
const ROW_MAX = 1.6;

// Greedily break items into rows at a trial row height, then resolve each row
// to the height that makes it span `width` exactly.
function pack(items, width, gutter, trialHeight) {
  const rows = [];
  let current = [];
  let aspectSum = 0;

  const flush = () => {
    if (current.length) rows.push({ items: current, feature: false });
    current = [];
    aspectSum = 0;
  };

  for (const item of items) {
    if (item.feature) {
      flush();
      rows.push({ items: [item], feature: true });
      continue;
    }
    current.push(item);
    aspectSum += item.aspect;
    if (aspectSum * trialHeight + gutter * (current.length - 1) >= width) flush();
  }
  flush();

  const resolved = rows.map((row) => {
    const sum = row.items.reduce((total, item) => total + item.aspect, 0);
    const available = Math.max(1, width - gutter * (row.items.length - 1));
    const natural = available / sum;
    return {
      items: row.items,
      height: row.feature ? natural : Math.min(natural, trialHeight * ROW_MAX),
      feature: row.feature,
    };
  });

  // Size every hero against the ordinary rows it sits among. With no ordinary
  // rows to compare to (every image starred), natural height stands and the
  // outer fit handles the footprint.
  const ordinary = resolved.filter((row) => !row.feature);
  if (ordinary.length) {
    const reference = ordinary.reduce((sum, row) => sum + row.height, 0) / ordinary.length;
    for (const row of resolved) {
      if (!row.feature) continue;
      row.height = Math.min(Math.max(row.height, reference * FEATURE_MIN),
        reference * FEATURE_MAX);
    }
  }

  const total = resolved.reduce((sum, row) => sum + row.height, 0) +
    gutter * Math.max(0, resolved.length - 1);

  return { rows: resolved, total };
}

/**
 * Lay images out inside a box, filling it.
 *
 * @param items  [{ key, aspect, feature }] in board order
 * @param opts   { width, height, gutter }
 * @returns      [{ key, item, x, y, w, h }] -- always inside the box
 */
export function layout(items, { width, height, gutter = 8 }) {
  const usable = items.filter((item) => item && item.aspect > 0);
  if (!usable.length || width <= 0 || height <= 0) return [];

  // Sweep trial row heights and keep whichever pack needs the least stretch
  // to fill the box. Cheap: a few dozen passes over a short array.
  //
  // The ceiling has to clear the tallest single-image row (`width / aspect`),
  // not just the box: breaking a narrow portrait out on its own needs a trial
  // height far above both dimensions, and without headroom for it the
  // all-singles structures are never even considered. The sweep is geometric
  // because what matters is the ratio between candidate heights, and the range
  // it has to span can be wide.
  let best = null;
  let bestCost = Infinity;
  const tallest = Math.max(...usable.map((item) => width / item.aspect));
  const hi = Math.max(width, height, tallest);
  const lo = Math.max(4, Math.min(width, height) / (usable.length * 4));
  for (let i = 0; i < STRUCTURE_SAMPLES; i += 1) {
    const trial = lo * ((hi / lo) ** (i / (STRUCTURE_SAMPLES - 1)));
    const packed = pack(usable, width, gutter, trial);
    const gutters = gutter * Math.max(0, packed.rows.length - 1);
    const rowSum = packed.total - gutters;
    if (rowSum <= 0) continue;
    const stretch = (height - gutters) / rowSum;
    if (stretch <= 0) continue;
    const cost = Math.abs(Math.log(stretch));
    if (cost < bestCost) { bestCost = cost; best = { packed, stretch }; }
  }
  if (!best) return [];

  const stretch = Math.min(MAX_STRETCH, Math.max(MIN_STRETCH, best.stretch));
  const rows = best.packed.rows;
  const gutters = gutter * Math.max(0, rows.length - 1);
  let stackHeight = rows.reduce((sum, row) => sum + row.height * stretch, 0) + gutters;

  // Clamping the stretch UP off the floor makes the stack taller than the
  // box, which would spill off the canvas. Rather than crop images into
  // slivers, shrink the whole block uniformly and centre it -- the gap is the
  // honest signal that this many images can't tile this footprint.
  const fit = stackHeight > height ? height / stackHeight : 1;
  stackHeight *= fit;
  const blockWidth = width * fit;
  const offsetX = (width - blockWidth) / 2;
  const offsetY = (height - stackHeight) / 2;

  const boxes = [];
  let y = offsetY;
  for (const row of rows) {
    const rowHeight = row.height * stretch * fit;
    const rowGutter = gutter * fit;
    const rowGutters = rowGutter * (row.items.length - 1);

    // Normalise each row to span the block exactly. Ordinary rows already do
    // (their height was derived from it); a ★ row does not, because its height
    // was set by the board rather than by the image, so it gets scaled here.
    const naturalSum = row.items.reduce(
      (sum, item) => sum + item.aspect * row.height * fit, 0);
    const rowScale = naturalSum > 0 ? (blockWidth - rowGutters) / naturalSum : 1;

    let x = offsetX;
    row.items.forEach((item, index) => {
      const w = item.aspect * row.height * fit * rowScale;
      const last = index === row.items.length - 1;
      boxes.push({
        key: item.key,
        item,
        x,
        y,
        // Absorb rounding into the last cell so rows end flush on the edge.
        w: last ? offsetX + blockWidth - x : w,
        h: rowHeight,
      });
      x += w + rowGutter;
    });
    y += rowHeight + rowGutter;
  }
  return boxes;
}

/**
 * Draw a laid-out board onto a 2D context, cover-cropping each cell.
 *
 * @param resolve  key -> HTMLImageElement (or null while still loading)
 */
export function drawBoxes(ctx, boxes, resolve, { radius = 0, placeholder = '#e6e1d8' } = {}) {
  for (const box of boxes) {
    const image = resolve(box.key);
    ctx.save();
    if (radius > 0) {
      roundRect(ctx, box.x, box.y, box.w, box.h, Math.min(radius, box.w / 2, box.h / 2));
      ctx.clip();
    }
    if (image && image.complete && image.naturalWidth) {
      const source = cover(image.naturalWidth, image.naturalHeight, box.w, box.h);
      ctx.drawImage(image, source.sx, source.sy, source.sw, source.sh,
        box.x, box.y, box.w, box.h);
    } else {
      ctx.fillStyle = placeholder;
      ctx.fillRect(box.x, box.y, box.w, box.h);
    }
    ctx.restore();
  }
}

/** Centre-crop source rect so an image fills a cell without distortion. */
function cover(naturalW, naturalH, boxW, boxH) {
  const target = boxW / boxH;
  const natural = naturalW / naturalH;
  if (natural > target) {
    const sw = naturalH * target;
    return { sx: (naturalW - sw) / 2, sy: 0, sw, sh: naturalH };
  }
  const sh = naturalW / target;
  return { sx: 0, sy: (naturalH - sh) / 2, sw: naturalW, sh };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
