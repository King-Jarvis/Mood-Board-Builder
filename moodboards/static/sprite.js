// A quiet companion.
//
// A puppy sitting in the corner of the rail. It never blocks anything, never
// speaks, and never asks for a click -- it just reflects what the app already
// knows: dozing when the room you're in is empty, tail going when an image
// lands, a proper bounce when a room gets its first board.
//
// All motion is CSS (see .sprite in styles.css) and honours
// prefers-reduced-motion; this module only swaps a class and sets the caption.

// Fur is written as literal hex rather than theme tokens: the accent palette
// is tuned for UI chrome, and borrowing it turned the ears into green blobs.
const FUR      = '#d3a56e';
const FUR_DARK = '#a06c3c';
const FUR_PALE = '#f0dcbb';
const CREAM    = '#fdf6e6';

const SVG = `
<svg class="sprite" viewBox="0 0 52 52" fill="none" aria-hidden="true">
  <g class="body-g">
    <!-- tail, clear of the body so the wag actually reads -->
    <g class="tail">
      <path d="M37 42C43 41.5 46 37 44.5 32" stroke="${FUR_DARK}"
            stroke-width="4" stroke-linecap="round"/>
    </g>
    <!-- seated body -->
    <ellipse cx="26" cy="42" rx="11.5" ry="9" fill="${FUR}"/>
    <ellipse cx="26" cy="45" rx="7" ry="5.5" fill="${FUR_PALE}"/>
    <!-- front paws -->
    <ellipse cx="20.5" cy="48" rx="4.2" ry="3" fill="${FUR_PALE}"/>
    <ellipse cx="31.5" cy="48" rx="4.2" ry="3" fill="${FUR_PALE}"/>
    <!-- floppy ears, behind the head -->
    <g class="ear ear-l">
      <path d="M15 18C10.5 20 9 27 11.5 32.5c1.8 3.9 5.6 2.9 6.6-.6C19.2 28 19 21 15 18Z"
            fill="${FUR_DARK}"/>
    </g>
    <g class="ear ear-r">
      <path d="M37 18c4.5 2 6 9 3.5 14.5-1.8 3.9-5.6 2.9-6.6-.6C32.8 28 33 21 37 18Z"
            fill="${FUR_DARK}"/>
    </g>
    <!-- head -->
    <circle cx="26" cy="24" r="12" fill="${FUR}"/>
    <ellipse cx="26" cy="17.5" rx="7.5" ry="4.5" fill="${FUR_PALE}" opacity=".55"/>
    <!-- muzzle -->
    <ellipse cx="26" cy="29" rx="7" ry="5.2" fill="${CREAM}"/>
    <ellipse cx="26" cy="25.8" rx="2.3" ry="1.7" fill="#3b3225"/>
    <path d="M26 27.5v1.8M26 29.3c-1 1-2.6.7-3-.5M26 29.3c1 1 2.6.7 3-.5"
          stroke="#6b5d47" stroke-width="1.1" stroke-linecap="round"/>
    <!-- tongue, only out when pleased -->
    <path class="tongue" d="M23.9 32.2h4.2c0 2.6-.9 4-2.1 4s-2.1-1.4-2.1-4Z"
          fill="#d98a86"/>
    <!-- eyes -->
    <ellipse class="eye" cx="20.4" cy="21.4" rx="2" ry="2.4" fill="#3b3225"/>
    <ellipse class="eye" cx="31.6" cy="21.4" rx="2" ry="2.4" fill="#3b3225"/>
    <circle cx="21.1" cy="20.6" r=".7" fill="${CREAM}"/>
    <circle cx="32.3" cy="20.6" r=".7" fill="${CREAM}"/>
  </g>
  <g class="zzz">
    <text x="40" y="15" font-size="8" fill="var(--ink-3)">z</text>
  </g>
</svg>`;

const MOODS = {
  idle:  'keeping you company',
  happy: 'nice find',
  cheer: 'this room has a board',
  sleep: 'nothing here yet',
};

export function createSprite() {
  const host = document.createElement('div');
  host.className = 'sprite-host';
  host.innerHTML = SVG;
  const svg = host.querySelector('svg');

  let resetTimer = null;
  let resting = 'idle';

  /** Transient reactions fall back to whatever the resting mood is. */
  function react(mood, hold = 1600) {
    clearTimeout(resetTimer);
    svg.classList.remove('happy', 'cheer', 'sleep');
    if (mood !== 'idle') svg.classList.add(mood);
    host.title = MOODS[mood] || '';
    resetTimer = setTimeout(() => {
      svg.classList.remove('happy', 'cheer');
      if (resting === 'sleep') svg.classList.add('sleep');
      host.title = MOODS[resting] || '';
    }, hold);
  }

  /** The steady state, set from whether the current room has anything in it. */
  function rest(mood) {
    resting = mood;
    clearTimeout(resetTimer);
    svg.classList.remove('happy', 'cheer', 'sleep');
    if (mood === 'sleep') svg.classList.add('sleep');
    host.title = MOODS[mood] || '';
  }

  return { el: host, react, rest };
}
