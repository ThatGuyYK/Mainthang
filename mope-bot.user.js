// ==UserScript==
// @name         mope.io 1v1 apex bot (Venice)
// @namespace    venice.mope.bot
// @version      1.1.1
// @description  1v1 apex tail-biter with ESP. B = bot on/off, X = ESP, H = panel.
// @author       Venice
// @match        https://mope.io/*
// @match        https://*.mope.io/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  config
   * ------------------------------------------------------------------ */
  const LS_KEY = 'venice_mope_cfg_v1';
  const DEFAULTS = {
    bot: false,
    esp: true,
    panel: true,
    range: 900,        // target search radius (world units)
    biteRange: 62,     // start biting inside this distance
    boostDist: 240,    // hold boost while farther than this
    tailBias: 0.9,     // 1.0 = aim exactly at tail tip
    preferApex: true,  // weight tier 15+ heavily
    minTier: 0,        // ignore anything below this tier
    ability: true,
    abilityCd: 1100,
    abilityKey: 'Space', // KeyboardEvent.code used for the ability
    abilityNet: false,   // FIX #11: opt-in; network.send signature is unverified
    tickHz: 25,
  };
  const CFG = Object.assign({}, DEFAULTS);
  try { Object.assign(CFG, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); } catch (e) {}
  const saveCfg = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(CFG)); } catch (e) {} };

  const APEX = new Set([
    'dragon', 'kingdragon', 'king_dragon', 'blackdragon', 'black_dragon',
    'trex', 't_rex', 't-rex', 'kraken', 'bluewhale', 'blue_whale', 'orca',
    'icemonster', 'ice_monster', 'dinomonster', 'dino_monster', 'seamonster',
    'sea_monster', 'yeti', 'thebigfoot', 'the_bigfoot', 'phoenix',
    'giantscorpion', 'giant_scorpion', 'argentavis', 'pterodactyl', 'mammoth',
    'sabertooth', 'saber_tooth', 'wolverine', 'hippo', 'elephant', 'cassowary',
    'giant_centipede', 'giantcentipede', 'giraffe', 'rhino', 'muskox'
  ]);

  const now = () => performance.now();

  /* ------------------------------------------------------------------ *
   *  socket hook
   *  FIX #2: remember every socket instead of only the most recent one,
   *  so a later ad/analytics socket can't hide the game's socket.
   * ------------------------------------------------------------------ */
  const SOCKETS = new Set();
  try {
    const NativeWS = window.WebSocket;
    const Wrapped = function (url, proto) {
      const ws = proto === undefined ? new NativeWS(url) : new NativeWS(url, proto);
      SOCKETS.add(ws);
      ws.addEventListener('close', () => SOCKETS.delete(ws));
      return ws;
    };
    Wrapped.prototype = NativeWS.prototype;
    Wrapped.CONNECTING = 0; Wrapped.OPEN = 1; Wrapped.CLOSING = 2; Wrapped.CLOSED = 3;
    window.WebSocket = Wrapped;
  } catch (e) {}

  /* ------------------------------------------------------------------ *
   *  app capture
   * ------------------------------------------------------------------ */
  let APP = null;

  const isAppShape = (o) =>
    !!o && typeof o === 'object' && o.player && (o.network || o.net) && (o.camera || o.classes);

  const isSocketOwner = (o) => {
    if (!o || typeof o !== 'object' || !SOCKETS.size) return false;
    const n = o.network || o.net;
    if (!n || typeof n !== 'object') return false;
    return SOCKETS.has(n.socket) || SOCKETS.has(n.ws) || SOCKETS.has(n.connection) || SOCKETS.has(n.conn);
  };

  // True for any Window object other than this page's own (iframes, popups).
  // Reading `.window` is one of the few properties allowed cross-origin.
  const isForeignWindow = (v) => {
    try { return v !== window && v.window === v; } catch (e) { return true; }
  };

  function scanForApp() {
    if (APP) return true;

    for (const k of ['mope', 'mopeio', '__mopeApp', '__mope', 'game', 'app', 'MOPE', 'GAME', 'client']) {
      let v; try { v = window[k]; } catch (e) { continue; }
      if (isForeignWindow(v)) continue;
      try { if (isAppShape(v)) { APP = v; return true; } } catch (e) {}
    }

    const seen = new Set();
    const queue = [[window, 0]];
    let head = 0;
    let budget = 30000;

    while (head < queue.length && budget-- > 0) {
      const [obj, depth] = queue[head++];
      if (!obj || seen.has(obj)) continue;
      seen.add(obj);
      let keys; try { keys = Object.keys(obj); } catch (e) { continue; }
      if (keys.length > 5000) continue;

      for (const k of keys) {
        let v; try { v = obj[k]; } catch (e) { continue; }
        if (!v || typeof v !== 'object') continue;
        // Cross-origin frames (ads, embeds) throw a SecurityError on almost
        // any property read. Skip every Window except our own, and guard the
        // remaining checks so one bad object can't abort the whole scan.
        if (isForeignWindow(v)) continue;
        try {
          if (v.nodeType) continue;
          if (isSocketOwner(v) || isAppShape(v)) { APP = v; return true; }
        } catch (e) { continue; }
        if (depth < 3) queue.push([v, depth + 1]); // one level deeper than before
      }
    }

    let node = getCanvas();
    for (let i = 0; node && i < 6; i++, node = node.parentElement) {
      for (const k of Object.keys(node)) {
        let v; try { v = node[k]; } catch (e) { continue; }
        if (isForeignWindow(v)) continue;
        try { if (isAppShape(v) || isSocketOwner(v)) { APP = v; return true; } } catch (e) {}
      }
    }
    return false;
  }

  setInterval(() => { if (!APP) scanForApp(); }, 400);

  /* ------------------------------------------------------------------ *
   *  canvas + coordinates
   * ------------------------------------------------------------------ */
  let canvasCache = null;
  function getCanvas() {
    if (canvasCache && canvasCache.isConnected && canvasCache !== ov) return canvasCache;
    let best = null, bestArea = 0;
    for (const c of document.querySelectorAll('canvas')) {
      if (c === ov) continue; // never pick our own overlay
      const a = c.clientWidth * c.clientHeight;
      if (a > bestArea) { bestArea = a; best = c; }
    }
    canvasCache = best;
    return best;
  }

  const viewSize = () => {
    const c = getCanvas();
    return [c ? c.clientWidth : innerWidth, c ? c.clientHeight : innerHeight];
  };

  function screenOfManual(wx, wy, vw, vh) {
    const cam = APP && APP.camera;
    const us = APP && APP.player;
    const cx = (cam && (cam.x ?? (cam.position && cam.position.x))) ?? (us ? us.x : 0);
    const cy = (cam && (cam.y ?? (cam.position && cam.position.y))) ?? (us ? us.y : 0);
    const z = (cam && (cam.zoom ?? 1)) || 1;
    return [(wx - cx) * z + vw / 2, (wy - cy) * z + vh / 2];
  }

  // null = not yet calibrated, 'manual' = no toLocalPoint available,
  // 'absolute' / 'centered' = shape of toLocalPoint's result.
  let ptrMode = null;
  let lastCalib = 0;

  // FIX #12: try both (x, y) and ({x, y}) call shapes.
  function callToLocal(cam, wx, wy) {
    const parse = (r) => {
      if (!r) return null;
      let x, y;
      if (typeof r.x === 'number') { x = r.x; y = r.y; }
      else if (Array.isArray(r) || typeof r[0] === 'number') { x = r[0]; y = r[1]; }
      return (typeof x === 'number' && isFinite(x) && isFinite(y)) ? [x, y] : null;
    };
    let out = null;
    try { out = parse(cam.toLocalPoint(wx, wy)); } catch (e) {}
    if (!out) { try { out = parse(cam.toLocalPoint({ x: wx, y: wy })); } catch (e) {} }
    return out;
  }

  function screenOf(wx, wy) {
    const [vw, vh] = viewSize();
    const cam = APP && APP.camera;
    const us = APP && APP.player;

    if (cam && typeof cam.toLocalPoint === 'function') {
      const p = callToLocal(cam, wx, wy);
      if (p) {
        // FIX #13: recalibrate periodically instead of locking in the first guess.
        const t = now();
        if (us && (ptrMode === null || ptrMode === 'manual' || t - lastCalib > 2000)) {
          lastCalib = t;
          const pu = callToLocal(cam, us.x, us.y);
          if (pu) {
            const dAbs = Math.hypot(pu[0] - vw / 2, pu[1] - vh / 2);
            const dCen = Math.hypot(pu[0], pu[1]);
            ptrMode = dAbs < dCen ? 'absolute' : 'centered';
          }
        }
        if (ptrMode === 'absolute') return p;
        if (ptrMode === 'centered') return [vw / 2 + p[0], vh / 2 + p[1]];
      }
    }
    if (ptrMode === null) ptrMode = 'manual';
    return screenOfManual(wx, wy, vw, vh);
  }

  let btnDown = false;
  let lastSx = 0, lastSy = 0;

  function firePointerMove(sx, sy) {
    const c = getCanvas();
    if (!c) return;
    const r = c.getBoundingClientRect();
    const o = {
      clientX: r.left + sx, clientY: r.top + sy,
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
      buttons: btnDown ? 1 : 0, // FIX #10: report held button while boosting
    };
    c.dispatchEvent(new PointerEvent('pointermove', o));
    c.dispatchEvent(new MouseEvent('mousemove', o)); // FIX #4: mouse listeners too
  }

  function setPointer(wx, wy) {
    if (!APP) return;
    const [sx, sy] = screenOf(wx, wy);
    lastSx = sx; lastSy = sy;
    const [vw, vh] = viewSize();
    const dx = sx - vw / 2, dy = sy - vh / 2;

    const inp = APP.inputs;
    if (inp) {
      const p = inp.pointerPosition || inp.pointer;
      if (p) {
        const ax = ptrMode === 'absolute' ? sx : dx;
        const ay = ptrMode === 'absolute' ? sy : dy;
        if (typeof p.x === 'number') { p.x = ax; p.y = ay; }
        else if (Array.isArray(p)) { p[0] = ax; p[1] = ay; }
      }
    }
    firePointerMove(sx, sy);
  }

  function setButton(down, sx, sy) {
    const c = getCanvas();
    if (!c) return;
    const r = c.getBoundingClientRect();
    const o = {
      clientX: r.left + sx, clientY: r.top + sy, button: 0, buttons: down ? 1 : 0,
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
    };
    if (down) {
      c.dispatchEvent(new PointerEvent('pointerdown', o));
      c.dispatchEvent(new MouseEvent('mousedown', o));
    } else {
      c.dispatchEvent(new PointerEvent('pointerup', o));
      c.dispatchEvent(new MouseEvent('mouseup', o));
    }
    btnDown = down;
  }

  let biteTimer = null;
  const release = () => {
    if (biteTimer) { clearTimeout(biteTimer); biteTimer = null; }
    if (btnDown) setButton(false, lastSx, lastSy);
  };

  function pressKey(code, key) {
    const t = document.body || document.documentElement;
    if (!t) return;
    const mk = (type) => new KeyboardEvent(type, { code, key, bubbles: true, cancelable: true });
    t.dispatchEvent(mk('keydown'));
    setTimeout(() => t.dispatchEvent(mk('keyup')), 60);
  }

  const keyForCode = (code) =>
    code === 'Space' ? ' ' : code.startsWith('Key') ? code.slice(3).toLowerCase() : code;

  // FIX #11: the keyboard path is the default and is always reachable.
  // The network path is opt-in and makes exactly one attempt.
  function sendAbility() {
    if (CFG.abilityNet) {
      const n = APP && (APP.network || APP.net);
      if (n && typeof n.send === 'function') {
        try { n.send('startAbility1', 1); return; } catch (e) {}
      }
    }
    pressKey(CFG.abilityKey, keyForCode(CFG.abilityKey));
  }

  /* ------------------------------------------------------------------ *
   *  entities
   * ------------------------------------------------------------------ */
  // FIX #15: de-duplicate across sources.
  function allAnimals() {
    if (!APP) return [];
    const out = new Set();
    const push = (v) => {
      if (!v) return;
      if (v instanceof Map || v instanceof Set) { for (const a of v.values()) out.add(a); return; }
      if (Array.isArray(v)) { for (const a of v) out.add(a); return; }
      if (typeof v === 'object') for (const k in v) out.add(v[k]);
    };
    push(APP.animals);
    push(APP.entities);
    push(APP.game && APP.game.animals);
    push(APP.world && APP.world.animals);
    if (!out.size && APP.classes) {
      const l = APP.classes.global && APP.classes.global.animal && APP.classes.global.animal.list;
      push(l);
    }
    return [...out].filter((a) => a && typeof a === 'object' && typeof a.x === 'number' && typeof a.y === 'number');
  }

  // FIX #14: identity check plus id / same-position fallback for self.
  function isSelf(a, us) {
    if (!us) return false;
    if (a === us || a.isYou) return true;
    if (us.id != null && a.id === us.id) return true;
    return a.x === us.x && a.y === us.y;
  }

  const others = () => {
    const us = APP && APP.player;
    return allAnimals().filter((a) => !isSelf(a, us));
  };

  const tierOf = (a) => a.tier ?? (a.species && a.species.tier) ?? (a.animal && a.animal.tier) ?? 0;

  // FIX #15: no longer falls back to a.name (likely a player nickname).
  function speciesName(a) {
    const s = (a.species && a.species.name) || a.speciesName || a.kind ||
      (a.constructor && a.constructor.name !== 'Object' && a.constructor.name) || '';
    return String(s).toLowerCase().replace(/[\s-]/g, '_');
  }

  const isApex = (a, tier) => {
    const n = speciesName(a);
    return tier >= 15 || APEX.has(n) || APEX.has(n.replace(/_/g, ''));
  };

  function bestTarget() {
    const us = APP && APP.player;
    if (!us) return null;
    let best = null, bestScore = -Infinity;
    for (const a of others()) {
      if (a.dead || a.isDead) continue;
      if (typeof a.health === 'number' && a.health <= 0) continue;
      const d = Math.hypot(a.x - us.x, a.y - us.y);
      if (d > CFG.range) continue;
      const tier = tierOf(a);
      if (CFG.minTier && tier < CFG.minTier) continue;
      let s = tier * 400 - d;
      if (CFG.preferApex && isApex(a, tier)) s += 4000;
      if (s > bestScore) { bestScore = s; best = a; }
    }
    return best;
  }

  // FIX #16: accept degrees as well as radians.
  function facingOf(tgt) {
    let ang = null;
    if (typeof tgt.angle === 'number' && isFinite(tgt.angle)) ang = tgt.angle;
    else if (typeof tgt.facing === 'number' && isFinite(tgt.facing)) ang = tgt.facing;
    if (ang === null) return null;
    if (Math.abs(ang) > Math.PI * 2 + 0.01) ang = ang * Math.PI / 180;
    return ang;
  }

  // tail point: behind the animal, opposite its facing
  function aimPoint(tgt) {
    const us = APP.player;
    const r = (tgt.size || 40) * CFG.tailBias;
    let ang = facingOf(tgt);
    if (ang === null) ang = Math.atan2(tgt.y - us.y, tgt.x - us.x);

    const tail = [tgt.x - Math.cos(ang) * r, tgt.y - Math.sin(ang) * r];
    const dTail = Math.hypot(tail[0] - us.x, tail[1] - us.y);
    const dCent = Math.hypot(tgt.x - us.x, tgt.y - us.y);

    // FIX #6: the old test (dTail < dCent + 140) was always true by the
    // triangle inequality. Go straight for the tail only when the tail is
    // on our side of the target; otherwise swing around it.
    if (dTail <= dCent) return tail;

    const side = ((tgt.x - us.x) * (tail[1] - us.y) - (tgt.y - us.y) * (tail[0] - us.x)) > 0 ? 1 : -1;
    const nx = -(tgt.y - us.y) * side, ny = (tgt.x - us.x) * side;
    const len = Math.hypot(nx, ny) || 1;
    const off = Math.max(r * 1.5, Math.min(180, dCent));
    return [tgt.x + (nx / len) * off, tgt.y + (ny / len) * off];
  }

  /* ------------------------------------------------------------------ *
   *  bot loop
   * ------------------------------------------------------------------ */
  let lastBite = 0, lastAbility = 0, biteUntil = 0;

  function tick() {
    // FIX #7: always let go of the button when the bot can't act.
    if (!CFG.bot) { release(); return; }
    if (!APP) { release(); scanForApp(); return; }
    const us = APP.player;
    if (!us || typeof us.x !== 'number') { release(); return; }

    const tgt = bestTarget();
    if (!tgt) { release(); return; }

    const aim = aimPoint(tgt);
    setPointer(aim[0], aim[1]);

    const d = Math.hypot(tgt.x - us.x, tgt.y - us.y);
    const t = now();

    if (d > CFG.boostDist) {
      if (biteTimer) { clearTimeout(biteTimer); biteTimer = null; }
      if (!btnDown) setButton(true, lastSx, lastSy);
    } else {
      // FIX #9: don't cut a bite tap short; only release once it has run.
      if (btnDown && t >= biteUntil) setButton(false, lastSx, lastSy);
      if (d < CFG.biteRange && t - lastBite > 110 && !btnDown) {
        lastBite = t;
        biteUntil = t + 45;
        setButton(true, lastSx, lastSy);
        if (biteTimer) clearTimeout(biteTimer);
        biteTimer = setTimeout(() => {
          biteTimer = null;
          if (btnDown) setButton(false, lastSx, lastSy);
        }, 45);
      }
    }

    if (CFG.ability && d < CFG.biteRange * 2.4 && t - lastAbility > CFG.abilityCd) {
      lastAbility = t;
      sendAbility();
    }
  }

  let tickTimer = null;
  function applyRate() {
    if (tickTimer) clearInterval(tickTimer);
    const hz = Math.min(100, Math.max(1, Number(CFG.tickHz) || DEFAULTS.tickHz));
    tickTimer = setInterval(tick, Math.max(10, Math.round(1000 / hz)));
  }
  applyRate();

  /* ------------------------------------------------------------------ *
   *  ESP
   * ------------------------------------------------------------------ */
  let ov = null, ovCtx = null;

  function ensureOverlay() {
    if (ov && ov.isConnected) return;
    ov = document.createElement('canvas');
    ov.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2147483000';
    (document.body || document.documentElement).appendChild(ov);
    ovCtx = ov.getContext('2d');
  }

  // FIX #8: wipe the overlay when ESP is off or the app is lost.
  function clearOverlay() {
    if (ovCtx && ov) { ovCtx.setTransform(1, 0, 0, 1, 0, 0); ovCtx.clearRect(0, 0, ov.width, ov.height); }
  }

  function drawEsp() {
    if (!CFG.esp || !APP) { clearOverlay(); return; }
    ensureOverlay();
    if (!ovCtx) return;
    const dpr = devicePixelRatio || 1;
    const W = Math.round(innerWidth * dpr), H = Math.round(innerHeight * dpr);
    if (ov.width !== W) ov.width = W;   // only reallocate on resize
    if (ov.height !== H) ov.height = H;
    ovCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ovCtx.clearRect(0, 0, innerWidth, innerHeight);

    const c = getCanvas();
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const us = APP.player;

    ovCtx.font = '600 11px ui-monospace, monospace';
    ovCtx.textBaseline = 'top';

    for (const a of others()) {
      const tier = tierOf(a);
      const apex = isApex(a, tier);
      const [lx, ly] = screenOf(a.x, a.y);
      const x = rect.left + lx, y = rect.top + ly;
      if (x < -80 || y < -80 || x > innerWidth + 80 || y > innerHeight + 80) continue;

      const rad = Math.max(14, (a.size || 40) * 0.9);
      ovCtx.strokeStyle = apex ? '#ff3355' : '#ffd24a';
      ovCtx.lineWidth = apex ? 2 : 1;
      ovCtx.beginPath();
      ovCtx.arc(x, y, rad, 0, Math.PI * 2);
      ovCtx.stroke();

      if (typeof a.health === 'number' && typeof a.maxHealth === 'number' && a.maxHealth > 0) {
        const w = rad * 1.8, h = 3;
        ovCtx.fillStyle = 'rgba(0,0,0,.6)';
        ovCtx.fillRect(x - w / 2, y - rad - 8, w, h);
        ovCtx.fillStyle = '#42d96b';
        ovCtx.fillRect(x - w / 2, y - rad - 8, w * Math.max(0, Math.min(1, a.health / a.maxHealth)), h);
      }

      const d = us ? Math.round(Math.hypot(a.x - us.x, a.y - us.y)) : 0;
      ovCtx.fillStyle = apex ? '#ff8899' : '#ffe9a8';
      // FIX #5: proper template interpolation
      ovCtx.fillText(`${speciesName(a) || '?'} t${tier} ${d}`, x + rad + 4, y - 6);
    }
  }

  setInterval(drawEsp, 66);

  /* ------------------------------------------------------------------ *
   *  UI
   * ------------------------------------------------------------------ */
  const el = (tag, props, text) => {
    const n = document.createElement(tag);
    if (props) Object.assign(n, props);
    if (text != null) n.textContent = text;
    return n;
  };

  let panel = null, statusEl = null;
  const inputs = {}; // FIX #17: keep references so hotkeys can update them

  function buildPanel() {
    if (panel) return;
    if (!document.body && !document.documentElement) return;
    panel = el('div');
    panel.style.cssText = [
      'position:fixed', 'top:8px', 'left:8px', 'z-index:2147483647',
      'background:rgba(12,14,20,.93)', 'color:#dfe6f2', 'border:1px solid #2b3346',
      'border-radius:8px', 'padding:9px 11px', 'font:12px/1.45 ui-monospace,monospace',
      'min-width:212px', 'user-select:none', 'box-shadow:0 6px 22px rgba(0,0,0,.5)',
    ].join(';');

    panel.appendChild(el('div', { style: 'font-weight:700;letter-spacing:.4px;margin-bottom:6px;color:#8fb6ff' }, 'MOPE BOT'));

    const row = (label, key, kind, opts) => {
      const r = el('label', { style: 'display:flex;align-items:center;gap:7px;margin:3px 0;cursor:pointer' });
      let input;
      if (kind === 'num') {
        const o = Object.assign({ min: 0, max: 2000, step: 10 }, opts);
        input = el('input', { type: 'number', min: String(o.min), max: String(o.max), step: String(o.step) });
        input.value = String(CFG[key]);
        input.style.cssText = 'width:58px;background:#0d1220;color:#dfe6f2;border:1px solid #2b3346;border-radius:4px;padding:1px 4px';
        input.addEventListener('change', () => {
          let v = Number(input.value);
          if (!isFinite(v)) v = DEFAULTS[key];
          v = Math.min(o.max, Math.max(o.min, v));
          CFG[key] = v; input.value = String(v);
          saveCfg();
          if (o.onChange) o.onChange();
        });
        r.appendChild(el('span', { style: 'flex:1' }, label));
        r.appendChild(input);
      } else {
        input = el('input', { type: 'checkbox' });
        input.checked = !!CFG[key];
        input.addEventListener('change', () => {
          CFG[key] = input.checked; saveCfg(); syncKeys();
          if (key === 'bot' && !CFG.bot) release();
        });
        r.appendChild(input);
        r.appendChild(el('span', null, label));
      }
      inputs[key] = input;
      panel.appendChild(r);
    };

    row('bot  [B]', 'bot');
    row('esp  [X]', 'esp');
    row('ability', 'ability');
    row('prefer apex', 'preferApex');
    row('range', 'range', 'num');
    row('bite range', 'biteRange', 'num');
    row('boost dist', 'boostDist', 'num');
    row('tick hz', 'tickHz', 'num', { min: 1, max: 100, step: 1, onChange: applyRate }); // FIX #19

    statusEl = el('div', { style: 'margin-top:7px;padding-top:6px;border-top:1px solid #2b3346;color:#7f8ea8;font-size:11px' }, '…');
    panel.appendChild(statusEl);
    panel.appendChild(el('div', { style: 'margin-top:6px;color:#5d6a80;font-size:11px' }, 'H hides panel'));

    (document.body || document.documentElement).appendChild(panel);
    syncKeys();
  }

  function syncKeys() {
    if (!panel) return;
    panel.style.display = CFG.panel ? '' : 'none';
    for (const k of Object.keys(inputs)) {
      const i = inputs[k];
      if (i.type === 'checkbox') i.checked = !!CFG[k];
      else if (document.activeElement !== i) i.value = String(CFG[k]);
    }
  }

  setInterval(() => {
    if (!statusEl) return;
    statusEl.textContent = APP
      ? `ok · others ${others().length} · ${ptrMode || 'calib'} · ${CFG.bot ? 'FIGHT' : 'idle'}`
      : 'hunting app object…';
  }, 500);

  window.addEventListener('keydown', (e) => {
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
    if (e.repeat) return;
    let handled = true;
    if (e.code === 'KeyB') { CFG.bot = !CFG.bot; if (!CFG.bot) release(); }
    else if (e.code === 'KeyX') { CFG.esp = !CFG.esp; }
    else if (e.code === 'KeyH') { CFG.panel = !CFG.panel; }
    else handled = false;
    if (!handled) return;
    // FIX #18: hotkeys don't leak through to the game
    e.preventDefault();
    e.stopImmediatePropagation();
    saveCfg(); buildPanel(); syncKeys();
  }, true);

  /* ------------------------------------------------------------------ *
   *  boot
   * ------------------------------------------------------------------ */
  function boot() {
    buildPanel();
    syncKeys();
    scanForApp();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
