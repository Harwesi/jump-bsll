/* ==========================================================================
   ENDLESS JUMPER — game.js  (vanilla JS, Canvas 2D, Web Audio; no libraries)

   Sections:  TUNING · UTIL · AUDIO · INPUT · UI · STATE · WORLD/SPAWNER ·
              PHYSICS · FX · RENDER · MAIN LOOP
   World units: logical width is always WORLD_W; height follows the aspect
   ratio of the container. Y grows downward; climbing = decreasing Y.
   ========================================================================== */
(() => {
'use strict';

/* ==========================================================================
   TUNING — tweak these first. Units: px and seconds in world space.
   ========================================================================== */
const WORLD_W            = 480;    // logical game width
const PX_PER_M           = 32;     // world px per displayed meter
const DIFF_METERS        = 260;    // altitude at which difficulty maxes out

// --- Ball physics ---
const GRAVITY            = 2300;   // base gravity (px/s²)
const FALL_GRAVITY_MULT  = 1.14;   // heavier on the way down  -> snappy landing
const APEX_GRAVITY_MULT  = 0.60;   // lighter near the apex    -> floaty hang time
const APEX_BAND          = 190;    // |vy| below this counts as "near apex"
const JUMP_FORCE         = 1010;   // normal bounce (apex ≈ 220px, ~0.9s per hop)
const SPRING_FORCE       = 1520;   // spring bounce (≈ 2.2x higher)
const MAX_FALL_SPEED     = 1400;
const BALL_R             = 16;

// --- Horizontal control ---
const MOVE_ACCEL         = 3000;   // px/s² while a direction is held
const TURN_BOOST         = 1.8;    // extra accel when reversing direction
const FRICTION           = 1700;   // px/s² deceleration with no input
const MAX_SPEED          = 370;    // px/s

// --- Forgiveness (coyote-style) ---
const EDGE_FORGIVE       = 8;      // extra px of platform reach at the edges
const LAND_TOLERANCE     = 7;      // px a fast ball may be "inside" a platform and still land

// --- Camera ---
const CAM_ANCHOR         = 0.46;   // fraction of screen height where ball is held while climbing
const CAM_LERP           = 7;      // easing rate (1/s); framerate independent
const CAM_LERP_FAST      = 11;     // used during spring launches

// --- Squash & stretch spring ---
const SQ_K               = 380;    // spring stiffness
const SQ_D               = 24;     // damping (underdamped => nice overshoot)

// --- Loop ---
const SUBSTEP            = 1 / 120;
const MAX_FRAME_DT       = 0.05;

// --- Content ---
const PLAT_H             = 14;
const SPIKE_H            = 13;
const COIN_BONUS         = 5;      // score per coin
const SPAWN_AHEAD        = 320;    // generate platforms this far above the view
const MILESTONE_M        = 100;

const FONT = 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const BEST_KEY = 'endlessJumper.best';
const MUTE_KEY = 'endlessJumper.muted';

/* ==========================================================================
   UTIL
   ========================================================================== */
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const smooth = (t) => t * t * (3 - 2 * t);
const damp = (k, dt) => 1 - Math.exp(-k * dt);
const $ = (id) => document.getElementById(id);
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const store = {
  get(key, def) { try { const v = localStorage.getItem(key); return v === null ? def : v; } catch (e) { return def; } },
  set(key, v) { try { localStorage.setItem(key, String(v)); } catch (e) { /* private mode */ } },
};

/* ==========================================================================
   AUDIO — tiny synthesized blips via Web Audio. Created on first gesture.
   ========================================================================== */
const Sound = (() => {
  let ac = null, master = null, noiseBuf = null;
  let muted = store.get(MUTE_KEY, '0') === '1';

  function init() {
    if (ac) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      ac = new AC();
      master = ac.createGain();
      master.gain.value = muted ? 0 : 0.5;
      master.connect(ac.destination);
    } catch (e) { ac = null; }
  }
  function resume() {
    init();
    if (ac && ac.state === 'suspended') ac.resume();
  }
  function tone({ f0, f1 = f0, dur = 0.12, type = 'sine', vol = 0.05, delay = 0 }) {
    if (!ac || muted) return;
    const t = ac.currentTime + delay;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.03);
  }
  function noise({ dur = 0.2, vol = 0.06, freq = 1400 }) {
    if (!ac || muted) return;
    if (!noiseBuf) {
      noiseBuf = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.4), ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const t = ac.currentTime;
    const src = ac.createBufferSource(); src.buffer = noiseBuf;
    const filt = ac.createBiquadFilter(); filt.type = 'bandpass'; filt.frequency.value = freq; filt.Q.value = 0.8;
    const g = ac.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt); filt.connect(g); g.connect(master);
    src.start(t); src.stop(t + dur + 0.02);
  }
  return {
    resume,
    get muted() { return muted; },
    setMuted(v) {
      muted = !!v; store.set(MUTE_KEY, muted ? '1' : '0');
      if (master) master.gain.value = muted ? 0 : 0.5;
    },
    jump()   { const p = rand(0.95, 1.06); tone({ f0: 360 * p, f1: 560 * p, dur: 0.09, vol: 0.045 }); },
    spring() { tone({ f0: 260, f1: 980, dur: 0.28, type: 'triangle', vol: 0.08 }); tone({ f0: 520, f1: 1500, dur: 0.2, vol: 0.03, delay: 0.04 }); },
    coin()   { tone({ f0: 988, dur: 0.07, type: 'square', vol: 0.03 }); tone({ f0: 1319, dur: 0.14, type: 'square', vol: 0.03, delay: 0.065 }); },
    crack()  { noise({ dur: 0.22, vol: 0.07, freq: 1800 }); tone({ f0: 180, f1: 70, dur: 0.15, type: 'triangle', vol: 0.05 }); },
    die()    { tone({ f0: 420, f1: 70, dur: 0.55, type: 'sawtooth', vol: 0.06 }); },
    milestone() { [523, 659, 784].forEach((f, i) => tone({ f0: f, dur: 0.16, type: 'triangle', vol: 0.05, delay: i * 0.08 })); },
  };
})();

/* ==========================================================================
   UI REFERENCES
   ========================================================================== */
const ui = {
  game: $('game'), canvas: $('canvas'),
  hud: $('hud'), hudHeight: $('hudHeight'), hudBest: $('hudBest'), hudCoins: $('hudCoins'), hudCoinChip: $('hudCoinChip'),
  mute: $('muteBtn'), toast: $('toast'),
  start: $('startScreen'), over: $('gameOverScreen'),
  goScore: $('goScore'), goBest: $('goBest'), goCoins: $('goCoins'), goBadge: $('goBadge'), restart: $('restartBtn'),
};
const canvas = ui.canvas;
const ctx = canvas.getContext('2d');

function syncMuteButton() {
  ui.mute.classList.toggle('muted', Sound.muted);
  ui.mute.setAttribute('aria-pressed', Sound.muted ? 'true' : 'false');
}
function toast(text) {
  ui.toast.textContent = text;
  ui.toast.classList.remove('pop');
  void ui.toast.offsetWidth; // restart CSS animation
  ui.toast.classList.add('pop');
}
function bump(el) {
  if (el && el.animate) el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'ease-out' });
}

/* ==========================================================================
   VIEW (responsive canvas + devicePixelRatio)
   ========================================================================== */
const view = { h: 800, k: 1 };
function resize() {
  const rect = ui.game.getBoundingClientRect();
  const cssW = Math.max(1, rect.width), cssH = Math.max(1, rect.height);
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  view.k = canvas.width / WORLD_W;           // world unit -> device pixel
  view.h = canvas.height / view.k;           // visible world height
}

/* ==========================================================================
   INPUT — keyboard + pointer (left/right halves). Last pressed direction wins.
   ========================================================================== */
const input = (() => {
  const keys = { left: false, right: false };
  const pointers = new Map();               // pointerId -> -1 | 1
  let lastDir = 0;
  return {
    axis() {
      let l = keys.left, r = keys.right;
      for (const d of pointers.values()) { if (d < 0) l = true; else r = true; }
      if (l && r) return lastDir || 1;
      return r ? 1 : l ? -1 : 0;
    },
    key(dir, down) { if (dir < 0) keys.left = down; else keys.right = down; if (down) lastDir = dir; },
    pointer(id, dir) { pointers.set(id, dir); lastDir = dir; },
    release(id) { pointers.delete(id); },
    clear() { keys.left = keys.right = false; pointers.clear(); lastDir = 0; },
  };
})();

function bindInput() {
  window.addEventListener('keydown', (e) => {
    const c = e.code;
    if (c === 'ArrowLeft' || c === 'KeyA') { input.key(-1, true); e.preventDefault(); }
    else if (c === 'ArrowRight' || c === 'KeyD') { input.key(1, true); e.preventDefault(); }
    else if (c === 'Space' || c === 'Enter') { e.preventDefault(); if (!e.repeat) { Sound.resume(); tryStart(); } }
    else if (c === 'KeyM') { if (!e.repeat) toggleMute(); }
    else return;
    Sound.resume();
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') input.key(-1, false);
    else if (e.code === 'ArrowRight' || e.code === 'KeyD') input.key(1, false);
  });
  window.addEventListener('blur', () => input.clear());

  const dirFor = (e) => {
    const r = ui.game.getBoundingClientRect();
    return e.clientX - r.left < r.width / 2 ? -1 : 1;
  };
  ui.game.addEventListener('pointerdown', (e) => {
    if (e.target.closest && e.target.closest('button')) return;
    Sound.resume();
    input.pointer(e.pointerId, dirFor(e));
    try { ui.game.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (state === 'menu' || state === 'gameover') tryStart();
  });
  ui.game.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') input.pointer(e.pointerId, dirFor(e)); });
  const up = (e) => input.release(e.pointerId);
  ui.game.addEventListener('pointerup', up);
  ui.game.addEventListener('pointercancel', up);
  ui.game.addEventListener('lostpointercapture', up);
  ui.game.addEventListener('contextmenu', (e) => e.preventDefault());

  ui.mute.addEventListener('click', () => { Sound.resume(); toggleMute(); ui.mute.blur(); });
  ui.restart.addEventListener('click', () => { Sound.resume(); tryStart(); ui.restart.blur(); });
  document.addEventListener('visibilitychange', () => { lastTime = null; input.clear(); });
}
function toggleMute() { Sound.setMuted(!Sound.muted); syncMuteButton(); }

/* ==========================================================================
   STATE
   ========================================================================== */
let state = 'menu';          // 'menu' | 'playing' | 'dying' | 'gameover'
let time = 0;                // running clock (s)
let camY = 0, camOrigin = 0; // camera top edge (world y); camOrigin = camera at start
let shake = 0;
let introFade = 0;
let dyingT = 0;
let restartLock = 0;
let highest = -BALL_R;       // smallest ball.y reached
let coinsGot = 0;
let nextMilestone = MILESTONE_M;
let best = 0;
let lastTime = null;
let trailAcc = 0;
let spawner = null;

const ball = { x: WORLD_W / 2, y: 0, vx: 0, vy: 0, sx: 1, sy: 1, svx: 0, svy: 0, visible: true };
const platforms = [];
const coins = [];
const particles = [];
const floats = [];
const trail = [];
const MAX_PARTICLES = 420;

const meters = () => Math.max(0, Math.floor((-BALL_R - highest) / PX_PER_M));
const score = () => meters() + coinsGot * COIN_BONUS;

/* ==========================================================================
   WORLD / SPAWNER
   ========================================================================== */
const PLAT = {
  normal:  { a: '#8cf0cf', b: '#34b394', glow: 'mint' },
  spring:  { a: '#d9f76f', b: '#86c52f', glow: 'lime' },
  moving:  { a: '#97d6ff', b: '#3d86e6', glow: 'sky' },
  fragile: { a: '#ffe3b8', b: '#e29860', glow: 'peach' },
  spiked:  { a: '#7a679a', b: '#3b2d57', glow: 'red' },
};

const difficulty = (y) => clamp((-BALL_R - y) / PX_PER_M / DIFF_METERS, 0, 1);

function makePlatform(x, y, w, type) {
  const p = { x, y, w, h: PLAT_H, type, vx: 0, spT: 99, dead: false };
  if (type === 'moving') p.vx = (Math.random() < 0.5 ? -1 : 1) * lerp(55, 115, difficulty(y));
  return p;
}
function makeCoin(x, y, parent) {
  return { x, y, r: 10, ph: rand(0, TAU), taken: false, parent: parent || null, ox: parent ? x - (parent.x + parent.w / 2) : 0 };
}

function spawnRow() {
  const s = spawner;
  const d = difficulty(s.topY);
  const m = d * DIFF_METERS;
  const gap = rand(lerp(66, 96, d), lerp(104, 176, d));   // max gap stays well under the ~220px jump apex
  const y = s.topY - gap;
  const w = rand(lerp(92, 78, d), lerp(120, 98, d));
  const maxDx = lerp(170, 235, d);

  let cx = s.lastX + rand(-maxDx, maxDx);
  const lo = w / 2 + 10, hi = WORLD_W - w / 2 - 10;
  if (cx < lo || cx > hi) cx = s.lastX - (cx - s.lastX);   // reflect instead of piling up on walls
  cx = clamp(cx, lo, hi);

  // Pick the type of the (always safe) main platform.
  let type = 'normal';
  const r = Math.random();
  const pSpring = s.count > 2 ? 0.07 : 0;
  const pMoving = s.count > 3 ? lerp(0.05, 0.38, d) : 0;
  const pFragile = s.count > 6 ? lerp(0.04, 0.2, d) : 0;
  if (r < pSpring && s.lastType !== 'spring') type = 'spring';
  else if (r < pSpring + pMoving) type = 'moving';
  else if (r < pSpring + pMoving + pFragile && s.lastType !== 'fragile') type = 'fragile';

  const p = makePlatform(cx - w / 2, y, w, type);
  platforms.push(p);

  // Coins: single hover coin, or a short arc between rows.
  if (type !== 'spring' && Math.random() < 0.3) {
    coins.push(makeCoin(cx, y - 46 - rand(0, 22), p));
  } else if (gap > 100 && Math.random() < 0.1) {
    for (let i = 1; i <= 3; i++) {
      const t = i / 4;
      coins.push(makeCoin(lerp(s.lastX, cx, t), lerp(s.topY, y, t) - 34 - Math.sin(t * Math.PI) * 26, null));
    }
  }

  // Spiked hazards: optional extra platforms placed away from the safe path.
  if (m > 40 && s.count > 6) {
    const tries = d > 0.7 ? 2 : 1;
    for (let k = 0; k < tries; k++) {
      if (Math.random() < lerp(0.12, 0.6, d) * (k ? 0.6 : 1)) trySpike(s.topY, s.lastX, y, cx, gap);
    }
  }

  s.topY = y; s.lastX = cx; s.lastType = type; s.count++;
}

function trySpike(prevY, prevX, y, cx, gap) {
  const sw = rand(70, 96);
  const sy = prevY - gap * rand(0.35, 0.65);
  const t = (prevY - sy) / gap;
  const lineX = lerp(prevX, cx, t);
  for (let i = 0; i < 6; i++) {
    const sx = rand(8, WORLD_W - 8 - sw);
    const c = sx + sw / 2;
    if (Math.abs(c - lineX) > sw / 2 + 80 && Math.abs(c - prevX) > sw / 2 + 70 && Math.abs(c - cx) > sw / 2 + 70) {
      platforms.push(makePlatform(sx, sy, sw, 'spiked'));
      return;
    }
  }
}

function ensureSpawn() {
  const limit = camY - SPAWN_AHEAD;
  let guard = 0;
  while (spawner.topY > limit && guard++ < 80) spawnRow();
}

function cull() {
  const cutoff = camY + view.h + 160;
  for (let i = platforms.length - 1; i >= 0; i--) {
    if (platforms[i].dead || platforms[i].y > cutoff) { platforms[i] = platforms[platforms.length - 1]; platforms.pop(); }
  }
  for (let i = coins.length - 1; i >= 0; i--) {
    if (coins[i].taken || coins[i].y > cutoff) { coins[i] = coins[coins.length - 1]; coins.pop(); }
  }
}

function resetWorld() {
  platforms.length = 0; coins.length = 0; particles.length = 0; floats.length = 0; trail.length = 0;
  camOrigin = -view.h * 0.68;          // ground platform sits ~68% down the screen
  camY = camOrigin;
  spawner = { topY: 0, lastX: WORLD_W / 2, lastType: 'normal', count: 0 };
  platforms.push(makePlatform(WORLD_W / 2 - 150, 0, 300, 'normal'));
  Object.assign(ball, { x: WORLD_W / 2, y: -BALL_R - 80, vx: 0, vy: 0, sx: 1, sy: 1, svx: 0, svy: 0, visible: true });
  highest = -BALL_R; coinsGot = 0; nextMilestone = MILESTONE_M; shake = 0; trailAcc = 0;
  introFade = 1;
  ensureSpawn();
  lastHud.score = lastHud.best = lastHud.coins = -1;
}

/* ==========================================================================
   FX — particles, floating text
   ========================================================================== */
function addParticle(p) {
  if (particles.length >= MAX_PARTICLES) particles.shift();
  p.max = p.life;
  particles.push(p);
}
function landFx(x, y, color) {
  for (let i = 0; i < 8; i++) {
    const dir = i % 2 ? 1 : -1;
    addParticle({ kind: 'dot', x: x + dir * rand(0, 8), y: y - 2, vx: dir * rand(40, 150), vy: -rand(10, 80), g: 160, drag: 2.2, life: rand(0.35, 0.6), size: rand(2.5, 5.5), color });
  }
  addParticle({ kind: 'ring', x, y: y - 1, vx: 0, vy: 0, g: 0, life: 0.32, size: 6, grow: 38, flat: 0.28, color: '#ffffff', alpha: 0.5 });
}
function springFx(x, y) {
  const cols = ['#d9f76f', '#ffe36e', '#ffffff', '#ff9ec7'];
  for (let i = 0; i < 18; i++) {
    const a = -Math.PI / 2 + rand(-0.9, 0.9), sp = rand(120, 380);
    addParticle({ kind: 'dot', x, y: y - 8, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 500, drag: 0.8, life: rand(0.4, 0.8), size: rand(2.5, 5), color: cols[i % cols.length] });
  }
  addParticle({ kind: 'ring', x, y: y - 4, vx: 0, vy: 0, g: 0, life: 0.45, size: 8, grow: 70, flat: 0.32, color: '#e9ff9a', alpha: 0.7 });
}
function coinFx(c) {
  addParticle({ kind: 'pop', x: c.x, y: c.y, vx: 0, vy: -30, g: 0, life: 0.3, size: c.r, color: '#ffd24a' });
  addParticle({ kind: 'ring', x: c.x, y: c.y, vx: 0, vy: 0, g: 0, life: 0.38, size: c.r, grow: 30, flat: 1, color: '#ffe27a', alpha: 0.9 });
  for (let i = 0; i < 9; i++) {
    const a = rand(0, TAU), sp = rand(80, 240);
    addParticle({ kind: 'dot', x: c.x, y: c.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, g: 420, drag: 1.5, life: rand(0.3, 0.6), size: rand(1.8, 3.6), color: '#ffe27a' });
  }
  floats.push({ x: c.x, y: c.y - 14, vy: -70, text: '+' + COIN_BONUS, life: 0.9, max: 0.9, color: '#ffe27a', size: 20 });
}
function breakFx(p) {
  const c = PLAT.fragile;
  const half = p.w / 2;
  addParticle({ kind: 'rect', x: p.x + half / 2, y: p.y + p.h / 2, vx: -rand(40, 110), vy: -rand(60, 160), g: 1100, drag: 0, life: 0.9, w: half, h: p.h, rot: 0, vr: -rand(1.5, 4), color: c.b });
  addParticle({ kind: 'rect', x: p.x + half * 1.5, y: p.y + p.h / 2, vx: rand(40, 110), vy: -rand(60, 160), g: 1100, drag: 0, life: 0.9, w: half, h: p.h, rot: 0, vr: rand(1.5, 4), color: c.a });
  for (let i = 0; i < 8; i++) {
    addParticle({ kind: 'dot', x: p.x + rand(0, p.w), y: p.y + 4, vx: rand(-90, 90), vy: -rand(20, 140), g: 700, drag: 0.5, life: rand(0.4, 0.8), size: rand(2, 4), color: c.a });
  }
}
function burstBall(x, y) {
  const cols = ['#ffb347', '#ff6a3d', '#fff1c9', '#ffd27a'];
  for (let i = 0; i < 26; i++) {
    const a = rand(0, TAU), sp = rand(120, 520);
    addParticle({ kind: 'dot', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 120, g: 800, drag: 0.6, life: rand(0.5, 1), size: rand(2.5, 6), color: cols[i % cols.length] });
  }
  addParticle({ kind: 'ring', x, y, vx: 0, vy: 0, g: 0, life: 0.5, size: 10, grow: 110, flat: 1, color: '#ffb347', alpha: 0.8 });
}
function updateFx(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) { particles[i] = particles[particles.length - 1]; particles.pop(); continue; }
    p.vy += p.g * dt;
    if (p.drag) { const f = Math.exp(-p.drag * dt); p.vx *= f; }
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.vr) p.rot += p.vr * dt;
  }
  for (let i = floats.length - 1; i >= 0; i--) {
    const f = floats[i];
    f.life -= dt; f.y += f.vy * dt; f.vy *= Math.exp(-2.5 * dt);
    if (f.life <= 0) { floats[i] = floats[floats.length - 1]; floats.pop(); }
  }
  shake *= Math.exp(-11 * dt);
  if (shake < 0.05) shake = 0;
  if (introFade > 0) introFade = Math.max(0, introFade - dt * 2.4);
}

/* ==========================================================================
   PHYSICS
   ========================================================================== */
function stepPlatforms(h) {
  for (const p of platforms) {
    p.spT += h;
    if (p.type === 'moving') {
      p.x += p.vx * h;
      if (p.x < 8) { p.x = 8; p.vx = Math.abs(p.vx); }
      else if (p.x + p.w > WORLD_W - 8) { p.x = WORLD_W - 8 - p.w; p.vx = -Math.abs(p.vx); }
    }
  }
  for (const c of coins) if (c.parent && !c.parent.dead) c.x = c.parent.x + c.parent.w / 2 + c.ox;
}

function overlapX(x, hw, p) {
  const t = (cx) => cx + hw > p.x && cx - hw < p.x + p.w;
  return t(x) || t(x - WORLD_W) || t(x + WORLD_W);   // ball wraps around the screen edges
}

function hitsSpikes(p) {
  const x0 = p.x + 4, x1 = p.x + p.w - 4, y0 = p.y - SPIKE_H + 3, y1 = p.y + p.h;
  const r = BALL_R * 0.82;
  const ny = clamp(ball.y, y0, y1);
  for (const off of [0, -WORLD_W, WORLD_W]) {
    const nx = clamp(ball.x + off, x0, x1);
    const dx = ball.x + off - nx, dy = ball.y - ny;
    if (dx * dx + dy * dy < r * r) return true;
  }
  return false;
}

function land(p) {
  const b = ball;
  b.y = p.y - BALL_R;
  landFx(b.x, p.y, PLAT[p.type].a);
  if (p.type === 'spring') {
    b.vy = -SPRING_FORCE; p.spT = 0;
    shake = Math.max(shake, 6);
    springFx(b.x, p.y);
    if (state === 'playing') Sound.spring();
  } else {
    b.vy = -JUMP_FORCE;
    if (state === 'playing') Sound.jump();
    if (p.type === 'fragile') { p.dead = true; breakFx(p); for (const c of coins) if (c.parent === p) c.parent = null; if (state === 'playing') Sound.crack(); }
  }
  // squash on contact; the spring in updateSquash() rebounds it into a stretch
  b.sx = 1.42; b.sy = 0.58; b.svx = -3; b.svy = 7;
}

function collectCoins() {
  const rr = (BALL_R + 10) * (BALL_R + 10);
  for (const c of coins) {
    if (c.taken) continue;
    const dx = c.x - ball.x, dy = c.y - ball.y;
    if (dx * dx + dy * dy < rr) {
      c.taken = true; coinsGot++;
      coinFx(c); Sound.coin(); bump(ui.hudCoinChip);
    }
  }
}

function stepBall(h) {
  const b = ball;
  const ax = state === 'playing' ? input.axis() : 0;

  // Horizontal: accelerate with input, friction without it
  if (ax !== 0) {
    const turning = b.vx * ax < -15;
    b.vx += ax * MOVE_ACCEL * (turning ? TURN_BOOST : 1) * h;
  } else {
    const f = FRICTION * h;
    b.vx = Math.abs(b.vx) <= f ? 0 : b.vx - Math.sign(b.vx) * f;
  }
  b.vx = clamp(b.vx, -MAX_SPEED, MAX_SPEED);

  // Vertical: floaty apex, snappy fall
  let g = GRAVITY;
  if (Math.abs(b.vy) < APEX_BAND) g *= APEX_GRAVITY_MULT;
  else if (b.vy > 0) g *= FALL_GRAVITY_MULT;
  b.vy = Math.min(b.vy + g * h, MAX_FALL_SPEED);

  const prevBottom = b.y + BALL_R;
  b.x += b.vx * h;
  b.y += b.vy * h;
  if (b.x < 0) b.x += WORLD_W; else if (b.x > WORLD_W) b.x -= WORLD_W;

  // Swept landing test: only while falling, platform top crossed this step
  if (b.vy > 0) {
    const bottom = b.y + BALL_R;
    const hw = BALL_R * 0.55 + EDGE_FORGIVE;
    for (const p of platforms) {
      if (p.dead || p.type === 'spiked') continue;
      if (bottom >= p.y && prevBottom <= p.y + LAND_TOLERANCE && overlapX(b.x, hw, p)) { land(p); break; }
    }
  }

  if (state === 'playing') {
    for (const p of platforms) if (p.type === 'spiked' && hitsSpikes(p)) { die('spikes'); return; }
    collectCoins();
  }
  if (b.y < highest) highest = b.y;
}

function updateSquash(dt) {
  const b = ball;
  const st = clamp(Math.abs(b.vy) / 4000, 0, 0.38);   // stretch grows with speed
  const ty = 1 + st, tx = 1 / Math.sqrt(ty);          // roughly volume-preserving
  b.svy += ((ty - b.sy) * SQ_K - b.svy * SQ_D) * dt; b.sy += b.svy * dt;
  b.svx += ((tx - b.sx) * SQ_K - b.svx * SQ_D) * dt; b.sx += b.svx * dt;
}

function updateCamera(dt) {
  const target = ball.y - view.h * CAM_ANCHOR;
  if (target < camY) {
    const boost = clamp((-ball.vy - 900) / 700, 0, 1);
    camY += (target - camY) * damp(lerp(CAM_LERP, CAM_LERP_FAST, boost), dt);
  }
}

function simulate(dt) {
  const steps = Math.max(1, Math.ceil(dt / SUBSTEP));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    stepPlatforms(h);
    stepBall(h);
    if (state !== 'playing' && state !== 'menu') break;
  }
  updateSquash(dt);

  if (state === 'menu') {
    camOrigin = -view.h * 0.68; camY = camOrigin;
  } else if (state === 'playing') {
    updateCamera(dt);
    // trail sampled on a fixed time base so it looks the same at any refresh rate
    trailAcc += dt;
    while (trailAcc >= 0.018) {
      trailAcc -= 0.018;
      const last = trail[trail.length - 1];
      if (last && Math.abs(last.x - ball.x) > WORLD_W / 2) trail.length = 0;   // wrapped around
      trail.push({ x: ball.x, y: ball.y, sx: ball.sx, sy: ball.sy });
      if (trail.length > 11) trail.shift();
    }
    if (meters() >= nextMilestone) {
      toast(nextMilestone + ' m');
      Sound.milestone();
      nextMilestone += MILESTONE_M;
    }
    if (ball.y - camY > view.h + BALL_R * 3) die('fall');
  }
  ensureSpawn();
  cull();
}

/* ==========================================================================
   STATE TRANSITIONS
   ========================================================================== */
function tryStart() {
  if (state === 'menu') {
    state = 'playing';
    ui.start.classList.remove('show');
    ui.hud.classList.add('show');
  } else if (state === 'gameover' && time >= restartLock) {
    resetWorld();
    state = 'playing';
    ui.over.classList.remove('show');
    ui.hud.classList.add('show');
  }
}

function die(kind) {
  if (state !== 'playing') return;
  state = 'dying';
  Sound.die();
  if (kind === 'spikes') {
    ball.visible = false;
    burstBall(ball.x, ball.y);
    shake = 14; dyingT = 0.8;
  } else {
    shake = 6; dyingT = 0.45;
  }
}

function showGameOver() {
  state = 'gameover';
  const s = score();
  const isBest = s > best && s > 0;
  if (isBest) { best = s; store.set(BEST_KEY, best); }
  ui.goScore.textContent = s;
  ui.goBest.textContent = best;
  ui.goCoins.textContent = coinsGot;
  ui.goBadge.classList.toggle('on', isBest);
  ui.over.classList.add('show');
  ui.hud.classList.remove('show');
  restartLock = time + 0.6;
  updateHud(true);
}

const lastHud = { score: -1, best: -1, coins: -1 };
function updateHud(force) {
  const s = score();
  const shownBest = Math.max(best, s);
  if (force || s !== lastHud.score) { ui.hudHeight.textContent = s; lastHud.score = s; }
  if (force || shownBest !== lastHud.best) {
    ui.hudBest.textContent = shownBest; lastHud.best = shownBest;
    if (ui.hudBest.parentNode && ui.hudBest.parentNode.classList) ui.hudBest.parentNode.classList.toggle('beating', s > 0 && s >= best);
  }
  if (force || coinsGot !== lastHud.coins) { ui.hudCoins.textContent = coinsGot; lastHud.coins = coinsGot; }
}

/* ==========================================================================
   RENDER — helpers
   ========================================================================== */
function rr(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Pre-rendered soft glow sprites (cheap way to get lots of glow/blur)
const GLOW_COLORS = {
  white: [255, 255, 255], mint: [90, 240, 200], lime: [200, 250, 100], sky: [110, 190, 255], peach: [255, 190, 130],
  red: [255, 80, 100], warm: [255, 170, 70], pink: [255, 120, 220], violet: [160, 110, 255], gold: [255, 210, 80],
};
const glow = {};
function buildGlows() {
  for (const k in GLOW_COLORS) {
    const [r, g, b] = GLOW_COLORS[k];
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const x = c.getContext('2d');
    const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, `rgba(${r},${g},${b},1)`);
    gr.addColorStop(0.35, `rgba(${r},${g},${b},0.35)`);
    gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
    x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
    glow[k] = c;
  }
}
function drawGlow(name, x, y, w, h, alpha) {
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(glow[name], x - w / 2, y - h / 2, w, h);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

/* ---------- Background: altitude-shifting sky + parallax layers ---------- */
const SKY = [
  { m: 0,   top: [28, 22, 104], bot: [104, 52, 178] },   // indigo -> violet
  { m: 100, top: [44, 18, 112], bot: [170, 56, 176] },   // violet -> magenta
  { m: 260, top: [16, 30, 100], bot: [52, 104, 196] },   // deep blue
  { m: 520, top: [8, 10, 44],   bot: [44, 28, 112] },    // dusk of space
  { m: 900, top: [4, 4, 20],    bot: [24, 12, 70] },     // deep space
];
function skyAt(m) {
  let i = 0;
  while (i < SKY.length - 2 && m >= SKY[i + 1].m) i++;
  const a = SKY[i], b = SKY[i + 1];
  const t = smooth(clamp((m - a.m) / (b.m - a.m), 0, 1));
  const mix = (c1, c2) => `rgb(${Math.round(lerp(c1[0], c2[0], t))},${Math.round(lerp(c1[1], c2[1], t))},${Math.round(lerp(c1[2], c2[2], t))})`;
  return { top: mix(a.top, b.top), bot: mix(a.bot, b.bot) };
}

// Draw a repeating tile layer. Items are generated deterministically per tile.
function forTiles(factor, tileH, seed, scroll, cb) {
  const sf = scroll * factor, margin = 140;
  const i0 = Math.floor((-margin - sf) / tileH), i1 = Math.floor((view.h + margin - sf) / tileH);
  for (let i = i0; i <= i1; i++) cb(mulberry32(i * 92821 + seed), i * tileH + sf);
}

function drawHills(f, base, amp, color, ph, scroll) {
  const shift = scroll * f, top = base + shift - amp * 1.6;
  if (top > view.h) return;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, view.h + 4);
  for (let x = 0; x <= WORLD_W + 12; x += 12) {
    ctx.lineTo(x, base + shift + Math.sin(x * 0.012 + ph) * amp + Math.sin(x * 0.031 + ph * 2) * amp * 0.35);
  }
  ctx.lineTo(WORLD_W, view.h + 4);
  ctx.closePath();
  ctx.fill();
}

function drawBackground(t) {
  const H = view.h;
  const scroll = camOrigin - camY;                  // px the camera has climbed
  const altM = Math.max(0, scroll / PX_PER_M);
  const sky = skyAt(altM);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, sky.top); g.addColorStop(1, sky.bot);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, WORLD_W, H);

  // stars (visibility grows with altitude)
  const starVis = lerp(0.3, 1, clamp(altM / 300, 0, 1));
  forTiles(0.05, 360, 11, scroll, (rng, y0) => {
    for (let n = 0; n < 22; n++) {
      const x = rng() * WORLD_W, y = y0 + rng() * 360, r = 0.5 + rng() * 1.3, ph = rng() * TAU;
      ctx.globalAlpha = starVis * (0.45 + 0.55 * Math.sin(t * 1.6 + ph) * Math.sin(t * 1.6 + ph) );
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    }
  });
  ctx.globalAlpha = 1;

  // nebula blobs
  const tints = ['pink', 'violet', 'sky'];
  forTiles(0.12, 640, 23, scroll, (rng, y0) => {
    for (let n = 0; n < 3; n++) {
      const x = rng() * WORLD_W, y = y0 + rng() * 640, s = 240 + rng() * 160, tint = tints[Math.floor(rng() * 3)], a = 0.14 + rng() * 0.12;
      drawGlow(tint, x, y, s, s * 0.8, a);
    }
  });

  drawHills(0.3, H * 0.76, 24, 'rgba(70,38,150,0.55)', 1.3, scroll);

  // drifting clouds (fade out toward space)
  const cloudA = 1 - clamp(altM / 500, 0, 0.8);
  forTiles(0.25, 480, 37, scroll, (rng, y0) => {
    for (let n = 0; n < 3; n++) {
      const x0 = rng() * (WORLD_W + 260), y = y0 + rng() * 480, w = 120 + rng() * 90, sp = 4 + rng() * 8, a = (0.1 + rng() * 0.07) * cloudA;
      const x = ((x0 + t * sp) % (WORLD_W + 260)) - 130;
      drawGlow('white', x, y, w, w * 0.34, a * 1.6);
      drawGlow('white', x - w * 0.28, y + 4, w * 0.7, w * 0.26, a);
      drawGlow('white', x + w * 0.3, y + 5, w * 0.64, w * 0.24, a);
    }
  });

  drawHills(0.55, H * 0.83, 20, 'rgba(34,16,92,0.78)', 4.1, scroll);

  // near bokeh
  forTiles(0.45, 420, 53, scroll, (rng, y0) => {
    for (let n = 0; n < 4; n++) {
      const x = rng() * WORLD_W, y = y0 + rng() * 420 + Math.sin(t * 0.6 + n) * 4, r = 6 + rng() * 16, a = 0.04 + rng() * 0.07;
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      ctx.strokeStyle = `rgba(255,255,255,${a * 0.9})`; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
    }
  });
}

/* ---------- Platforms, coins, ball ---------- */
function drawPlatform(p, t) {
  const { x, y, w, h } = p;
  const sy = y - camY;
  if (sy < -80 || sy > view.h + 80) return;
  const c = PLAT[p.type];

  const pulse = p.type === 'spiked' ? 0.35 + 0.15 * Math.sin(t * 5) : 0.28;
  drawGlow(c.glow, x + w / 2, y + h / 2 + 2, w * 1.5, h * 4.2, pulse);

  ctx.fillStyle = 'rgba(10,5,40,0.28)';                       // soft drop shadow
  rr(x + 2, y + 6, w - 4, h, h / 2); ctx.fill();

  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, c.a); g.addColorStop(1, c.b);
  ctx.fillStyle = g;
  rr(x, y, w, h, h / 2.2); ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.38)';                   // top highlight
  rr(x + h * 0.5, y + 2, w - h, 3, 1.5); ctx.fill();

  if (p.type === 'moving') {
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    const cy = y + h / 2 + 1;
    ctx.beginPath(); ctx.moveTo(x + 14, cy - 3.5); ctx.lineTo(x + 8, cy); ctx.lineTo(x + 14, cy + 3.5); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x + w - 14, cy - 3.5); ctx.lineTo(x + w - 8, cy); ctx.lineTo(x + w - 14, cy + 3.5); ctx.fill();
  } else if (p.type === 'fragile') {
    ctx.strokeStyle = 'rgba(120,60,20,0.5)'; ctx.lineWidth = 1.5; ctx.lineCap = 'round';
    for (const f of [0.34, 0.68]) {
      const cx = x + w * f;
      ctx.beginPath(); ctx.moveTo(cx, y + 2); ctx.lineTo(cx - 3, y + h * 0.5); ctx.lineTo(cx + 2, y + h * 0.7); ctx.lineTo(cx - 1, y + h - 1); ctx.stroke();
    }
  } else if (p.type === 'spring') {
    // coil: compress on trigger, then release with a damped overshoot
    const e = p.spT;
    const scl = e > 1 ? 1 : 1 - 0.55 * Math.exp(-6 * e) * Math.cos(20 * e);
    const ch = 16 * scl, cx = x + w / 2, base = y - 1;
    ctx.fillStyle = '#b02a52'; rr(cx - 12, base - 3, 24, 5, 2.5); ctx.fill();
    ctx.strokeStyle = '#f2f0ff'; ctx.lineWidth = 2.6; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx - 8, base - 3);
    for (let i = 0; i < 4; i++) {
      const yy = base - 3 - ch * ((i + 1) / 4);
      ctx.lineTo(cx + (i % 2 ? -8 : 8), yy + ch / 8);
    }
    ctx.stroke();
    ctx.fillStyle = '#ff5a7a'; rr(cx - 14, base - 3 - ch - 4, 28, 6, 3); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.5)'; rr(cx - 10, base - 3 - ch - 3, 14, 2, 1); ctx.fill();
  } else if (p.type === 'spiked') {
    const n = Math.max(3, Math.floor(w / 14)), sw = (w - 8) / n;
    const sg = ctx.createLinearGradient(0, y - SPIKE_H, 0, y);
    sg.addColorStop(0, '#ff8aa0'); sg.addColorStop(1, '#d1243f');
    ctx.fillStyle = sg;
    for (let i = 0; i < n; i++) {
      const x0 = x + 4 + i * sw;
      ctx.beginPath(); ctx.moveTo(x0, y + 1); ctx.lineTo(x0 + sw / 2, y - SPIKE_H); ctx.lineTo(x0 + sw, y + 1); ctx.closePath(); ctx.fill();
    }
  }
}

function drawCoin(c, t) {
  const sy = c.y - camY;
  if (sy < -40 || sy > view.h + 40) return;
  const y = c.y + Math.sin(t * 3 + c.ph) * 3;
  const sx = Math.max(0.28, Math.abs(Math.cos(t * 3.2 + c.ph)));
  drawGlow('gold', c.x, y, 46, 46, 0.45);
  ctx.save();
  ctx.translate(c.x, y); ctx.scale(sx, 1);
  const g = ctx.createRadialGradient(-3, -4, 1, 0, 0, c.r);
  g.addColorStop(0, '#fff6b8'); g.addColorStop(0.55, '#ffd24a'); g.addColorStop(1, '#e0951a');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, c.r, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(160,90,10,0.55)'; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.arc(0, 0, c.r * 0.66, 0, TAU); ctx.stroke();
  ctx.restore();
}

function drawBallAt(x, y, t) {
  const b = ball;
  ctx.save();
  ctx.translate(x, y + BALL_R);              // anchor at the feet so squash stays grounded
  ctx.scale(b.sx, b.sy);
  drawGlow('warm', 0, -BALL_R, BALL_R * 4.4, BALL_R * 4.4, 0.32);
  const g = ctx.createRadialGradient(-BALL_R * 0.35, -BALL_R * 1.4, BALL_R * 0.12, 0, -BALL_R, BALL_R * 1.15);
  g.addColorStop(0, '#fff1c9'); g.addColorStop(0.38, '#ffb347'); g.addColorStop(1, '#f0562f');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, -BALL_R, BALL_R, 0, TAU); ctx.fill();
  // eyes look where you're heading
  const ex = clamp(b.vx / MAX_SPEED, -1, 1) * 3, ey = clamp(b.vy / 900, -1, 1) * 1.6;
  const blink = (t % 3.4) < 0.11 ? 0.12 : 1;
  for (const s of [-1, 1]) {
    const cx = s * 5.6 + ex * 0.7, cy = -BALL_R - 3 + ey * 0.4;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.ellipse(cx, cy, 4.3, 4.6 * blink, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#2b1650';
    ctx.beginPath(); ctx.ellipse(cx + ex * 0.55, cy + ey * 0.5, 2.1, 2.4 * blink, 0, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

function drawBall(t) {
  if (!ball.visible) return;
  // trail (older = smaller & fainter)
  const n = trail.length;
  for (let i = 0; i < n; i++) {
    const q = trail[i], f = (i + 1) / n;
    ctx.fillStyle = `rgba(255,150,70,${0.26 * f * f})`;
    ctx.beginPath(); ctx.arc(q.x, q.y, BALL_R * (0.3 + 0.62 * f), 0, TAU); ctx.fill();
  }
  // contact shadow on the platform below
  let best = null;
  for (const p of platforms) {
    if (p.dead || p.y < ball.y + BALL_R - 2) continue;
    if (Math.abs(ball.x - (p.x + p.w / 2)) < p.w / 2 + 6 && (!best || p.y < best.y)) best = p;
  }
  if (best) {
    const d = best.y - (ball.y + BALL_R);
    if (d < 260) {
      ctx.fillStyle = `rgba(10,5,40,${0.3 * (1 - d / 260)})`;
      ctx.beginPath(); ctx.ellipse(ball.x, best.y + 1, BALL_R * (1 - d / 560), 3.2, 0, 0, TAU); ctx.fill();
    }
  }
  drawBallAt(ball.x, ball.y, t);
  if (ball.x < BALL_R * 1.6) drawBallAt(ball.x + WORLD_W, ball.y, t);       // wrap ghosts
  else if (ball.x > WORLD_W - BALL_R * 1.6) drawBallAt(ball.x - WORLD_W, ball.y, t);
}

function drawParticles() {
  for (const p of particles) {
    const a = clamp(p.life / p.max, 0, 1);
    switch (p.kind) {
      case 'dot':
        ctx.globalAlpha = a; ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.4 + 0.6 * a), 0, TAU); ctx.fill();
        break;
      case 'ring':
        ctx.globalAlpha = a * (p.alpha || 1); ctx.strokeStyle = p.color; ctx.lineWidth = 3 * a + 0.5;
        { const r = p.size + (1 - a) * p.grow;
          ctx.beginPath(); ctx.ellipse(p.x, p.y, r, r * p.flat, 0, 0, TAU); ctx.stroke(); }
        break;
      case 'pop':
        ctx.globalAlpha = a * 0.9; ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 + (1 - a) * 1.3), 0, TAU); ctx.fill();
        break;
      case 'rect':
        ctx.globalAlpha = Math.min(1, a * 1.6); ctx.fillStyle = p.color;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        rr(-p.w / 2, -p.h / 2, p.w, p.h, 4); ctx.fill();
        ctx.restore();
        break;
    }
  }
  ctx.globalAlpha = 1;
}

function drawFloats() {
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  for (const f of floats) {
    const t = 1 - f.life / f.max;
    const pop = t < 0.12 ? lerp(0.4, 1.3, t / 0.12) : t < 0.3 ? lerp(1.3, 1, (t - 0.12) / 0.18) : 1;
    ctx.save();
    ctx.translate(f.x, f.y); ctx.scale(pop, pop);
    ctx.globalAlpha = f.life < 0.35 ? f.life / 0.35 : 1;
    ctx.font = `800 ${f.size}px ${FONT}`;
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(25,8,60,0.65)';
    ctx.strokeText(f.text, 0, 0);
    ctx.fillStyle = f.color; ctx.fillText(f.text, 0, 0);
    ctx.restore();
  }
}

function render(t) {
  ctx.setTransform(view.k, 0, 0, view.k, 0, 0);
  drawBackground(t);

  ctx.save();
  const ox = shake ? (Math.random() * 2 - 1) * shake : 0;
  const oy = shake ? (Math.random() * 2 - 1) * shake : 0;
  ctx.translate(ox, -camY + oy);
  for (const p of platforms) drawPlatform(p, t);
  for (const c of coins) if (!c.taken) drawCoin(c, t);
  drawParticles();
  drawBall(t);
  drawFloats();
  ctx.restore();

  if (introFade > 0) {
    ctx.fillStyle = `rgba(10,6,40,${introFade * 0.7})`;
    ctx.fillRect(0, 0, WORLD_W, view.h);
  }
}

/* ==========================================================================
   MAIN LOOP
   ========================================================================== */
function update(dt) {
  time += dt;
  if (state === 'menu' || state === 'playing') simulate(dt);
  else if (state === 'dying') {
    dyingT -= dt;
    updateSquash(dt);
    if (dyingT <= 0) showGameOver();
  }
  updateFx(dt);
  if (state === 'playing') updateHud(false);
}

function frame(now) {
  requestAnimationFrame(frame);
  if (lastTime === null) lastTime = now;
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  if (!(dt > 0)) dt = 1 / 60;
  dt = Math.min(dt, MAX_FRAME_DT);
  update(dt);
  render(time);
}

/* ---------- boot ---------- */
function boot() {
  buildGlows();
  best = Number(store.get(BEST_KEY, '0')) || 0;
  syncMuteButton();
  resize();
  resetWorld();
  updateHud(true);
  bindInput();
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(ui.game);
  requestAnimationFrame(frame);
}
boot();
})();
