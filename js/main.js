/*
 * Hue Swarm — UI, input and main loop.
 */
'use strict';

(function () {
  const SMALL_SCREEN = Math.min(window.innerWidth, window.innerHeight) < 600;

  // The defaults are the "Rainbow ring": balls clump into rainbow blobs, the
  // blobs merge into a comet, the comet curls up and closes into a colour wheel.
  const DEFAULTS = {
    count: SMALL_SCREEN ? 6000 : 10000,
    size: 1,
    colors: 0,
    simAttract: true,
    oppRepel: true,
    simRepel: false,
    oppAttract: false,
    collisions: true,
    walls: false,
    centerPull: true,
    tolerance: 25,
    attract: 65,
    repel: 85,
    range: 45,
    centerStrength: 25,
    friction: 12,
    jiggle: 0,
    speed: 1,
    mouseMode: 'push',
    mouseRadius: SMALL_SCREEN ? 70 : 110,
    mouseStrength: 60,
    mouseClickOnly: false,
    showMouse: true,
    shading: true,
    glow: false,
    trails: false,
    trailLength: 60,
  };

  // Presets override DEFAULTS (anything not listed falls back to the default).
  const BOXED = { walls: true, centerPull: false };
  const PRESETS = [
    {
      name: '🌈 Rainbow ring',
      tip: 'Blobs merge into a comet that curls up into a colour wheel (about a minute)',
      s: {},
    },
    {
      name: '🫧 Colour blobs',
      tip: 'Lots of little rainbow blobs that slowly merge',
      s: Object.assign({}, BOXED, { range: 20, attract: 60, repel: 60, tolerance: 15, friction: 10 }),
    },
    {
      name: '🪱 Rainbow worms',
      tip: 'Short-range forces make wriggly, stretchy clumps',
      s: Object.assign({}, BOXED, { range: 12, attract: 70, repel: 50, friction: 10 }),
    },
    {
      name: '☄️ Comet',
      tip: 'Strong attraction pulls everything into one sorted rainbow bar',
      s: Object.assign({}, BOXED, { range: 25, attract: 80, repel: 30, friction: 10 }),
    },
    {
      name: '💥 Supernova',
      tip: 'Starts packed in the middle, explodes, then pulls itself back together',
      s: { range: 45, attract: 60, repel: 100, friction: 6, centerStrength: 15 },
      start: 'center',
    },
    {
      name: '🎯 3 teams',
      tip: 'Three colours that stick with their own kind',
      s: Object.assign({}, BOXED, { colors: 3, range: 45, attract: 60, repel: 60, friction: 25 }),
    },
    {
      name: '💞 Opposites attract',
      tip: 'Red and cyan pull together, same colours push apart: they link into chains',
      s: Object.assign({}, BOXED, { colors: 2, simAttract: false, oppRepel: false, simRepel: true, oppAttract: true,
        attract: 50, repel: 50, range: 30, friction: 25 }),
    },
    {
      name: '🎱 Billiards',
      tip: 'No colour forces at all, just balls bouncing around',
      s: Object.assign({}, BOXED, { simAttract: false, oppRepel: false, friction: 0 }),
      start: 'fast',
    },
  ];

  const STORAGE_KEY = 'hue-swarm-settings-v1';

  /* ---------- settings ---------- */

  function loadParams() {
    const p = Object.assign({}, DEFAULTS);
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && typeof saved === 'object') {
        for (const k of Object.keys(DEFAULTS)) {
          if (k in saved && typeof saved[k] === typeof DEFAULTS[k]) p[k] = saved[k];
        }
      }
    } catch (e) { /* ignore */ }
    return p;
  }

  let saveTimer = 0;
  function saveParams() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(params)); } catch (e) { /* ignore */ }
    }, 300);
  }

  const params = loadParams();

  /* ---------- core objects ---------- */

  const glCanvas = document.getElementById('gl');
  const overlay = document.getElementById('overlay');
  const octx = overlay.getContext('2d');
  const sim = new Simulation(params);
  const renderer = new Renderer(glCanvas);

  let W = 0, H = 0, dpr = 1;
  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.resize(W, H, dpr);
    overlay.width = Math.round(W * dpr);
    overlay.height = Math.round(H * dpr);
    overlay.style.width = W + 'px';
    overlay.style.height = H + 'px';
    sim.setWorld(W, H);
  }
  resize();
  window.addEventListener('resize', resize);

  sim.setCount(params.count);

  /* ---------- UI binding ---------- */

  const $ = (sel) => document.querySelector(sel);
  const fmt = {
    size: (v) => (+v).toFixed(2) + '×',
    attract: (v) => v + '%',
    repel: (v) => v + '%',
    centerStrength: (v) => v + '%',
    friction: (v) => v + '%',
    mouseStrength: (v) => v + '%',
    trailLength: (v) => v + '%',
    mouseRadius: (v) => v + ' px',
    speed: (v) => (+v).toFixed(2).replace(/\.?0+$/, '') + '×',
    range: (v) => (+v >= 100 ? 'Global' : ['Very short', 'Short', 'Medium', 'Long', 'Very long'][Math.min(4, Math.floor(v / 20))] + ' · ' + v),
    tolerance: (v) => '±' + Math.round(v * 3.6) + '°',
    jiggle: (v) => (+v === 0 ? 'Off' : v + '%'),
  };

  const inputs = Array.from(document.querySelectorAll('[data-key]'));
  const outputs = {};
  document.querySelectorAll('output[data-for]').forEach((o) => { outputs[o.dataset.for] = o; });
  const countNum = $('#countNum');

  function showValue(key) {
    if (outputs[key]) outputs[key].textContent = fmt[key] ? fmt[key](params[key]) : params[key];
  }

  function syncUI() {
    for (const el of inputs) {
      const k = el.dataset.key;
      if (el.type === 'checkbox') el.checked = !!params[k];
      else el.value = params[k];
      showValue(k);
    }
    countNum.value = params.count;
    document.querySelectorAll('input[name="mouseMode"]').forEach((r) => { r.checked = r.value === params.mouseMode; });
  }

  function onParamChange(key) {
    switch (key) {
      case 'size': sim.updateRadius(); break;
      case 'colors': sim.applyColors(); break;
      case 'trails': renderer.clear(); break;
    }
    saveParams();
  }

  for (const el of inputs) {
    const k = el.dataset.key;
    if (k === 'count') continue;
    const read = () => {
      if (el.type === 'checkbox') params[k] = el.checked;
      else if (el.tagName === 'SELECT') params[k] = +el.value;
      else params[k] = +el.value;
      showValue(k);
      onParamChange(k);
    };
    el.addEventListener(el.type === 'range' ? 'input' : 'change', read);
  }

  // ball count: live label while dragging, rebuild on release
  const countSlider = $('#count');
  countSlider.addEventListener('input', () => { countNum.value = countSlider.value; });
  countSlider.addEventListener('change', () => setCount(+countSlider.value));
  countNum.addEventListener('change', () => setCount(+countNum.value));

  function setCount(n) {
    n = Math.round(Math.min(50000, Math.max(1, n || DEFAULTS.count)));
    params.count = n;
    countNum.value = n;
    countSlider.value = n;
    stopFollowing();
    sim.setCount(n);
    renderer.clear();
    saveParams();
  }

  document.querySelectorAll('input[name="mouseMode"]').forEach((r) => {
    r.addEventListener('change', () => { if (r.checked) { params.mouseMode = r.value; saveParams(); } });
  });

  /* ---------- buttons ---------- */

  let paused = false;
  const btnPause = $('#btnPause');
  function setPaused(v) {
    paused = v;
    btnPause.textContent = paused ? '▶ Play' : '⏸ Pause';
    btnPause.classList.toggle('active', paused);
  }

  function randomize() {
    sim.randomize();
    followPath.length = 0;
    renderer.clear();
  }

  $('#btnRandomize').addEventListener('click', randomize);
  btnPause.addEventListener('click', () => setPaused(!paused));
  $('#btnFollow').addEventListener('click', () => {
    if (followed >= 0) stopFollowing(); else follow(Math.floor(Math.random() * sim.n));
  });
  $('#btnRecolor').addEventListener('click', () => { shuffleColors(); });
  $('#btnReset').addEventListener('click', () => {
    Object.assign(params, DEFAULTS);
    syncUI();
    setCount(params.count);
    saveParams();
  });

  function shuffleColors() {
    const h = sim.hue, n = sim.n;
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = h[i]; h[i] = h[j]; h[j] = t;
    }
    for (let i = 0; i < n; i++) sim.setHue(i, h[i]);
  }

  // presets
  const presetBox = $('#presets');
  PRESETS.forEach((pr) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = pr.name;
    b.title = pr.tip;
    b.addEventListener('click', () => applyPreset(pr));
    presetBox.appendChild(b);
  });

  function applyPreset(pr) {
    // keep the user's own mouse & display choices; reset the physics
    const keep = ['mouseMode', 'mouseRadius', 'mouseStrength', 'mouseClickOnly', 'showMouse', 'shading', 'glow', 'trails', 'trailLength', 'count'];
    const kept = {};
    keep.forEach((k) => { kept[k] = params[k]; });
    Object.assign(params, DEFAULTS, kept, pr.s);
    syncUI();
    stopFollowing();
    if (params.count !== sim.n) sim.setCount(params.count);
    else { sim.applyColors(); sim.updateRadius(); sim.randomize(); }
    startPattern(pr.start);
    renderer.clear();
    saveParams();
    setPaused(false);
  }

  function startPattern(kind) {
    const n = sim.n, cx = W / 2, cy = H / 2;
    if (kind === 'center') {
      const R = Math.sqrt(n) * sim.rad * 1.1;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * R;
        sim.x[i] = sim.px[i] = cx + Math.cos(a) * r;
        sim.y[i] = sim.py[i] = cy + Math.sin(a) * r;
      }
    } else if (kind === 'fast') {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, v = 1 + Math.random() * 3;
        sim.px[i] = sim.x[i] - Math.cos(a) * v;
        sim.py[i] = sim.y[i] - Math.sin(a) * v;
      }
    }
  }

  /* ---------- panel ---------- */

  const panel = $('#panel');
  const fab = $('#panelToggle');
  function setPanel(open) {
    panel.classList.toggle('closed', !open);
    document.body.classList.toggle('panel-closed', !open);
    fab.setAttribute('aria-expanded', String(open));
  }
  fab.addEventListener('click', () => setPanel(true));
  $('#panelClose').addEventListener('click', () => setPanel(false));
  setPanel(!SMALL_SCREEN);

  /* ---------- follow a ball ---------- */

  let followed = -1;
  const followPath = [];
  const FOLLOW_LEN = 360;
  const btnFollow = $('#btnFollow');

  function follow(i) {
    if (i < 0 || i >= sim.n) return;
    followed = i;
    followPath.length = 0;
    btnFollow.textContent = '✖ Stop following';
    btnFollow.classList.add('active');
  }
  function stopFollowing() {
    followed = -1;
    followPath.length = 0;
    btnFollow.textContent = '🎯 Follow a ball';
    btnFollow.classList.remove('active');
  }
  function recordFollow() {
    if (followed < 0) return;
    followPath.push(sim.x[followed], sim.y[followed]);
    if (followPath.length > FOLLOW_LEN * 2) followPath.splice(0, followPath.length - FOLLOW_LEN * 2);
  }

  /* ---------- pointer input ---------- */

  const mouse = sim.mouse;
  let pointerInside = false, pointerDown = false, pointerType = 'mouse';
  let lastMoveT = 0, lastX = 0, lastY = 0;

  function updateActive() {
    const pressedOnly = params.mouseClickOnly || pointerType === 'touch' || pointerType === 'pen';
    mouse.active = pointerInside && (pressedOnly ? pointerDown : true);
  }

  function onMove(e) {
    const now = performance.now();
    const x = e.clientX, y = e.clientY;
    if (lastMoveT) {
      const dt = Math.max(1, now - lastMoveT);
      const k = 1000 / 60 / dt;
      mouse.vx = mouse.vx * 0.4 + (x - lastX) * k * 0.6;
      mouse.vy = mouse.vy * 0.4 + (y - lastY) * k * 0.6;
    }
    lastMoveT = now; lastX = x; lastY = y;
    mouse.x = x; mouse.y = y;
    pointerType = e.pointerType || 'mouse';
    pointerInside = true;
    updateActive();
    hideHintSoon();
  }

  glCanvas.addEventListener('pointermove', onMove);
  let lastTapT = 0, lastTapX = 0, lastTapY = 0;
  glCanvas.addEventListener('pointerdown', (e) => {
    // double-tap to follow a ball (touch devices don't reliably fire dblclick)
    if (e.pointerType !== 'mouse') {
      const now = performance.now();
      if (now - lastTapT < 320 && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 40) {
        follow(sim.nearest(e.clientX, e.clientY));
        lastTapT = 0;
      } else {
        lastTapT = now; lastTapX = e.clientX; lastTapY = e.clientY;
      }
    }
    pointerDown = true;
    lastMoveT = 0;
    mouse.vx = mouse.vy = 0;
    try { glCanvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    onMove(e);
  });
  const release = (e) => {
    pointerDown = false;
    if (e.pointerType !== 'mouse') pointerInside = false;
    updateActive();
  };
  glCanvas.addEventListener('pointerup', release);
  glCanvas.addEventListener('pointercancel', release);
  glCanvas.addEventListener('pointerleave', () => { pointerInside = false; updateActive(); });
  glCanvas.addEventListener('dblclick', (e) => { if (pointerType === 'mouse') follow(sim.nearest(e.clientX, e.clientY)); });
  glCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ---------- keyboard ---------- */

  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' && e.target.type === 'number' || e.target.tagName === 'SELECT')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case ' ': e.preventDefault(); setPaused(!paused); break;
      case 'r': case 'R': randomize(); break;
      case 'f': case 'F': if (followed >= 0) stopFollowing(); else follow(Math.floor(Math.random() * sim.n)); break;
      case 'c': case 'C': shuffleColors(); break;
      case 'h': case 'H': setPanel(panel.classList.contains('closed')); break;
      case 'Escape': stopFollowing(); break;
      default: return;
    }
  });

  /* ---------- hint ---------- */

  const hint = $('#hint');
  let hintTimer = setTimeout(() => hint.classList.add('hidden'), 9000);
  function hideHintSoon() {
    if (hint.classList.contains('hidden') || hintTimer === -1) return;
    clearTimeout(hintTimer);
    hintTimer = -1;
    setTimeout(() => hint.classList.add('hidden'), 3500);
  }
  if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
    hint.textContent = 'Drag on the balls to push them · double-tap a ball to follow it';
  }

  /* ---------- overlay ---------- */

  let overlayDirty = true;
  function drawOverlay() {
    const showMouse = params.showMouse && mouse.active && params.mouseMode !== 'off';
    if (!overlayDirty && !showMouse && followed < 0) return;
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, overlay.width, overlay.height);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    overlayDirty = false;

    if (followed >= 0 && followed < sim.n) {
      const pts = followPath, m = pts.length / 2;
      octx.lineCap = 'round';
      octx.lineJoin = 'round';
      if (m > 1) {
        const lw = Math.max(1.5, sim.rad * 0.6);
        const seg = 12;
        for (let pass = 0; pass < 2; pass++) {
          // dark halo first so the white path shows up on top of bright balls
          octx.lineWidth = pass === 0 ? lw + 3 : lw;
          for (let s = 0; s < m - 1; s += seg) {
            const e = Math.min(m - 1, s + seg), a = 0.08 + 0.85 * (e / m);
            octx.strokeStyle = pass === 0 ? `rgba(0,0,0,${(a * 0.6).toFixed(3)})` : `rgba(255,255,255,${a.toFixed(3)})`;
            octx.beginPath();
            octx.moveTo(pts[2 * s], pts[2 * s + 1]);
            for (let k = s + 1; k <= e; k++) octx.lineTo(pts[2 * k], pts[2 * k + 1]);
            octx.stroke();
          }
        }
      }
      const x = sim.x[followed], y = sim.y[followed];
      const r = sim.rad + Math.max(6, sim.rad);
      octx.lineWidth = 5;
      octx.strokeStyle = 'rgba(0,0,0,0.6)';
      octx.beginPath();
      octx.arc(x, y, r, 0, Math.PI * 2);
      octx.stroke();
      octx.lineWidth = 2.5;
      octx.strokeStyle = '#fff';
      octx.stroke();
      octx.lineWidth = 1.5;
      octx.strokeStyle = 'rgba(255,255,255,0.45)';
      octx.beginPath();
      octx.arc(x, y, r + 8 + 4 * Math.sin(performance.now() / 180), 0, Math.PI * 2);
      octx.stroke();
      overlayDirty = true;
    }

    if (showMouse) {
      octx.lineWidth = 1;
      octx.setLineDash([4, 6]);
      octx.strokeStyle = 'rgba(255,255,255,0.35)';
      octx.beginPath();
      octx.arc(mouse.x, mouse.y, params.mouseRadius, 0, Math.PI * 2);
      octx.stroke();
      octx.setLineDash([]);
      overlayDirty = true;
    }
  }

  /* ---------- main loop ---------- */

  const STEP_MS = 1000 / 60;
  const fpsEl = $('#fps');
  const statsEl = $('#stats');
  let acc = 0, last = performance.now();
  let frames = 0, fpsT = last, fps = 0;

  function frame(now) {
    let dt = now - last;
    last = now;
    if (dt > 250) dt = 250;

    // pointer velocity decays when the pointer stops moving
    if (now - lastMoveT > 60) { mouse.vx *= 0.7; mouse.vy *= 0.7; }

    if (!paused) {
      acc += dt * params.speed;
      // never spend much more than ~28 ms per frame simulating
      const budget = Math.max(1, Math.floor(28 / Math.max(0.5, sim.stepMs)));
      const maxSteps = Math.min(Math.ceil(params.speed) + 1, budget);
      let steps = 0;
      while (acc >= STEP_MS && steps < maxSteps) {
        sim.step();
        recordFollow();
        acc -= STEP_MS;
        steps++;
      }
      if (steps === maxSteps) acc = Math.min(acc, STEP_MS);
    } else {
      acc = 0;
    }

    renderer.draw(sim, params);
    drawOverlay();

    frames++;
    if (now - fpsT >= 500) {
      fps = (frames * 1000) / (now - fpsT);
      frames = 0;
      fpsT = now;
      fpsEl.textContent = `${Math.round(fps)} fps · ${sim.n.toLocaleString()} balls`;
      statsEl.textContent = `${Math.round(fps)} fps · physics ${sim.stepMs.toFixed(1)} ms/step · ${renderer.mode === 'webgl' ? 'WebGL' : 'Canvas'}`;
    }
    requestAnimationFrame(frame);
  }

  syncUI();
  requestAnimationFrame(frame);

  // handy for tinkering from the dev console
  window.hueSwarm = { sim, params, renderer, applyPreset: (i) => applyPreset(PRESETS[i]), PRESETS, setCount, randomize };
})();
