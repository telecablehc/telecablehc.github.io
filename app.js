// AppHóquei — estadística de partido (basada en la hoja "Folha_Estatistica")
// Todos los datos se guardan solo en este dispositivo (localStorage).
'use strict';

// Orden de la plantilla en toda la app: primero 21 y 23, luego por número
const PLAYERS = [
  { num: 21, name: 'Viki' },
  { num: 23, name: 'Aine' },
  { num: 6, name: 'Piki' },
  { num: 8, name: 'Judith' },
  { num: 9, name: 'Nuri' },
  { num: 17, name: 'Mariona' },
  { num: 18, name: 'Candela' },
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
      pabellon: '',
      fixtureId: null, // jornada del calendario (calendar.js), si la hay
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
const save = () => { store(KEY_SESSION, S); cloudSessionChanged(); };

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

// Ordena las jugadoras como en PLAYERS (las que ya no están en la plantilla, al final)
function rosterOrder(players) {
  const pos = (num) => { const i = PLAYERS.findIndex((p) => p.num === num); return i < 0 ? 999 + num : i; };
  return [...players].sort((a, b) => pos(a.num) - pos(b.num));
}
S.players = rosterOrder(S.players);
save();

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
  const msg = S.reopenedFrom
    ? '¿Guardar los cambios? Sustituirán a los datos anteriores de este partido.'
    : '¿Terminar y guardar la sesión en el historial?';
  if (!confirm(msg)) return;
  commit();
  S.running = false;
  const end = S.partMs[S.part - 1];
  S.players.forEach((p) => { if (p.on) closeStint(p, end); });
  activeSanctions().forEach((e) => endSanction(e, Math.min(e.abs + e.dur, gameTotal())));

  const record = JSON.parse(JSON.stringify(S));
  const history = load(KEY_HISTORY, []);
  const i = S.reopenedFrom ? history.findIndex((r) => r.id === S.reopenedFrom) : -1;
  delete record.reopenedFrom;
  delete record.reopenedSavedAt;
  if (i >= 0) {
    // partido reabierto: sustituye al original (mismo id y misma posición)
    record.id = S.reopenedFrom;
    record.savedAt = S.reopenedSavedAt || history[i].savedAt;
    record.editedAt = new Date().toISOString();
    history[i] = record;
  } else {
    record.id = S.reopenedFrom || uid();
    record.savedAt = S.reopenedSavedAt || new Date().toISOString();
    history.unshift(record);
  }
  store(KEY_HISTORY, history);
  cloudMarkDirty(record.id);

  S = newSession(S.mode, S);
  undoStack = [];
  save();
  render();
  updateWakeLock();
  showRecord(record);
  // al cerrar el resumen se vuelve al menú de la sección (salvo que se reabra)
  resultsReturn = sectionOf(record.mode);
}

let resultsReturn = null;

function undo() {
  if (!undoStack.length) return;
  S = JSON.parse(undoStack.pop());
  save();
  render();
  updateWakeLock();
  toast('Deshecho');
}

const isStarted = (X = S) => sum(X.partMs) > 0 || X.running || X.events.length > 0;

// Empieza (o continúa) un partido o un entreno y abre la pantalla de juego.
// fixture: jornada del calendario; rellena rival, fecha, hora, jornada…
function startSession(mode, fixture = null) {
  const fixtureId = fixture ? fixture.id : null;
  const sameGame = S.mode === mode && (S.info.fixtureId || null) === fixtureId;
  if (isStarted() && !sameGame) return; // hay otra sesión en curso: el menú no lo permite
  if (!sameGame) {
    S = newSession(mode, S);
    undoStack = [];
    if (fixture) {
      Object.assign(S.info, {
        fixtureId: fixture.id,
        rival: fixture.rival,
        competicion: `${COMPETICION} ${TEMPORADA}`,
        jornada: String(fixture.jornada),
        fecha: fixture.fecha || today(),
        hora: fixture.hora,
        pabellon: fixture.pabellon,
      });
    }
    save();
  }
  go('juego');
  if (!S.squadOk && !isStarted()) openSquad();
}

// ---------- Calendario (calendar.js) ----------

// Datos guardados de una jornada: por su id o, en partidos antiguos, por la fecha
function recordForFixture(f, history) {
  return history.find((r) => r.mode === 'partido' && r.info.fixtureId === f.id) ||
    (f.fecha && history.find((r) => r.mode === 'partido' && !r.info.fixtureId && r.info.fecha === f.fecha)) ||
    null;
}

function nextFixture(history) {
  const pending = CALENDARIO.filter((f) => !recordForFixture(f, history));
  return pending.find((f) => f.fecha && f.fecha >= today()) || pending.find((f) => !f.fecha) || null;
}

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
function fixtureWhen(f) {
  if (!f.fecha) return 'Fecha por confirmar';
  const d = new Date(f.fecha + 'T12:00:00');
  return `${DIAS[d.getDay()]} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}${f.hora ? ' · ' + f.hora : ''}`;
}
const fixtureTitle = (f) => `${f.local ? 'vs' : 'en'} ${f.rival}`;
const venueIcon = (f) => (f.local ? '🏠' : '✈️'); // en casa / fuera

// ¿Esta jornada es el partido en curso? (nuevo o reabierto para corregir)
function isLiveFixture(f, rec) {
  if (!isStarted() || S.mode !== 'partido') return false;
  return S.info.fixtureId === f.id || (!!rec && S.reopenedFrom === rec.id);
}

function openFixture(f) {
  const history = load(KEY_HISTORY, []);
  const rec = recordForFixture(f, history);
  if (isLiveFixture(f, rec)) return go('juego');
  if (rec) return showRecord(rec);
  if (isStarted()) {
    alert(`Hay un ${S.mode === 'partido' ? 'partido' : 'entreno'} en curso. Termínalo antes de empezar otro partido.`);
    return;
  }
  if (!confirm(`¿Registrar la jornada ${f.jornada}: ${f.local ? 'Telecable HC – ' + f.rival : f.rival + ' – Telecable HC'}?`)) return;
  startSession('partido', f);
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
    // los campos de texto ('num') son opcionales salvo que lleven required: true
    const complete = () => visible().every((f) =>
      f.type === 'num' ? !f.required || !!vals[f.key] : vals[f.key] != null);
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
          input.oninput = () => {
            vals[f.key] = input.value.trim();
            $('askOk').disabled = !complete();
          };
          if (f.placeholder) input.placeholder = f.placeholder;
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
  renderHeader();
  if (route === 'inicio') renderHome();
  if (route === 'partidos' || route === 'entrenos') renderMenu();
  if (route === 'totales') renderTotals();

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
  $('reopenBanner').hidden = !S.reopenedFrom;

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

// ---------- Totales de todos los partidos terminados ----------
// Se recalcula cada vez que se abre la pestaña, así que incluye
// automáticamente cada partido nuevo que se termina y guarda.

function renderTotals() {
  const games = load(KEY_HISTORY, []).filter((r) => r.mode === 'partido');
  const e = escapeHtml;
  const n = games.length;
  const avg = (x) => (n ? (x / n).toFixed(1).replace('.', ',') : '—');
  const tr = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  const table = (head, rows) =>
    `<div class="tbl"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;

  if (!n) {
    $('totals').innerHTML = '<p class="hint">Todavía no hay partidos terminados. Al pulsar «Terminar» en un partido, sus datos se suman aquí.</p>';
    return;
  }

  // --- Equipo ---
  const T = {
    w: 0, d: 0, l: 0, gf: 0, gc: 0, playMs: 0, possUs: 0, possThem: 0, feC: 0, feS: 0,
    bp: { fd: { favor: [0, 0], contra: [0, 0] }, penalti: { favor: [0, 0], contra: [0, 0] } }, // [lanzados, goles]
    azul: 0, roja: 0, pp: [0, 0, 0], up: [0, 0, 0], // [veces, goles a favor, goles en contra]
  };
  games.forEach((r) => {
    const [us, them] = score(r);
    T.gf += us; T.gc += them;
    us > them ? T.w++ : us === them ? T.d++ : T.l++;
    T.playMs += sum(r.partMs);
    T.possUs += sum(r.possMs.map((x) => x[0]));
    T.possThem += sum(r.possMs.map((x) => x[1]));
    r.events.forEach((ev) => {
      if (ev.type === 'falta') ev.side === 'nuestra' ? T.feC++ : T.feS++;
      if (ev.type === 'bp') { const b = T.bp[ev.kind][ev.side]; b[0]++; if (ev.scored) b[1]++; }
      if (ev.type === 'sancion') {
        if (ev.side === 'nuestra') T[ev.card]++;
        const end = ev.scoreEnd || score(r);
        const acc = ev.side === 'rival' ? T.pp : T.up;
        acc[0]++; acc[1] += end[0] - ev.scoreStart[0]; acc[2] += end[1] - ev.scoreStart[1];
      }
    });
  });
  const eff = ([shots, goals], side) => (shots ? pct(side === 'favor' ? goals : shots - goals, shots) : '—');
  const bpRow = (label, kind) => {
    const f = T.bp[kind].favor, c = T.bp[kind].contra;
    return tr([label, `${f[0]} (${f[1]} gol)`, eff(f, 'favor'), `${c[0]} (${c[1]} encajados)`, eff(c, 'contra')]);
  };

  let h = `<p class="meta">Suma de los <b>${n}</b> partidos terminados (los entrenos no cuentan).</p>
    <div class="tiles">
      <div class="tile"><span>Partidos</span><b>${n}</b></div>
      <div class="tile"><span>Ganados · Empatados · Perdidos</span><b>${T.w} · ${T.d} · ${T.l}</b></div>
      <div class="tile"><span>Goles a favor</span><b>${T.gf}</b><small>${avg(T.gf)} por partido</small></div>
      <div class="tile"><span>Goles en contra</span><b>${T.gc}</b><small>${avg(T.gc)} por partido</small></div>
      <div class="tile"><span>Diferencia</span><b>${T.gf - T.gc > 0 ? '+' : ''}${T.gf - T.gc}</b></div>
      <div class="tile"><span>Posesión media</span><b>${pct(T.possUs, T.playMs)}</b><small>Rival ${pct(T.possThem, T.playMs)}</small></div>
    </div>`;

  h += '<h4>Equipo</h4>';
  h += table(['', 'Total', 'Media / partido'], [
    tr(['Faltas de equipo cometidas', T.feC, avg(T.feC)]),
    tr(['Faltas de equipo sufridas', T.feS, avg(T.feS)]),
    tr(['Tarjetas azules', T.azul, avg(T.azul)]),
    tr(['Tarjetas rojas', T.roja, avg(T.roja)]),
    tr(['Superioridades (power play)', `${T.pp[0]} · goles +${T.pp[1]} / −${T.pp[2]}`, avg(T.pp[0])]),
    tr(['Inferioridades (under play)', `${T.up[0]} · goles +${T.up[1]} / −${T.up[2]}`, avg(T.up[0])]),
  ]);
  h += table(['Balón parado', 'A favor', 'Eficacia ofensiva', 'En contra', 'Eficacia defensiva'], [
    bpRow('Faltas directas', 'fd'),
    bpRow('Penaltis', 'penalti'),
  ]);

  // --- Jugadoras ---
  const rows = PLAYERS.map((pl) => {
    const P = { conv: 0, played: 0, starter: 0, ms: 0, goals: 0, fouls: 0, azul: 0, roja: 0, bpShots: 0, bpGoals: 0 };
    games.forEach((r) => {
      const p = findPlayer(r, pl.num);
      if (!p || !p.called) return;
      P.conv++;
      const t = sum(p.ms);
      if (t > 0) P.played++;
      if ((r.starters[0] || []).includes(pl.num)) P.starter++;
      P.ms += t;
      r.events.forEach((ev) => {
        if (ev.num !== pl.num) return;
        if (ev.type === 'gol' && ev.side === 'favor') P.goals++;
        if (ev.type === 'falta' && ev.side === 'nuestra') P.fouls++;
        if (ev.type === 'sancion' && ev.side === 'nuestra') P[ev.card]++;
        if (ev.type === 'bp' && ev.side === 'favor') { P.bpShots++; if (ev.scored) P.bpGoals++; }
      });
    });
    return tr([
      pl.num, e(pl.name), P.conv, `<b>${P.played}</b>`, P.starter,
      fmtLong(P.ms), P.played ? fmt(P.ms / P.played) : '—', pct(P.ms, T.playMs),
      `<b>${P.goals}</b>`, P.fouls, P.azul, P.roja, P.bpShots ? `${P.bpGoals}/${P.bpShots}` : '—',
    ]);
  });
  h += '<h4>Jugadoras</h4>';
  h += table(['Nº', 'Nombre', 'Convocada', 'Jugados', 'Titular', 'Minutos', 'Media / partido', '% del tiempo',
    'Goles', 'Faltas', 'Azules', 'Rojas', 'FD + penaltis (gol/lanz.)'], rows);

  // --- Lista de partidos ---
  h += '<h4>Partidos</h4>';
  h += table(['Fecha', 'Rival', 'Competición', 'Resultado', ''], games.map((r) => {
    const [us, them] = score(r);
    const res = us > them ? 'G' : us === them ? 'E' : 'P';
    return tr([
      (r.info.fecha || '').split('-').reverse().join('/'), e(r.info.rival) || '—', e(r.info.competicion) || '—',
      `<b>${us}-${them}</b> <span class="res res-${res}">${res}</span>`,
      `<button class="ghost small" data-open="${e(r.id)}">Ver</button>`,
    ]);
  }));

  $('totals').innerHTML = h;
  $('totals').querySelectorAll('[data-open]').forEach((b) => {
    b.onclick = () => showRecord(games.find((r) => r.id === b.dataset.open));
  });
}

// Tiempo largo en h:mm:ss si pasa de una hora
function fmtLong(ms) {
  const s = Math.floor(ms / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)}:${fmt((s % 3600) * 1000)}` : fmt(ms);
}

// Actualiza solo los textos de tiempo (varias veces por segundo)
function tick() {
  if (route === 'inicio') renderHome();
  if ((route === 'partidos' || route === 'entrenos') && isStarted() && S.mode === modeOf(route)) {
    const sub = document.querySelector('#menuMain .menu-btn-sub');
    if (sub) sub.textContent = sessionStatus();
  }
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

// ---------- Pantallas (índice → sección → juego) ----------
// La pantalla va en la dirección (#partidos, #juego…), así el botón
// «atrás» del móvil funciona.

const ROUTES = ['inicio', 'partidos', 'entrenos', 'juego', 'totales'];
let route = 'inicio';
const routeStack = [];
const sectionOf = (mode) => (mode === 'entreno' ? 'entrenos' : 'partidos');
const modeOf = (section) => (section === 'entrenos' ? 'entreno' : 'partido');

function parentRoute(r) {
  if (r === 'juego') return sectionOf(S.mode);
  if (r === 'totales') return 'partidos';
  return 'inicio';
}

function go(r) {
  if (location.hash === '#' + r) applyRoute();
  else location.hash = r;
}

function goBack() {
  // si venimos de la pantalla anterior dentro de la app, se usa el historial del navegador
  if (routeStack.length > 1 && routeStack[routeStack.length - 2] === parentRoute(route)) history.back();
  else location.replace('#' + parentRoute(route));
}

function applyRoute() {
  const h = location.hash.slice(1);
  route = ROUTES.includes(h) ? h : 'inicio';
  if (routeStack[routeStack.length - 2] === route) routeStack.pop();
  else if (routeStack[routeStack.length - 1] !== route) routeStack.push(route);

  const screen = route === 'partidos' || route === 'entrenos' ? 'menu' : route;
  document.querySelectorAll('.screen').forEach((s) => (s.hidden = s.id !== `screen-${screen}`));
  document.body.classList.toggle('in-game', route === 'juego');
  document.querySelectorAll('dialog[open]').forEach((d) => d.id !== 'dlgResults' && d.close());
  window.scrollTo(0, 0);
  render();
  startupChecks();
}

function renderHeader() {
  const titles = {
    inicio: S.info.team || 'Telecable HC',
    partidos: 'Partidos',
    entrenos: 'Entrenos',
    totales: 'Totales',
    juego: S.mode === 'partido' ? `Partido${S.info.rival ? ' vs ' + S.info.rival : ''}` : 'Entreno',
  };
  $('screenTitle').textContent = titles[route];
  $('btnBack').hidden = route === 'inicio';
  $('btnUndo').hidden = route !== 'juego';
}

// Texto corto del estado de la sesión en curso ("2-1 · 2ª parte 12:30 · en juego")
function sessionStatus() {
  const [us, them] = score(S);
  const parts = [];
  if (S.mode === 'partido') parts.push(`${S.info.rival ? 'vs ' + S.info.rival + ' · ' : ''}${us}-${them}`);
  parts.push(`${partName(S, S.part)} ${fmt(partNow())}`);
  parts.push(S.running ? 'en juego' : 'en pausa');
  return parts.join(' · ');
}

function renderHome() {
  const started = isStarted();
  let next = null;
  if (!(started && S.mode === 'partido')) {
    if (!renderHome.cacheAt || renderHome.cacheAt < Date.now() - 5000) {
      renderHome.cache = nextFixture(load(KEY_HISTORY, [])); // no leer el historial 4 veces por segundo
      renderHome.cacheAt = Date.now();
    }
    next = renderHome.cache;
  }
  $('homeSubPartidos').textContent = started && S.mode === 'partido'
    ? `En curso: ${sessionStatus()}`
    : next ? `Próximo: J${next.jornada} · ${fixtureWhen(next)} · ${venueIcon(next)} ${fixtureTitle(next)}` : '';
  $('homeSubEntrenos').textContent = started && S.mode === 'entreno' ? `En curso: ${sessionStatus()}` : '';
}

function renderMenu() {
  const mode = modeOf(route);
  const word = mode === 'partido' ? 'partido' : 'entreno';
  const other = mode === 'partido' ? 'entreno' : 'partido';
  const started = isStarted();
  const box = $('menuMain');
  box.replaceChildren();

  const btn = document.createElement('button');
  btn.className = 'menu-btn primary-card';
  const title = document.createElement('span');
  title.className = 'menu-btn-title';
  const sub = document.createElement('span');
  sub.className = 'menu-btn-sub';
  btn.append(title, sub);

  const history = load(KEY_HISTORY, []);
  const next = mode === 'partido' ? nextFixture(history) : null;
  if (started && S.mode === mode) {
    title.textContent = `Continuar ${word}`;
    sub.textContent = sessionStatus();
    btn.onclick = () => go('juego');
  } else if (started && S.mode !== mode) {
    title.textContent = `Hay un ${other} en curso`;
    sub.textContent = `Termínalo antes de empezar un ${word}. Toca para ir al ${other}.`;
    btn.classList.add('busy');
    btn.onclick = () => go('juego');
  } else if (next) {
    title.textContent = `Próximo partido · J${next.jornada}`;
    sub.textContent = `${fixtureWhen(next)} · ${venueIcon(next)} ${fixtureTitle(next)}`;
    btn.onclick = () => openFixture(next);
  } else {
    title.textContent = `Nuevo ${word}`;
    sub.textContent = mode === 'partido' ? 'Elegir convocadas y empezar' : 'Empezar a contar minutos';
    btn.onclick = () => startSession(mode);
  }
  box.append(btn);

  const isMatch = mode === 'partido';
  $('menuTotals').hidden = !isMatch;
  $('menuCalBox').hidden = !isMatch;
  $('menuOther').hidden = !isMatch;
  if (isMatch) {
    $('menuCalTitle').textContent = `Calendario · ${COMPETICION} ${TEMPORADA}`;
    renderCalendar(history);
    // en "Otros partidos" solo los que no son de ninguna jornada del calendario
    const linked = new Set(CALENDARIO.map((f) => recordForFixture(f, history)).filter(Boolean).map((r) => r.id));
    $('menuHistTitle').textContent = 'Otros partidos (amistosos, copa…)';
    renderHistory(mode, $('menuHist'), (r) => !linked.has(r.id));
  } else {
    $('menuHistTitle').textContent = 'Entrenos';
    renderHistory(mode, $('menuHist'));
  }
}

// Un botón por jornada, con su estado
function renderCalendar(history) {
  const list = $('menuCal');
  list.replaceChildren(...CALENDARIO.map((f) => {
    const rec = recordForFixture(f, history);
    const live = isLiveFixture(f, rec);
    // color por resultado: el registrado en la app o, si no hay, el oficial de la RFEP
    const goals = rec ? score(rec) : f.resultado ? f.resultado.split('-').map(Number) : null;
    const outcome = live || !goals ? '' : goals[0] > goals[1] ? ' win' : goals[0] === goals[1] ? ' draw' : ' loss';
    const b = document.createElement('button');
    b.className = 'fixture' + (live ? ' live' : rec ? ' done' : '') + outcome;
    b.innerHTML = `
      <span class="fx-j">J${f.jornada}</span>
      <span class="fx-main"><b></b><small></small></span>
      <span class="fx-state"></span>`;
    b.querySelector('b').textContent = fixtureTitle(f);
    b.querySelector('small').textContent = `${fixtureWhen(f)} · ${venueIcon(f)}`;
    b.querySelector('small').title = f.local ? 'En casa' : 'Fuera';
    let state = '';
    if (live) state = `● ${score(S).join('-')}`;
    else if (rec) state = `✓ ${score(rec).join('-')}`;
    else if (f.resultado) state = `${f.resultado} · sin datos`;
    b.querySelector('.fx-state').textContent = state;
    b.title = live ? 'Partido en curso' : rec ? 'Ver los datos de este partido' : 'Registrar este partido';
    b.onclick = () => openFixture(f);
    return b;
  }));
}

// ---------- Pestañas de la pantalla de juego ----------

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
  const called = rosterOrder(X.players.filter((p) => p.called));
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
    ${X.info.pabellon ? `Pabellón: <b>${e(X.info.pabellon)}</b> ·` : ''}
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
  if (!$('dlgResults').open) $('dlgResults').showModal();
}

// ---------- Corregir partidos terminados ----------

// 1) Editar datos: info, observaciones y convocatoria (no toca las estadísticas)
function editRecord(rec) {
  const dlg = $('dlgEditRec');
  dlg.querySelectorAll('[data-rec]').forEach((el) => (el.value = rec.info[el.dataset.rec] || ''));
  const called = new Set(rec.players.filter((p) => p.called).map((p) => p.num));
  const played = new Set(rec.players.filter((p) => sum(p.ms) > 0).map((p) => p.num));
  const limit = rec.mode === 'partido' ? MAX_CALLED : rec.players.length;
  const draw = () => {
    $('recSquad').replaceChildren(...rosterOrder(rec.players).map((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      const sel = called.has(p.num);
      b.className = 'pick-btn' + (sel ? ' active' : '');
      b.disabled = (sel && played.has(p.num)) || (!sel && called.size >= limit);
      b.innerHTML = `<b>${p.num}</b><span></span>`;
      b.querySelector('span').textContent = p.name;
      b.onclick = () => { sel ? called.delete(p.num) : called.add(p.num); draw(); };
      return b;
    }));
  };
  draw();
  $('recCancel').onclick = () => dlg.close();
  $('recSave').onclick = () => {
    const history = load(KEY_HISTORY, []);
    const r = history.find((x) => x.id === rec.id);
    if (!r) return dlg.close();
    dlg.querySelectorAll('[data-rec]').forEach((el) => (r.info[el.dataset.rec] = el.value));
    r.players.forEach((p) => (p.called = called.has(p.num)));
    r.editedAt = new Date().toISOString();
    store(KEY_HISTORY, history);
    cloudMarkDirty(r.id);
    dlg.close();
    showRecord(r); // refresca el resumen abierto
    render();
    toast('Datos guardados');
  };
  dlg.showModal();
}

// 2) Reabrir: el partido vuelve a estar "en curso" para corregir eventos
function reopenRecord(rec) {
  if (isStarted()) {
    alert(`Hay un ${S.mode === 'partido' ? 'partido' : 'entreno'} en curso. Termínalo antes de reabrir otro.`);
    return;
  }
  if (!confirm('¿Reabrir para corregir? Los datos guardados no cambian hasta que pulses «Terminar» de nuevo.')) return;
  const copy = JSON.parse(JSON.stringify(rec));
  copy.reopenedFrom = rec.id;
  copy.reopenedSavedAt = rec.savedAt;
  delete copy.id;
  delete copy.savedAt;
  delete copy.editedAt;
  copy.running = false;
  copy.poss = null;
  S = copy;
  undoStack = [];
  save();
  resultsReturn = null; // no volver al menú al cerrar el resumen
  $('dlgResults').close();
  go('juego');
  showTab('eventos');
  toast('Partido reabierto: corrige y pulsa «Terminar»');
}

function discardReopen() {
  if (!confirm('¿Descartar los cambios? El partido queda como estaba guardado.')) return;
  const mode = S.mode;
  S = newSession(mode, S);
  undoStack = [];
  save();
  go(sectionOf(mode));
  toast('Cambios descartados');
}

// 3) Añadir un evento olvidado indicando parte y minuto

// Convierte "12:30", "12.30" o "12" (minutos) en milisegundos
function parseMinute(text) {
  const m = String(text || '').trim().match(/^(\d{1,2})(?:[:.,'](\d{1,2}))?$/);
  if (!m) return null;
  const sec = +(m[2] || 0);
  return sec < 60 ? (+m[1] * 60 + sec) * 1000 : null;
}

// Jugadoras en pista en un momento dado, a partir de sus entradas y salidas
function onCourtAt(part, t) {
  return rosterOrder(S.players)
    .filter((p) => p.stints.some((s) => s.part === part && s.in <= t && (s.out == null ? true : t < s.out)))
    .map((p) => p.num);
}

async function addPastEvent() {
  commit();
  const nParts = S.partMs.length;
  const v = await ask('Añadir evento con minuto', [
    { key: 'type', type: 'seg', label: 'Evento', options: [
      ['golFavor', 'Gol a favor'], ['golContra', 'Gol en contra'], ['faltaNuestra', 'Falta nuestra'],
      ['faltaRival', 'Falta rival'], ['bp', 'FD / Penalti'], ['tarjeta', 'Tarjeta']] },
    { key: 'part', type: 'seg', label: 'Parte', options: S.partMs.map((_, i) => [i + 1, partName(S, i + 1)]) },
    { key: 'min', type: 'num', label: 'Minuto de la parte (minutos:segundos)', required: true, placeholder: '12:30' },
    { key: 'kind', type: 'seg', label: 'Tipo', options: [['fd', 'Falta directa'], ['penalti', 'Penalti']], show: (x) => x.type === 'bp' },
    { key: 'side', type: 'seg', label: 'Para', options: [['favor', 'A favor'], ['contra', 'En contra']], show: (x) => x.type === 'bp' },
    { key: 'res', type: 'seg', label: 'Resultado', options: [['gol', 'Gol'], ['fallo', 'Fallado / parado']], show: (x) => x.type === 'bp' },
    { key: 'team', type: 'seg', label: 'Equipo', options: [['nuestra', 'Nuestra'], ['rival', 'Rival']], show: (x) => x.type === 'tarjeta' },
    { key: 'card', type: 'seg', label: 'Tarjeta', options: [['azul', `Azul (${CARDS.azul.min}')`], ['roja', `Roja (${CARDS.roja.min}')`]], show: (x) => x.type === 'tarjeta' },
    { key: 'rival', type: 'num', label: 'Nº de la rival (opcional)',
      show: (x) => x.type === 'golContra' || (x.type === 'bp' && x.side === 'contra') || (x.type === 'tarjeta' && x.team === 'rival') },
    { key: 'num', type: 'player', label: 'Jugadora',
      show: (x) => ['golFavor', 'faltaNuestra'].includes(x.type) || (x.type === 'bp' && x.side === 'favor') || (x.type === 'tarjeta' && x.team === 'nuestra') },
  ], { type: 'golFavor', part: S.part, side: 'favor', kind: 'fd', team: 'nuestra', card: 'azul' });
  if (!v) return;

  const part = +v.part;
  const t = parseMinute(v.min);
  const partLen = part === S.part ? partNow() : S.partMs[part - 1];
  if (t == null) return alert('Escribe el minuto como 12:30 (minutos:segundos) o solo los minutos (12).');
  if (t > partLen) return alert(`En la ${partName(S, part)} solo se han jugado ${fmt(partLen)}.`);

  const abs = sum(S.partMs.slice(0, part - 1)) + t;
  const st = { part, t, abs };
  const five = onCourtAt(part, t);
  const evs = [];
  const goal = (side, extra = {}) => ({ id: uid(), type: 'gol', side, via: 'juego', ...st, five, ...extra });
  switch (v.type) {
    case 'golFavor': evs.push(goal('favor', { num: v.num })); break;
    case 'golContra': evs.push(goal('contra', { rival: v.rival || '' })); break;
    case 'faltaNuestra': evs.push({ id: uid(), type: 'falta', side: 'nuestra', ...st, num: v.num }); break;
    case 'faltaRival': evs.push({ id: uid(), type: 'falta', side: 'rival', ...st }); break;
    case 'bp': {
      const favor = v.side === 'favor';
      const bp = { id: uid(), type: 'bp', kind: v.kind, side: v.side, scored: v.res === 'gol', ...st,
        num: favor ? v.num : null, rival: favor ? '' : v.rival || '' };
      evs.push(bp);
      if (bp.scored) evs.push(goal(v.side, { via: v.kind, num: bp.num, rival: bp.rival, bpId: bp.id }));
      break;
    }
    case 'tarjeta': {
      const ours = v.team === 'nuestra';
      evs.push({ id: uid(), type: 'sancion', side: v.team, card: v.card, dur: CARDS[v.card].min * 60000, ...st,
        num: ours ? v.num : null, rival: ours ? '' : v.rival || '', five });
      break;
    }
  }

  action(() => {
    // se inserta en su sitio, por orden de tiempo, para que los marcadores salgan bien
    let idx = S.events.findIndex((e) => e.abs > abs);
    if (idx < 0) idx = S.events.length;
    S.events.splice(idx, 0, ...evs);
    // sanción añadida a posteriori: marcador inicial y final según los goles de ese tramo
    evs.filter((e) => e.type === 'sancion').forEach((e) => {
      const goalsUntil = (lim, incl) => S.events.filter((g) => g.type === 'gol' && (incl ? g.abs <= lim : g.abs < lim));
      const sc = (list) => [list.filter((g) => g.side === 'favor').length, list.filter((g) => g.side === 'contra').length];
      e.scoreStart = sc(goalsUntil(e.abs, false));
      const end = e.abs + e.dur;
      if (end <= gameTotal()) {
        const pt = absToPart(end);
        Object.assign(e, { endAbs: end, endPart: pt.part, endT: pt.t, scoreEnd: sc(goalsUntil(end, true)) });
      }
    });
  });
  toast(`Añadido: ${describe(S, evs[evs.length - 1])}`);
}

function recordTitle(rec) {
  return rec.mode === 'partido' ? `${rec.info.team || 'Nosotras'} x ${rec.info.rival || 'Rival'}` : 'Entreno';
}

// Lista de partidos o entrenos terminados (en el menú de cada sección)
function renderHistory(mode, list, filter = () => true) {
  const history = load(KEY_HISTORY, []).filter((r) => r.mode === mode && filter(r));
  if (!history.length) {
    list.innerHTML = `<p class="hint">Todavía no hay ${mode === 'partido' ? 'otros partidos' : 'entrenos'} terminados.</p>`;
  } else {
    list.replaceChildren(...history.map((rec) => {
      const row = document.createElement('div');
      const [us, them] = score(rec);
      row.className = 'hist-item' + (rec.mode !== 'partido' ? '' : us > them ? ' win' : us === them ? ' draw' : ' loss');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'open';
      const fecha = (rec.info.fecha || '').split('-').reverse().join('/');
      open.innerHTML = '<b></b><small></small>';
      open.querySelector('b').textContent = `${recordTitle(rec)}  ${score(rec).join('-')}`;
      open.querySelector('small').textContent = `${fecha} · ${rec.info.competicion || ''} · ${fmt(sum(rec.partMs))}`;
      open.onclick = () => showRecord(rec);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'ghost danger small';
      del.textContent = 'Borrar';
      del.onclick = () => {
        if (!confirm('¿Borrar esta sesión del historial?')) return;
        store(KEY_HISTORY, load(KEY_HISTORY, []).filter((x) => x.id !== rec.id));
        cloudMarkDeleted(rec.id);
        render();
      };
      row.append(open, del);
      return row;
    }));
  }
}

function renderLastBackup() {
  const last = load(KEY_BACKUP, null);
  $('lastBackup').textContent = last
    ? `Última copia: ${new Date(last).toLocaleDateString('es-ES')}.`
    : 'Todavía no se ha hecho ninguna copia.';
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
  renderLastBackup();
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
    nuevos.forEach((r) => cloudMarkDirty(r.id));
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
  renderLastBackup();
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
  updateCloudUI();
  renderLastBackup();
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
$('btnBack').onclick = goBack;
$('menuTotals').onclick = () => go('totales');
document.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => go(b.dataset.go)));
window.addEventListener('hashchange', applyRoute);
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
$('dlgResults').addEventListener('close', () => {
  if (!resultsReturn) return;
  const r = resultsReturn;
  resultsReturn = null;
  go(r);
});
$('resEdit').onclick = () => currentRecord && editRecord(currentRecord);
$('resReopen').onclick = () => currentRecord && reopenRecord(currentRecord);
$('btnDiscard').onclick = discardReopen;
$('btnAddPast').onclick = addPastEvent;
$('resDelete').onclick = () => {
  if (!currentRecord || !confirm('¿Borrar los datos de este partido/entreno? No se puede deshacer.')) return;
  store(KEY_HISTORY, load(KEY_HISTORY, []).filter((x) => x.id !== currentRecord.id));
  cloudMarkDeleted(currentRecord.id);
  $('dlgResults').close();
  render();
  toast('Borrado');
};
$('menuOther').onclick = () => {
  if (isStarted() && !(S.mode === 'partido' && !S.info.fixtureId)) {
    alert('Hay un partido o entreno en curso. Termínalo antes de empezar otro partido.');
    return;
  }
  startSession('partido');
};

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
  if (route === 'juego' && ev.code === 'Space' && !/INPUT|TEXTAREA/.test(ev.target.tagName) && !document.querySelector('dialog[open]')) {
    ev.preventDefault();
    togglePlay();
  }
});

// En la pantalla de juego, un partido nuevo empieza eligiendo las convocadas
function startupChecks() {
  if (cloudLocked() || route !== 'juego') return;
  if (!S.squadOk && !isStarted() && !$('dlgSquad').open) openSquad();
}

setInterval(tick, 250);
cloudInit();      // cuenta y sincronización (cloud.js)
applyRoute();     // muestra la pantalla de la dirección (por defecto, el índice)
updateWakeLock();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js');
}
