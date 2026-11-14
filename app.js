// AppHóquei — estadística de partido (basada en la hoja "Folha_Estatistica")
// Todos los datos se guardan solo en este dispositivo (localStorage).
'use strict';

const PLAYERS = [
  { num: 21, name: 'Viki' },
  { num: 6, name: 'Piki' },
  { num: 8, name: 'Judith' },
  { num: 9, name: 'Nuri' },
  { num: 17, name: 'Mariona' },
  { num: 18, name: 'Candela' },
  { num: 23, name: 'Aine' },
  { num: 26, name: 'Ana Catarina' },
  { num: 43, name: 'Laia' },
  { num: 66, name: 'Ainara' },
  { num: 96, name: 'Maria' },
];

const TEAM = 'Telecable HC';
const VERSION = 2;
const MAX_ON_COURT = 5; // 4 jugadoras + portera
const MAX_CALLED = 10;  // convocadas por partido
const CARDS = {
  azul: { label: 'Tarjeta azul', min: 2 },
  roja: { label: 'Tarjeta roja', min: 4 },
};
const VIA = { juego: 'Jugada', fd: 'Falta directa', penalti: 'Penalti' };
const DEFAULTS = {
  partido: { partLen: 25, parts: 2 },
  entreno: { partLen: 0, parts: 1 },
};
const KEY_SESSION = 'hoquei.session';
const KEY_HISTORY = 'hoquei.history';

const $ = (id) => document.getElementById(id);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const pad = (n) => String(n).padStart(2, '0');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------- Estado ----------

function newSession(mode = 'partido', prev = null) {
  const same = prev && prev.mode === mode;
  // Partido: se propone la convocatoria del partido anterior (máx. 10). Entreno: todas.
  const prevSquad = prev && prev.mode === 'partido' ? prev.players.filter((p) => p.called).map((p) => p.num) : null;
  const squad = mode === 'entreno' ? PLAYERS.map((p) => p.num) : (prevSquad || PLAYERS.map((p) => p.num)).slice(0, MAX_CALLED);
  return {
    version: VERSION,
    mode,
    info: {
      team: prev ? prev.info.team : TEAM,
      rival: '',
      competicion: prev ? prev.info.competicion : '',
      jornada: '',
      numero: '',
      fecha: today(),
      hora: '',
      notas: '',
    },
    partLen: same ? prev.partLen : DEFAULTS[mode].partLen,
    parts: same ? prev.parts : DEFAULTS[mode].parts,
    part: 1,
    running: false,
    runStart: 0,       // Date.now() del último arranque/commit
    partMs: [0],       // tiempo jugado en cada parte
    possMs: [[0, 0]],  // posesión por parte: [nosotras, rival]
    poss: null,        // 'us' | 'them' | null
    starters: [],      // cinco inicial de cada parte
    players: PLAYERS.map((p) => ({
      ...p, called: squad.includes(p.num), on: false, ms: [0], since: 0, stints: [],
    })),
    squadOk: mode === 'entreno', // en partido hay que confirmar la convocatoria
    events: [],        // goles, faltas, bolas paradas y sanciones (en orden)
  };
}

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

let S = load(KEY_SESSION, null);
if (!S || S.version !== VERSION) S = newSession();
const save = () => store(KEY_SESSION, S);

// Jugadoras añadidas a la plantilla después de crear la sesión guardada
PLAYERS.forEach((p, i) => {
  if (S.players.some((x) => x.num === p.num)) return;
  const nParts = S.partMs.length;
  S.players.splice(i, 0, {
    ...p, called: S.mode === 'entreno', on: false,
    ms: Array(nParts).fill(0), since: 0, stints: [],
  });
  save();
});

// Nombre antiguo del equipo (versión anterior de la app)
if (S.info.team === 'Sporting CP') { S.info.team = TEAM; save(); }
{
  const h = load(KEY_HISTORY, []);
  if (h.some((r) => r.info.team === 'Sporting CP')) {
    h.forEach((r) => { if (r.info.team === 'Sporting CP') r.info.team = TEAM; });
    store(KEY_HISTORY, h);
  }
}
let undoStack = [];
let currentTab = 'pista';

// ---------- Reloj ----------

const liveDelta = () => (S.running ? Date.now() - S.runStart : 0);
const gameTotal = () => sum(S.partMs) + liveDelta();
const partNow = () => S.partMs[S.part - 1] + liveDelta();
const playerTotal = (p) => sum(p.ms) + (p.on ? liveDelta() : 0);
const possNow = (side) => S.possMs[S.part - 1][side] + ((side === 0 ? 'us' : 'them') === S.poss ? liveDelta() : 0);
const stamp = () => ({ part: S.part, t: partNow(), abs: gameTotal() });
const onCourt = () => S.players.filter((p) => p.called && p.on);
const findPlayer = (X, num) => X.players.find((p) => p.num === num);

// Pasa el tiempo en curso a los acumulados
function commit() {
  if (!S.running) return;
  const now = Date.now();
  const d = now - S.runStart;
  S.runStart = now;
  const i = S.part - 1;
  S.partMs[i] += d;
  if (S.poss === 'us') S.possMs[i][0] += d;
  if (S.poss === 'them') S.possMs[i][1] += d;
  S.players.forEach((p) => { if (p.on) p.ms[i] += d; });
}

// Convierte tiempo absoluto de juego en parte + minuto
function absToPart(abs) {
  let cum = 0;
  for (let i = 0; i < S.partMs.length; i++) {
    const len = i === S.part - 1 ? partNow() : S.partMs[i];
    if (abs <= cum + len || i === S.partMs.length - 1) return { part: i + 1, t: abs - cum };
    cum += len;
  }
}

// Guarda una copia para "Deshacer" antes de cada cambio
function action(fn) {
  undoStack.push(JSON.stringify(S));
  if (undoStack.length > 50) undoStack.shift();
  fn();
  save();
  render();
}

// ---------- Marcador ----------

function score(X, uptoIndex = Infinity) {
  let us = 0, them = 0;
  X.events.forEach((e, i) => {
    if (i <= uptoIndex && e.type === 'gol') e.side === 'favor' ? us++ : them++;
  });
  return [us, them];
}

// ---------- Jugadoras ----------

function closeStint(p, t) {
  const s = p.stints[p.stints.length - 1];
  if (!s || s.out !== null) return;
  if (t <= s.in) p.stints.pop(); // entrada y salida en el mismo segundo: se ignora
  else s.out = t;
}

function setOn(p, on) {
  if (p.on === on) return;
  const t = S.partMs[S.part - 1];
  if (on) p.stints.push({ part: S.part, in: t, out: null });
  else closeStint(p, t);
  p.on = on;
  p.since = sum(S.partMs);
}

function togglePlayer(num) {
  action(() => {
    commit();
    const p = findPlayer(S, num);
    setOn(p, !p.on);
  });
}

// ---------- Acciones del reloj ----------

function togglePlay() {
  if (!S.running && !S.squadOk) { openSquad(); return; }
  action(() => {
    if (S.running) {
      commit();
      S.running = false;
    } else {
      const i = S.part - 1;
      if (!S.starters[i]) S.starters[i] = onCourt().map((p) => p.num);
      S.running = true;
      S.runStart = Date.now();
    }
  });
  updateWakeLock();
}

function setPossession(side) {
  action(() => {
    commit();
    S.poss = S.poss === side ? null : side;
  });
}

function nextPart() {
  if (!confirm(`¿Terminar la ${partName(S, S.part)}?`)) return;
  action(() => {
    commit();
    S.running = false;
    const end = S.partMs[S.part - 1];
    S.players.forEach((p) => { if (p.on) closeStint(p, end); });
    S.part += 1;
    S.partMs.push(0);
    S.possMs.push([0, 0]);
    S.poss = null;
    S.players.forEach((p) => {
      p.ms.push(0);
      if (p.on) p.stints.push({ part: S.part, in: 0, out: null });
    });
  });
  updateWakeLock();
}

function finish() {
  if (!confirm('¿Terminar y guardar la sesión en el historial?')) return;
  commit();
  S.running = false;
  const end = S.partMs[S.part - 1];
  S.players.forEach((p) => { if (p.on) closeStint(p, end); });
  activeSanctions().forEach((e) => endSanction(e, Math.min(e.abs + e.dur, gameTotal())));

  const record = JSON.parse(JSON.stringify(S));
  record.id = uid();
  record.savedAt = new Date().toISOString();
  const history = load(KEY_HISTORY, []);
  history.unshift(record);
  store(KEY_HISTORY, history);

  S = newSession(S.mode, S);
  undoStack = [];
  save();
  render();
  updateWakeLock();
  showRecord(record);
  // al cerrar el resumen, se prepara el siguiente partido
  $('dlgResults').addEventListener('close', () => { if (!S.squadOk) openSquad(); }, { once: true });
}

function undo() {
  if (!undoStack.length) return;
  S = JSON.parse(undoStack.pop());
  save();
  render();
  updateWakeLock();
  toast('Deshecho');
}

function setMode(mode) {
  if (S.mode === mode || gameTotal() > 0 || S.events.length) return;
  S = newSession(mode, S);
  save();
  render();
  if (!S.squadOk) openSquad();
}

// ---------- Sanciones (superioridad / inferioridad) ----------

const activeSanctions = () => S.events.filter((e) => e.type === 'sancion' && e.endAbs == null);

function endSanction(e, abs) {
  const pt = absToPart(abs);
  e.endAbs = abs;
  e.endPart = pt.part;
  e.endT = pt.t;
  e.scoreEnd = score(S);
}

function checkSanctions() {
  const total = gameTotal();
  const due = activeSanctions().filter((e) => total >= e.abs + e.dur);
  if (!due.length) return;
  due.forEach((e) => endSanction(e, e.abs + e.dur));
  save();
  render();
  toast('Sanción cumplida');
}

function endSanctionManually(id) {
  const e = S.events.find((x) => x.id === id);
  if (!e || !confirm('¿Terminar esta sanción ahora?')) return;
  action(() => { commit(); endSanction(e, gameTotal()); });
}

// Tras un gol, ofrece terminar una tarjeta azul del equipo que lo ha encajado
function afterGoal(side) {
  const conceding = side === 'favor' ? 'rival' : 'nuestra';
  const e = activeSanctions().find((x) => x.side === conceding && x.card === 'azul');
  if (e && confirm(`¿Termina la sanción de ${whoText(S, e)} con este gol?`)) {
    action(() => { commit(); endSanction(e, gameTotal()); });
  }
}

// ---------- Registro de acciones ----------

const ACTIONS = {
  async golFavor() {
    const st = stamp(), five = onCourt().map((p) => p.num);
    const v = await ask('Gol a favor', [{ key: 'num', type: 'player', label: '¿Quién marca?' }]);
    if (!v) return;
    action(() => S.events.push({ id: uid(), type: 'gol', side: 'favor', via: 'juego', ...st, num: v.num, five }));
    toast('Gol a favor registrado');
    afterGoal('favor');
  },

  async golContra() {
    const st = stamp(), five = onCourt().map((p) => p.num);
    const v = await ask('Gol en contra', [{ key: 'rival', type: 'num', label: 'Nº de la rival (opcional)' }]);
    if (!v) return;
    action(() => S.events.push({ id: uid(), type: 'gol', side: 'contra', via: 'juego', ...st, rival: v.rival || '', five }));
    toast('Gol en contra registrado');
    afterGoal('contra');
  },

  async faltaNuestra() {
    const st = stamp();
    const v = await ask('Falta de equipo (nuestra)', [{ key: 'num', type: 'player', label: '¿Quién comete la falta?' }]);
    if (!v) return;
    action(() => S.events.push({ id: uid(), type: 'falta', side: 'nuestra', ...st, num: v.num }));
    toast(`Falta nº ${foulCount('nuestra')} en esta parte`);
  },

  faltaRival() {
    const st = stamp();
    action(() => S.events.push({ id: uid(), type: 'falta', side: 'rival', ...st }));
    toast(`Falta rival nº ${foulCount('rival')} en esta parte`);
  },

  async bolaParada() {
    const st = stamp(), five = onCourt().map((p) => p.num);
    const v = await ask('Falta directa / Penalti', [
      { key: 'kind', type: 'seg', label: 'Tipo', options: [['fd', 'Falta directa'], ['penalti', 'Penalti']] },
      { key: 'side', type: 'seg', label: 'Para', options: [['favor', 'A favor'], ['contra', 'En contra']] },
      { key: 'res', type: 'seg', label: 'Resultado', options: [['gol', 'Gol'], ['fallo', 'Fallado / parado']] },
      { key: 'num', type: 'player', label: 'Lanzadora', show: (x) => x.side === 'favor' },
      { key: 'rival', type: 'num', label: 'Nº de la rival (opcional)', show: (x) => x.side === 'contra' },
    ], { kind: 'fd', side: 'favor' });
    if (!v) return;
    const favor = v.side === 'favor';
    const scored = v.res === 'gol';
    action(() => {
      const bp = {
        id: uid(), type: 'bp', kind: v.kind, side: v.side, scored, ...st,
        num: favor ? v.num : null, rival: favor ? '' : v.rival || '',
      };
      S.events.push(bp);
      if (scored) {
        S.events.push({ id: uid(), type: 'gol', side: v.side, via: v.kind, ...st, num: bp.num, rival: bp.rival, five, bpId: bp.id });
      }
    });
    toast(`${VIA[v.kind]} ${scored ? '— gol' : '— fallado'}`);
    if (scored) afterGoal(v.side);
  },

  async tarjeta() {
    const st = stamp();
    const v = await ask('Tarjeta', [
      { key: 'side', type: 'seg', label: 'Equipo', options: [['nuestra', 'Nuestra'], ['rival', 'Rival']] },
      { key: 'card', type: 'seg', label: 'Tarjeta', options: [['azul', `Azul (${CARDS.azul.min}')`], ['roja', `Roja (${CARDS.roja.min}')`]] },
      { key: 'num', type: 'player', label: 'Jugadora sancionada', show: (x) => x.side === 'nuestra' },
      { key: 'rival', type: 'num', label: 'Nº de la rival (opcional)', show: (x) => x.side === 'rival' },
    ], { side: 'nuestra', card: 'azul' });
    if (!v) return;
    action(() => {
      commit();
      const ours = v.side === 'nuestra';
      if (ours) {
        const p = findPlayer(S, v.num);
        if (p && p.on) setOn(p, false); // la sancionada sale de pista
      }
      S.events.push({
        id: uid(), type: 'sancion', side: v.side, card: v.card, dur: CARDS[v.card].min * 60000, ...st,
        num: ours ? v.num : null, rival: ours ? '' : v.rival || '',
        scoreStart: score(S), five: onCourt().map((p) => p.num),
      });
    });
    toast(v.side === 'nuestra' ? 'Inferioridad en marcha' : 'Superioridad en marcha');
  },
};

function foulCount(side) {
  return S.events.filter((e) => e.type === 'falta' && e.side === side && e.part === S.part).length;
}

function deleteEvent(id) {
  const e = S.events.find((x) => x.id === id);
  if (!e || !confirm(`¿Borrar «${describe(S, e)}»?`)) return;
  action(() => {
    // un gol de falta directa/penalti y su lanzamiento se borran juntos
    S.events = S.events.filter((x) => x.id !== e.id && x.bpId !== e.id && x.id !== e.bpId);
  });
}

// ---------- Diálogo genérico ----------
// fields: { key, label, type: 'seg' | 'player' | 'num', options?, show?(vals) }
// Al tocar una jugadora se guarda directamente si ya está todo elegido.

function ask(title, fields, initial = {}) {
  return new Promise((resolve) => {
    const dlg = $('dlgAsk');
    const vals = { ...initial };
    let done = false;
    const visible = () => fields.filter((f) => !f.show || f.show(vals));
    const complete = () => visible().every((f) => f.type === 'num' || vals[f.key] != null);
    const close = (result) => {
      if (done) return;
      done = true;
      dlg.close();
      resolve(result);
    };

    function draw() {
      const body = $('askBody');
      body.replaceChildren();
      visible().forEach((f) => {
        const wrap = document.createElement('div');
        wrap.className = 'ask-field';
        const label = document.createElement('div');
        label.className = 'ask-label';
        label.textContent = f.label;
        wrap.append(label);

        if (f.type === 'seg') {
          const seg = document.createElement('div');
          seg.className = 'seg wide';
          f.options.forEach(([value, text]) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = text;
            b.classList.toggle('active', vals[f.key] === value);
            b.onclick = () => { vals[f.key] = value; draw(); };
            seg.append(b);
          });
          wrap.append(seg);
        } else if (f.type === 'player') {
          const grid = document.createElement('div');
          grid.className = 'pick';
          S.players.filter((p) => p.called).sort((a, b) => b.on - a.on).forEach((p) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'pick-btn' + (p.on ? ' on' : '') + (vals[f.key] === p.num ? ' active' : '');
            b.innerHTML = `<b>${p.num}</b><span></span>`;
            b.querySelector('span').textContent = p.name;
            b.onclick = () => {
              vals[f.key] = p.num;
              if (complete()) close(vals); else draw();
            };
            grid.append(b);
          });
          wrap.append(grid);
        } else {
          const input = document.createElement('input');
          input.type = 'text';
          input.inputMode = 'numeric';
          input.value = vals[f.key] || '';
          input.oninput = () => (vals[f.key] = input.value.trim());
          wrap.append(input);
        }
        body.append(wrap);
      });
      $('askOk').disabled = !complete();
    }

    $('askTitle').textContent = title;
    $('askOk').onclick = () => { if (complete()) close(vals); };
    $('askCancel').onclick = () => close(null);
    dlg.oncancel = (ev) => { ev.preventDefault(); close(null); };
    draw();
    dlg.showModal();
  });
}

// ---------- Formato ----------

function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

function partName(X, n) {
  if (X.mode === 'entreno' || n <= X.parts) return `${n}ª parte`;
  return `Prórroga ${n - X.parts}`;
}
const partShort = (n) => `${n}ªP`;
const when = (part, t) => `${partShort(part)} ${fmt(t)}`;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function whoText(X, e) {
  if (e.num != null) return `#${e.num} ${findPlayer(X, e.num)?.name || ''}`;
  return e.rival ? `Rival #${e.rival}` : 'Rival';
}

function describe(X, e) {
  const i = X.events.indexOf(e);
  switch (e.type) {
    case 'gol': {
      const [a, b] = score(X, i);
      const via = e.via !== 'juego' ? ` (${VIA[e.via]})` : '';
      return `Gol ${e.side === 'favor' ? 'a favor' : 'en contra'}${via} · ${whoText(X, e)} · ${a}-${b}`;
    }
    case 'falta':
      return e.side === 'nuestra' ? `Falta nuestra · ${whoText(X, e)}` : 'Falta rival';
    case 'bp':
      return `${VIA[e.kind]} ${e.side === 'favor' ? 'a favor' : 'en contra'} · ${whoText(X, e)} · ${e.scored ? 'Gol' : 'Fallado'}`;
    case 'sancion':
      return `${CARDS[e.card].label} ${e.side === 'nuestra' ? '' : 'rival '}· ${whoText(X, e)}${e.endAbs == null ? ' · activa' : ''}`;
  }
  return '';
}

// ---------- Interfaz principal ----------

function card(p) {
  const b = document.createElement('button');
  b.className = 'card' + (p.on ? ' on' : '');
  b.dataset.num = p.num;
  b.innerHTML = `
    <span class="num">${p.num}</span>
    <span class="name"></span>
    <span class="total">00:00</span>
    <span class="stint"></span>`;
  b.querySelector('.name').textContent = p.name;
  b.onclick = () => togglePlayer(p.num);
  return b;
}

function render() {
  const started = gameTotal() > 0 || S.events.length > 0;
  document.querySelectorAll('#modeSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === S.mode);
    b.disabled = started && b.dataset.mode !== S.mode;
  });

  $('btnPlay').textContent = S.running ? '❚❚' : '▶';
  $('btnPlay').classList.toggle('running', S.running);
  $('btnUndo').disabled = !undoStack.length;
  $('partLabel').textContent = partName(S, S.part);

  // Marcador
  const [us, them] = score(S);
  $('scoreUs').textContent = us;
  $('scoreThem').textContent = them;
  $('teamName').textContent = S.info.team || 'Nosotras';
  $('rivalName').textContent = S.info.rival || 'Rival';

  // Posesión y faltas
  document.querySelectorAll('[data-poss]').forEach((b) => b.classList.toggle('active', b.dataset.poss === S.poss));
  $('foulsUs').textContent = foulCount('nuestra');
  $('foulsThem').textContent = foulCount('rival');

  // Jugadoras
  const called = S.players.filter((p) => p.called);
  const on = called.filter((p) => p.on);
  $('onCourt').replaceChildren(...on.map(card));
  $('bench').replaceChildren(...called.filter((p) => !p.on).map(card));
  $('onEmpty').hidden = on.length > 0;
  const isMatch = S.mode === 'partido';
  $('onCount').textContent = isMatch ? `${on.length}/${MAX_ON_COURT}` : on.length;
  $('onCount').classList.toggle('over', isMatch && on.length > MAX_ON_COURT);
  $('btnSquad').hidden = S.squadOk;

  // Sanciones activas
  $('activeSanctions').replaceChildren(...activeSanctions().map((e) => {
    const c = document.createElement('button');
    c.className = `chip ${e.card}`;
    c.dataset.id = e.id;
    c.innerHTML = `<span class="lbl"></span> <b class="left"></b> ✕`;
    c.querySelector('.lbl').textContent =
      `${e.side === 'nuestra' ? 'Inferioridad' : 'Superioridad'} · ${whoText(S, e)}`;
    c.onclick = () => endSanctionManually(e.id);
    return c;
  }));

  if (currentTab === 'eventos') renderEvents();
  if (currentTab === 'resumen') renderSummary();
  if (currentTab === 'datos') renderDatos();
  if (currentTab === 'totales') renderTotals();
  tick();
}

// ---------- Convocatoria ----------

function openSquad() {
  const selected = new Set(S.players.filter((p) => p.called).map((p) => p.num));
  const limit = S.mode === 'partido' ? MAX_CALLED : PLAYERS.length;

  function draw() {
    $('squadCount').textContent = `${selected.size}/${limit}`;
    $('squadList').replaceChildren(...S.players.map((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      const sel = selected.has(p.num);
      b.className = 'pick-btn' + (sel ? ' active' : '');
      b.disabled = !sel && selected.size >= limit;
      b.innerHTML = `<b>${p.num}</b><span></span>`;
      b.querySelector('span').textContent = p.name;
      b.onclick = () => {
        sel ? selected.delete(p.num) : selected.add(p.num);
        draw();
      };
      return b;
    }));
    $('squadOk').disabled = selected.size === 0;
  }

  $('squadHint').textContent = S.mode === 'partido'
    ? `Elige las ${MAX_CALLED} jugadoras que van al acta del partido.`
    : 'Elige las jugadoras del entreno.';
  $('squadOk').onclick = () => {
    action(() => {
      commit();
      S.players.forEach((p) => {
        p.called = selected.has(p.num);
        if (!p.called) setOn(p, false);
      });
      S.squadOk = true;
    });
    $('dlgSquad').close();
  };
  draw();
  $('dlgSquad').showModal();
}

// ---------- Totales por jugadora (partidos terminados) ----------

function renderTotals() {
  const games = load(KEY_HISTORY, []).filter((r) => r.mode === 'partido');
  const rows = PLAYERS.map((pl) => {
    let conv = 0, played = 0, starter = 0, ms = 0, goals = 0;
    games.forEach((r) => {
      const p = findPlayer(r, pl.num);
      if (!p || !p.called) return;
      conv++;
      const t = sum(p.ms);
      if (t > 0) played++;
      if ((r.starters[0] || []).includes(pl.num)) starter++;
      ms += t;
      goals += r.events.filter((e) => e.type === 'gol' && e.side === 'favor' && e.num === pl.num).length;
    });
    return `<tr><td>${pl.num}</td><td>${escapeHtml(pl.name)}</td><td>${conv}</td><td><b>${played}</b></td>
      <td>${starter}</td><td>${fmtLong(ms)}</td><td>${played ? fmt(ms / played) : '—'}</td><td>${goals}</td></tr>`;
  });
  $('totals').innerHTML = `
    <p class="meta">Partidos terminados: <b>${games.length}</b> (los entrenos no cuentan)</p>
    <div class="tbl"><table>
      <thead><tr><th>Nº</th><th>Nombre</th><th>Convocada</th><th>Jugados</th><th>Titular</th>
      <th>Minutos</th><th>Media / partido</th><th>Goles</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table></div>`;
}

// Tiempo largo en h:mm:ss si pasa de una hora
function fmtLong(ms) {
  const s = Math.floor(ms / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)}:${fmt((s % 3600) * 1000)}` : fmt(ms);
}

// Actualiza solo los textos de tiempo (varias veces por segundo)
function tick() {
  const part = partNow();
  $('clock').textContent = fmt(part);

  const rem = $('remaining');
  if (S.partLen > 0) {
    const left = S.partLen * 60000 - part;
    rem.textContent = left >= 0 ? `Quedan ${fmt(left)}` : `Tiempo cumplido (+${fmt(-left)})`;
    rem.classList.toggle('over', left < 0);
  } else {
    rem.textContent = `Total ${fmt(gameTotal())}`;
    rem.classList.remove('over');
  }

  $('possUs').textContent = pct(possNow(0), part);
  $('possThem').textContent = pct(possNow(1), part);

  const total = gameTotal();
  document.querySelectorAll('#onCourt .card, #bench .card').forEach((el) => {
    const p = findPlayer(S, +el.dataset.num);
    el.querySelector('.total').textContent = fmt(playerTotal(p));
    const stint = Math.max(0, total - p.since);
    el.querySelector('.stint').textContent =
      total === 0 ? '' : p.on ? `En pista ${fmt(stint)}` : `Descansa ${fmt(stint)}`;
  });

  document.querySelectorAll('#activeSanctions .chip').forEach((el) => {
    const e = S.events.find((x) => x.id === el.dataset.id);
    if (e) el.querySelector('.left').textContent = fmt(e.abs + e.dur - total);
  });

  checkSanctions();
}

function pct(a, b) {
  return b > 0 ? `${Math.round((a * 100) / b)}%` : '—';
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- Pestañas ----------

function showTab(name) {
  currentTab = name;
  document.querySelectorAll('.tab').forEach((s) => (s.hidden = s.id !== `tab-${name}`));
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  window.scrollTo(0, 0);
  render();
}

function renderEvents() {
  const list = $('eventList');
  if (!S.events.length) {
    list.innerHTML = '<p class="hint">Aún no hay eventos. Usa los botones de la pestaña Pista.</p>';
    return;
  }
  list.replaceChildren(...[...S.events].reverse().map((e) => {
    const row = document.createElement('div');
    row.className = `ev ev-${e.type} ev-${e.side}`;
    const time = document.createElement('span');
    time.className = 'ev-time';
    time.textContent = when(e.part, e.t);
    const text = document.createElement('span');
    text.className = 'ev-text';
    text.textContent = describe(S, e);
    const del = document.createElement('button');
    del.className = 'ghost danger small';
    del.textContent = 'Borrar';
    del.onclick = () => deleteEvent(e.id);
    row.append(time, text, del);
    return row;
  }));
}

function renderSummary() {
  commit();
  save();
  $('summary').innerHTML = summaryHtml(S);
}

function renderDatos() {
  document.querySelectorAll('[data-info]').forEach((el) => {
    if (el !== document.activeElement) el.value = S.info[el.dataset.info] || '';
  });
  const called = S.players.filter((p) => p.called);
  $('calledList').textContent = called.length
    ? `${called.length}: ${called.map((p) => `${p.num} ${p.name}`).join(', ')}`
    : 'Sin convocadas';
}

// ---------- Resumen (equivalente a la hoja Excel) ----------

function summaryHtml(X) {
  const e = escapeHtml;
  const name = (num) => findPlayer(X, num)?.name || '';
  const nParts = X.partMs.length;
  const parts = [...Array(nParts).keys()];
  const total = sum(X.partMs);
  const sc = (i) => score(X, i).join('-');
  const nums = (arr) => (arr || []).map((n) => `${n} ${e(name(n))}`).join(', ') || '—';
  const fecha = X.info.fecha ? X.info.fecha.split('-').reverse().join('/') : '';
  const called = X.players.filter((p) => p.called);
  const table = (head, rows, empty = 'Sin datos') =>
    `<div class="tbl"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
      rows.length ? rows.join('') : `<tr><td colspan="${head.length}" class="empty">${empty}</td></tr>`
    }</tbody></table></div>`;
  const tr = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  const ev = (type) => X.events.filter((x) => x.type === type);

  // Datos
  let h = `<img class="sum-logo" src="crest.png" alt=""><h3>${e(X.info.team || 'Nosotras')} x ${e(X.info.rival || 'Rival')} — Resumen estadístico${
    X.mode === 'entreno' ? ' (entreno)' : X.info.numero ? ` · Partido oficial nº ${e(X.info.numero)}` : ''}</h3>
    <p class="meta">Competición: <b>${e(X.info.competicion) || '—'}</b> · Fecha: <b>${fecha || '—'}</b> ·
    Jornada: <b>${e(X.info.jornada) || '—'}</b> · Hora: <b>${e(X.info.hora) || '—'}</b> ·
    Resultado: <b>${score(X).join(' - ')}</b></p>`;

  h += `<p><b>Convocadas:</b> ${called.map((p) => `${p.num} ${e(p.name)}`).join(', ')}</p>`;
  h += parts.map((i) => `<p><b>Cinco inicial ${partShort(i + 1)}:</b> ${nums(X.starters[i])}</p>`).join('');

  // Tiempo de juego
  h += '<h4>Tiempo de juego</h4>';
  h += table(
    ['Nº', 'Nombre', ...parts.flatMap((i) => [`${partShort(i + 1)} E – S`, `TJ ${partShort(i + 1)}`]), 'Total', '%'],
    called.map((p) => tr([
      p.num, e(p.name),
      ...parts.flatMap((i) => [
        p.stints.filter((s) => s.part === i + 1)
          .map((s) => `${fmt(s.in)} – ${s.out == null ? '…' : fmt(s.out)}`).join('<br>') || '—',
        fmt(p.ms[i] || 0),
      ]),
      `<b>${fmt(sum(p.ms))}</b>`, pct(sum(p.ms), total),
    ])),
  );

  // Posesión
  h += '<h4>Tiempo de posesión</h4>';
  h += table(
    ['Parte', 'Tiempo jugado', 'Nosotras', '%', 'Rival', '%'],
    [
      ...parts.map((i) => tr([partShort(i + 1), fmt(X.partMs[i]), fmt(X.possMs[i][0]), pct(X.possMs[i][0], X.partMs[i]), fmt(X.possMs[i][1]), pct(X.possMs[i][1], X.partMs[i])])),
      tr(['<b>Total</b>', fmt(total), `<b>${fmt(sum(X.possMs.map((x) => x[0])))}</b>`, pct(sum(X.possMs.map((x) => x[0])), total), fmt(sum(X.possMs.map((x) => x[1]))), pct(sum(X.possMs.map((x) => x[1])), total)]),
    ],
  );

  // Marcador
  const goals = ev('gol');
  const goalRow = (g) => tr([
    g.side === 'favor' ? g.num : e(g.rival) || '—',
    g.side === 'favor' ? e(name(g.num)) : 'Rival',
    when(g.part, g.t), sc(X.events.indexOf(g)), VIA[g.via], nums(g.five),
  ]);
  h += '<h4>Marcador — goles a favor</h4>';
  h += table(['Nº', 'Nombre', 'Tiempo', 'Resultado', 'Tipo', 'Cinco en pista'], goals.filter((g) => g.side === 'favor').map(goalRow));
  h += '<h4>Marcador — goles en contra</h4>';
  h += table(['Nº', 'Nombre', 'Tiempo', 'Resultado', 'Tipo', 'Cinco en pista'], goals.filter((g) => g.side === 'contra').map(goalRow));

  // Bolas paradas
  const bps = ev('bp');
  h += '<h4>Balón parado</h4>';
  h += table(
    ['Nº', 'Nombre', 'Tiempo', 'Tipo', 'Para', 'Eficacia', 'Resultado'],
    bps.map((b) => tr([
      b.side === 'favor' ? b.num : e(b.rival) || '—',
      b.side === 'favor' ? e(name(b.num)) : 'Rival',
      when(b.part, b.t), VIA[b.kind], b.side === 'favor' ? 'A favor' : 'En contra',
      b.scored ? 'Gol' : 'Fallado',
      sc(b.scored ? X.events.findIndex((g) => g.bpId === b.id) : X.events.indexOf(b)),
    ])),
  );
  const bpStats = (kind, side) => {
    const list = bps.filter((b) => b.kind === kind && b.side === side);
    const g = list.filter((b) => b.scored).length;
    return { n: list.length, g, eff: side === 'favor' ? pct(g, list.length) : pct(list.length - g, list.length) };
  };
  const fdF = bpStats('fd', 'favor'), fdC = bpStats('fd', 'contra');
  const peF = bpStats('penalti', 'favor'), peC = bpStats('penalti', 'contra');
  h += table(['Resumen', ''], [
    tr(['Total faltas directas a favor', `${fdF.n} (${fdF.g} gol)`]),
    tr(['Eficacia ofensiva faltas directas a favor', fdF.eff]),
    tr(['Total faltas directas en contra', `${fdC.n} (${fdC.g} encajados)`]),
    tr(['Eficacia defensiva faltas directas en contra', fdC.eff]),
    tr(['Total penaltis a favor', `${peF.n} (${peF.g} gol)`]),
    tr(['Eficacia ofensiva penaltis a favor', peF.eff]),
    tr(['Total penaltis en contra', `${peC.n} (${peC.g} encajados)`]),
    tr(['Eficacia defensiva penaltis en contra', peC.eff]),
  ]);

  // Faltas de equipo
  const fouls = ev('falta');
  const ourFouls = fouls.filter((f) => f.side === 'nuestra');
  h += '<h4>Faltas de equipo</h4>';
  h += table(
    ['Nº', 'Nombre', ...parts.map((i) => partShort(i + 1)), 'Total'],
    called.filter((p) => ourFouls.some((f) => f.num === p.num)).map((p) => {
      const mine = ourFouls.filter((f) => f.num === p.num);
      return tr([p.num, e(p.name), ...parts.map((i) => mine.filter((f) => f.part === i + 1).length || '—'), `<b>${mine.length}</b>`]);
    }),
    'Sin faltas',
  );
  const countFouls = (side, part) => fouls.filter((f) => f.side === side && (part == null || f.part === part)).length;
  h += table(['Resumen', ...parts.map((i) => partShort(i + 1)), 'Total'], [
    tr(['FE cometidas', ...parts.map((i) => countFouls('nuestra', i + 1)), `<b>${countFouls('nuestra')}</b>`]),
    tr(['FE sufridas', ...parts.map((i) => countFouls('rival', i + 1)), `<b>${countFouls('rival')}</b>`]),
  ]);

  // Sanciones propias
  const sanc = ev('sancion');
  const endText = (s) => (s.endAbs == null ? 'activa' : when(s.endPart, s.endT));
  h += `<h4>Sanciones ${e(X.info.team || 'propias')}</h4>`;
  h += table(
    ['Nº', 'Nombre', 'Sanción', 'T salida', 'T entrada'],
    sanc.filter((s) => s.side === 'nuestra').map((s) => tr([s.num, e(name(s.num)), CARDS[s.card].label, when(s.part, s.t), endText(s)])),
    'Sin sanciones',
  );

  // Superioridad / inferioridad
  const ppRow = (s) => {
    const end = s.scoreEnd || score(X);
    const gf = end[0] - s.scoreStart[0], gc = end[1] - s.scoreStart[1];
    return tr([`${when(s.part, s.t)} → ${endText(s)}`, s.scoreStart.join('-'), nums(s.five), end.join('-'), `+${gf} / −${gc}`, whoText(X, s)]);
  };
  h += '<h4>Superioridad (power play)</h4>';
  h += table(['Tiempo', 'Res. inicial', 'Jugadoras en pista', 'Res. final', 'Goles', 'Sancionada'], sanc.filter((s) => s.side === 'rival').map(ppRow), 'Sin superioridades');
  h += '<h4>Inferioridad (under play)</h4>';
  h += table(['Tiempo', 'Res. inicial', 'Jugadoras en pista', 'Res. final', 'Goles', 'Sancionada'], sanc.filter((s) => s.side === 'nuestra').map(ppRow), 'Sin inferioridades');

  // Observaciones
  h += `<h4>Observaciones</h4><p class="notes">${e(X.info.notas) || '—'}</p>`;
  return `<div class="sum">${h}</div>`;
}

// ---------- Exportar / imprimir ----------

function exportCsv(X) {
  const sec = (ms) => Math.round(ms / 1000);
  const parts = X.partMs.map((_, i) => i);
  const head = ['Numero', 'Jugadora', ...parts.map((i) => `Parte ${i + 1} (s)`), 'Total (s)', 'Total (mm:ss)'];
  const lines = [head.join(';')];
  X.players.filter((p) => p.called).forEach((p) => {
    lines.push([p.num, p.name, ...parts.map((i) => sec(p.ms[i] || 0)), sec(sum(p.ms)), fmt(sum(p.ms))].join(';'));
  });
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const rival = X.info.rival ? '_' + X.info.rival.replace(/[^\w-]+/g, '-') : '';
  a.download = `minutos_${X.info.fecha || today()}_${X.mode}${rival}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function printSummary(X) {
  $('printArea').innerHTML = summaryHtml(X);
  document.body.classList.add('print-mode');
  const cleanup = () => document.body.classList.remove('print-mode');
  window.addEventListener('afterprint', cleanup, { once: true });
  window.print();
  setTimeout(cleanup, 1000);
}

// ---------- Historial ----------

let currentRecord = null;

function showRecord(rec) {
  currentRecord = rec;
  $('resBody').innerHTML = summaryHtml(rec);
  $('dlgResults').showModal();
}

function recordTitle(rec) {
  return rec.mode === 'partido' ? `${rec.info.team || 'Nosotras'} x ${rec.info.rival || 'Rival'}` : 'Entreno';
}

function showHistory() {
  const history = load(KEY_HISTORY, []);
  const list = $('histList');
  if (!history.length) {
    list.innerHTML = '<p class="hint">Todavía no hay sesiones guardadas.</p>';
  } else {
    list.replaceChildren(...history.map((rec) => {
      const row = document.createElement('div');
      row.className = 'hist-item';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'open';
      const fecha = (rec.info.fecha || '').split('-').reverse().join('/');
      open.innerHTML = '<b></b><small></small>';
      open.querySelector('b').textContent = `${recordTitle(rec)}  ${score(rec).join('-')}`;
      open.querySelector('small').textContent = `${fecha} · ${rec.info.competicion || ''} · ${fmt(sum(rec.partMs))}`;
      open.onclick = () => { $('dlgHistory').close(); showRecord(rec); };
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'ghost danger small';
      del.textContent = 'Borrar';
      del.onclick = () => {
        if (!confirm('¿Borrar esta sesión del historial?')) return;
        store(KEY_HISTORY, load(KEY_HISTORY, []).filter((x) => x.id !== rec.id));
        showHistory();
      };
      row.append(open, del);
      return row;
    }));
  }
  const last = load(KEY_BACKUP, null);
  $('lastBackup').textContent = last
    ? `Última copia: ${new Date(last).toLocaleDateString('es-ES')}.`
    : 'Todavía no se ha hecho ninguna copia.';
  if (!$('dlgHistory').open) $('dlgHistory').showModal();
}

// ---------- Copia de seguridad ----------

const KEY_BACKUP = 'hoquei.lastBackup';

async function exportBackup() {
  commit();
  save();
  const data = {
    app: 'hoquei',
    version: VERSION,
    exportedAt: new Date().toISOString(),
    history: load(KEY_HISTORY, []),
    session: S,
  };
  const name = `telecable-copia-${today()}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });

  // En móvil/tablet se abre el menú Compartir (Archivos, Drive, WhatsApp, correo…)
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
    } catch (err) {
      if (err.name === 'AbortError') return; // cancelado: no cuenta como copia
      downloadFile(file);
    }
  } else {
    downloadFile(file);
  }
  store(KEY_BACKUP, Date.now());
  showHistory();
  toast(`Copia exportada (${data.history.length} sesiones)`);
}

function downloadFile(file) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Añade al historial las sesiones de la copia que no estén ya (no borra nada)
async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    alert('Este archivo no es una copia válida.');
    return;
  }
  if (!data || data.app !== 'hoquei' || !Array.isArray(data.history)) {
    alert('Este archivo no es una copia de esta app.');
    return;
  }
  const history = load(KEY_HISTORY, []);
  const ids = new Set(history.map((r) => r.id));
  const nuevos = data.history.filter((r) => r && r.id && !ids.has(r.id));
  if (nuevos.length) {
    history.push(...nuevos);
    history.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
    store(KEY_HISTORY, history);
  }

  // Partido en curso: solo si en este dispositivo no hay nada empezado
  let session = false;
  const backupSession = data.session;
  const hasData = (x) => x && x.version === VERSION && (sum(x.partMs) > 0 || x.running || x.events.length > 0);
  const empty = !hasData(S);
  if (hasData(backupSession) && empty &&
      confirm('La copia tiene un partido sin terminar. ¿Recuperarlo también?')) {
    S = backupSession;
    undoStack = [];
    save();
    session = true;
  }

  render();
  showHistory();
  const skipped = data.history.length - nuevos.length;
  alert(`Copia importada: ${nuevos.length} sesiones añadidas` +
    (skipped ? `, ${skipped} ya estaban` : '') +
    (session ? ' y partido en curso recuperado.' : '.'));
}

// ---------- Ajustes ----------

// Comprueba si la copia para usar sin internet está guardada en este dispositivo
async function checkOffline() {
  const el = $('offlineStatus');
  let cache = null, files = 0;
  try {
    const keys = await caches.keys();
    cache = keys.find((k) => k.startsWith('hoquei-')) || null;
    if (cache) files = (await (await caches.open(cache)).keys()).length;
  } catch {}
  const sw = 'serviceWorker' in navigator && !!navigator.serviceWorker.controller;
  const ok = sw && files >= 10;
  el.className = 'hint ' + (ok ? 'ok' : 'bad');
  el.textContent = ok
    ? `✓ Lista para usar sin internet (${cache}). Dirección: ${location.host}`
    : `✗ Todavía NO está lista para usar sin internet (${sw ? 'archivos: ' + files + '/10' : 'sin service worker'}). ` +
      `Dirección: ${location.host}. Ábrela con internet, espera unos segundos, ciérrala y vuelve a abrirla.`;
}

function openSettings() {
  checkOffline();
  $('partLen').value = S.partLen;
  $('partsNum').value = S.parts;
  $('dlgSettings').showModal();
}

$('partLen').onchange = (ev) => { S.partLen = Math.max(0, +ev.target.value || 0); save(); tick(); };
$('partsNum').onchange = (ev) => { S.parts = Math.max(1, +ev.target.value || 1); save(); render(); };
$('btnReset').onclick = () => {
  if (!confirm('¿Reiniciar la sesión? Se perderán los datos actuales (no se guardan en el historial).')) return;
  action(() => { S = newSession(S.mode, S); });
  $('dlgSettings').close();
  updateWakeLock();
};

// ---------- Pantalla siempre encendida ----------

let wakeLock = null;
async function updateWakeLock() {
  try {
    if (S.running && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!S.running && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
}
document.addEventListener('visibilitychange', updateWakeLock);

// ---------- Eventos de la interfaz ----------

$('btnPlay').onclick = togglePlay;
$('btnUndo').onclick = undo;
$('btnNextPart').onclick = nextPart;
$('btnFinish').onclick = finish;
$('btnSettings').onclick = openSettings;
$('btnHistory').onclick = showHistory;
$('btnSquad').onclick = openSquad;
$('btnExport').onclick = exportBackup;
$('btnImport').onclick = () => $('importFile').click();
$('importFile').onchange = (ev) => {
  const f = ev.target.files[0];
  ev.target.value = '';
  if (f) importBackup(f);
};
$('btnSquad2').onclick = openSquad;
$('btnPrint').onclick = () => { commit(); save(); printSummary(S); };
$('btnCsv').onclick = () => { commit(); save(); exportCsv(S); };
$('resPrint').onclick = () => currentRecord && printSummary(currentRecord);
$('resCsv').onclick = () => currentRecord && exportCsv(currentRecord);

document.querySelectorAll('#modeSeg button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
document.querySelectorAll('[data-poss]').forEach((b) => (b.onclick = () => setPossession(b.dataset.poss)));
document.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => ACTIONS[b.dataset.act]()));
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
document.querySelectorAll('[data-info]').forEach((el) => {
  el.oninput = () => {
    S.info[el.dataset.info] = el.value;
    save();
    $('teamName').textContent = S.info.team || 'Nosotras';
    $('rivalName').textContent = S.info.rival || 'Rival';
  };
});

// Teclado (Windows): espacio = reloj
document.addEventListener('keydown', (ev) => {
  if (ev.code === 'Space' && !/INPUT|TEXTAREA/.test(ev.target.tagName) && !document.querySelector('dialog[open]')) {
    ev.preventDefault();
    togglePlay();
  }
});

setInterval(tick, 250);
render();
updateWakeLock();
// Al empezar un partido nuevo, lo primero es elegir las convocadas
if (!S.squadOk && gameTotal() === 0 && !S.events.length) openSquad();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js');
}
