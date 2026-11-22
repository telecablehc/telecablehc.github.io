// AppHóquei — planificación de entrenos
// - Planes: fecha, hora, objetivo, ejercicios en orden (con duración total) y notas.
// - Biblioteca: ejercicios guardados para reutilizar en otros planes.
// - Dibujo: cada ejercicio puede llevar un dibujo sobre la pista (40 x 20 m).
//   Las posiciones se guardan en coordenadas relativas (0–1).
// Usa funciones de app.js ($, load, store, uid, go, toast…) solo en tiempo de ejecución.
'use strict';

const KEY_PLANS = 'hoquei.planes';
const KEY_EXERCISES = 'hoquei.ejercicios';
const TIPOS = [
  ['calentamiento', 'Calentamiento'], ['tecnica', 'Técnica'], ['tactica', 'Táctica'], ['fisico', 'Físico'],
  ['porteras', 'Porteras'], ['juego', 'Juego'], ['calma', 'Vuelta a la calma'],
];
const tipoLabel = (t) => (TIPOS.find((x) => x[0] === t) || [null, 'Sin tipo'])[1];

let currentPlanId = null;
let libFilter = 'todos';

// ---------- Datos ----------

const loadPlans = () => load(KEY_PLANS, []);
const loadExercises = () => load(KEY_EXERCISES, []);
const planDuration = (plan) => plan.ejercicios.reduce((a, e) => a + (+e.duracion || 0), 0);
const findPlan = (id) => loadPlans().find((p) => p.id === id) || null;

function upsert(key, kind, item) {
  const list = load(key, []);
  item.actualizado = new Date().toISOString();
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item; else list.push(item);
  store(key, list);
  cloudMarkDoc(kind, item.id);
}
function remove(key, kind, id) {
  store(key, load(key, []).filter((x) => x.id !== id));
  cloudMarkDoc(kind, id);
}
const savePlan = (plan) => upsert(KEY_PLANS, 'plan', plan);
const saveLibExercise = (ex) => upsert(KEY_EXERCISES, 'ejercicio', ex);

function planDone(plan) {
  return load(KEY_HISTORY, []).some((r) => r.mode === 'entreno' && r.info.planId === plan.id);
}
const planIsLive = (plan) => isStarted() && S.mode === 'entreno' && S.info.planId === plan.id;

function newExercise() {
  return { id: uid(), nombre: '', tipo: 'tecnica', duracion: 10, descripcion: '', dibujo: { items: [] } };
}

function planDateText(plan) {
  if (!plan.fecha) return 'Sin fecha';
  const d = new Date(plan.fecha + 'T12:00:00');
  return `${DIAS[d.getDay()]} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}${plan.hora ? ' · ' + plan.hora : ''}`;
}

// ---------- Menú de Entrenos: lista de planes ----------

function renderEntrenosMenu() {
  const plans = loadPlans();
  const t = today();
  const upcoming = plans.filter((p) => (p.fecha || '9999') >= t).sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora));
  const past = plans.filter((p) => p.fecha && p.fecha < t).sort((a, b) => (b.fecha + b.hora).localeCompare(a.fecha + a.hora));
  const nEx = loadExercises().length;
  $('menuLibrarySub').textContent = nEx ? `${nEx} ejercicio${nEx === 1 ? '' : 's'} guardado${nEx === 1 ? '' : 's'}` : 'Ejercicios guardados para reutilizar';
  const list = $('menuPlans');
  if (!plans.length) {
    list.innerHTML = '<p class="hint">Todavía no hay entrenos planificados.</p>';
    return;
  }
  list.replaceChildren(...[...upcoming, ...past].map((p) => {
    const b = document.createElement('button');
    const done = planDone(p), live = planIsLive(p);
    b.className = 'fixture plan-row' + (live ? ' live' : done ? ' win' : '');
    b.innerHTML = '<span class="fx-j"></span><span class="fx-main"><b></b><small></small></span><span class="fx-state"></span>';
    b.querySelector('.fx-j').textContent = p.fecha ? p.fecha.slice(8, 10) + '/' + p.fecha.slice(5, 7) : '—';
    b.querySelector('b').textContent = p.objetivo || 'Entreno';
    b.querySelector('small').textContent = `${planDateText(p)} · ${p.ejercicios.length} ejercicio${p.ejercicios.length === 1 ? '' : 's'} · ${planDuration(p)} min`;
    b.querySelector('.fx-state').textContent = live ? '● en curso' : done ? '✓ hecho' : p.fecha === t ? 'hoy' : '';
    b.onclick = () => go('plan/' + p.id);
    return b;
  }));
}

function createPlan() {
  const plan = { id: uid(), fecha: today(), hora: '', objetivo: '', notas: '', ejercicios: [] };
  savePlan(plan);
  go('plan/' + plan.id);
}

// ---------- Pantalla de un plan ----------

function renderPlan() {
  const plan = findPlan(currentPlanId);
  if (!plan) { location.replace('#entrenos'); return; }
  const setIfIdle = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v || ''; };
  setIfIdle('planFecha', plan.fecha);
  setIfIdle('planHora', plan.hora);
  setIfIdle('planObjetivo', plan.objetivo);
  setIfIdle('planNotas', plan.notas);
  $('planTotal').textContent = `${plan.ejercicios.length} · ${planDuration(plan)} min`;

  const list = $('planExercises');
  if (!plan.ejercicios.length) {
    list.innerHTML = '<p class="hint">Añade ejercicios nuevos o desde la biblioteca.</p>';
  } else {
    let start = 0;
    list.replaceChildren(...plan.ejercicios.map((ex, i) => {
      const card = exerciseCard(ex, i + 1, `${start}'–${start + (+ex.duracion || 0)}'`);
      start += +ex.duracion || 0;
      const tools = document.createElement('div');
      tools.className = 'ex-tools';
      const btn = (txt, title, fn, cls = '') => {
        const b = document.createElement('button');
        b.className = 'ghost small ' + cls; b.textContent = txt; b.title = title; b.onclick = fn;
        return b;
      };
      tools.append(
        btn('↑', 'Subir', () => movePlanExercise(i, -1)),
        btn('↓', 'Bajar', () => movePlanExercise(i, 1)),
        btn('Editar', 'Editar ejercicio', () => editPlanExercise(i)),
        btn('Quitar', 'Quitar del plan', () => removePlanExercise(i), 'danger'),
      );
      tools.children[0].disabled = i === 0;
      tools.children[1].disabled = i === plan.ejercicios.length - 1;
      card.append(tools);
      return card;
    }));
  }
  const live = planIsLive(plan);
  $('planStart').textContent = live ? '▶ Continuar entreno' : planDone(plan) ? '▶ Repetir entreno' : '▶ Empezar entreno';
}

// Tarjeta de ejercicio (plan, biblioteca e impresión comparten el aspecto)
function exerciseCard(ex, n, timeText) {
  const card = document.createElement('div');
  card.className = 'ex-card';
  card.innerHTML = `
    <div class="ex-head">
      ${n ? `<span class="ex-n">${n}</span>` : ''}
      <b class="ex-name"></b>
      <span class="tipo t-${ex.tipo}"></span>
      <span class="ex-dur"></span>
    </div>
    <div class="ex-body">
      ${(ex.dibujo && ex.dibujo.items.length) ? '<div class="draw-thumb"></div>' : ''}
      <p class="ex-desc"></p>
    </div>`;
  card.querySelector('.ex-name').textContent = ex.nombre || 'Ejercicio sin nombre';
  card.querySelector('.tipo').textContent = tipoLabel(ex.tipo);
  card.querySelector('.ex-dur').textContent = `${ex.duracion || 0} min${timeText ? ' · ' + timeText : ''}`;
  card.querySelector('.ex-desc').textContent = ex.descripcion || '';
  // dibujo: con movimientos se reproduce como vídeo (▶), sin movimientos es una imagen
  const thumb = card.querySelector('.draw-thumb');
  if (thumb) mountDrawing(thumb, ex.dibujo, () => ex.nombre);
  if (hasMoves(ex.dibujo)) {
    const tag = document.createElement('span');
    tag.className = 'video-tag';
    tag.textContent = '🎬 Vídeo';
    card.querySelector('.ex-head').insertBefore(tag, card.querySelector('.ex-dur'));
  }
  return card;
}

function updatePlan(fn) {
  const plan = findPlan(currentPlanId);
  if (!plan) return;
  fn(plan);
  savePlan(plan);
  renderPlan();
}

function movePlanExercise(i, dir) {
  updatePlan((p) => {
    const j = i + dir;
    if (j < 0 || j >= p.ejercicios.length) return;
    [p.ejercicios[i], p.ejercicios[j]] = [p.ejercicios[j], p.ejercicios[i]];
  });
}

function removePlanExercise(i) {
  const plan = findPlan(currentPlanId);
  if (!plan || !confirm(`¿Quitar «${plan.ejercicios[i].nombre || 'este ejercicio'}» del plan?`)) return;
  updatePlan((p) => p.ejercicios.splice(i, 1));
}

function editPlanExercise(i) {
  const plan = findPlan(currentPlanId);
  openExerciseEditor(plan.ejercicios[i], { libOption: true }, (ex, toLib) => {
    updatePlan((p) => (p.ejercicios[i] = ex));
    if (toLib) addToLibrary(ex);
  });
}

function addNewPlanExercise() {
  openExerciseEditor(newExercise(), { libOption: true, isNew: true }, (ex, toLib) => {
    updatePlan((p) => p.ejercicios.push(ex));
    if (toLib) addToLibrary(ex);
  });
}

// Copia un ejercicio a la biblioteca (si ya venía de ella, la actualiza)
function addToLibrary(ex) {
  const lib = { ...JSON.parse(JSON.stringify(ex)), id: ex.libId || uid() };
  delete lib.libId;
  saveLibExercise(lib);
  if (!ex.libId) updatePlan((p) => { const e = p.ejercicios.find((x) => x.id === ex.id); if (e) e.libId = lib.id; });
  toast('Guardado en la biblioteca');
}

function pickFromLibrary() {
  const draw = () => {
    const lib = loadExercises();
    const list = $('libPickList');
    if (!lib.length) {
      list.innerHTML = '<p class="hint">La biblioteca está vacía. Crea ejercicios en «Biblioteca de ejercicios» o marca «Guardar también en la biblioteca» al crear uno.</p>';
      return;
    }
    list.replaceChildren(...lib.map((ex) => {
      const card = exerciseCard(ex);
      const add = document.createElement('button');
      add.className = 'primary small-btn';
      add.textContent = '＋ Añadir';
      add.onclick = () => {
        const copy = { ...JSON.parse(JSON.stringify(ex)), id: uid(), libId: ex.id };
        delete copy.actualizado;
        updatePlan((p) => p.ejercicios.push(copy));
        toast(`Añadido: ${ex.nombre}`);
      };
      card.append(add);
      return card;
    }));
  };
  draw();
  $('dlgLibPick').showModal();
}

function startPlan() {
  const plan = findPlan(currentPlanId);
  if (!plan) return;
  if (planIsLive(plan)) return go('juego');
  if (isStarted()) {
    alert(`Hay un ${S.mode === 'partido' ? 'partido' : 'entreno'} en curso. Termínalo antes de empezar este entreno.`);
    return;
  }
  startSession('entreno', null, plan);
}

function duplicatePlan() {
  const plan = findPlan(currentPlanId);
  if (!plan) return;
  const copy = JSON.parse(JSON.stringify(plan));
  copy.id = uid();
  copy.fecha = today();
  copy.ejercicios.forEach((e) => (e.id = uid()));
  savePlan(copy);
  go('plan/' + copy.id);
  toast('Plan duplicado con fecha de hoy');
}

function deleteCurrentPlan() {
  const plan = findPlan(currentPlanId);
  if (!plan || !confirm('¿Borrar este plan de entreno? Los ejercicios de la biblioteca no se borran.')) return;
  remove(KEY_PLANS, 'plan', plan.id);
  go('entrenos');
}

// HTML del plan para imprimir y para el resumen del entreno
function planHtml(plan, withHeader = true) {
  const e = escapeHtml;
  let start = 0;
  const rows = plan.ejercicios.map((ex, i) => {
    const from = start; start += +ex.duracion || 0;
    const drawing = ex.dibujo && ex.dibujo.items.length ? `<div class="draw-thumb print">${drawingSvg(ex.dibujo)}</div>` : '';
    return `<div class="ex-card"><div class="ex-head"><span class="ex-n">${i + 1}</span><b class="ex-name">${e(ex.nombre || 'Ejercicio')}</b>
      <span class="tipo t-${e(ex.tipo)}">${e(tipoLabel(ex.tipo))}</span><span class="ex-dur">${ex.duracion || 0} min · ${from}'–${start}'</span></div>
      <div class="ex-body">${drawing}<p class="ex-desc">${e(ex.descripcion || '')}</p></div></div>`;
  }).join('');
  const head = withHeader
    ? `<img class="sum-logo" src="crest.png" alt=""><h3>Entreno · ${e(planDateText(plan))}</h3>
       <p class="meta">Objetivo: <b>${e(plan.objetivo || '—')}</b> · Duración: <b>${planDuration(plan)} min</b> · ${plan.ejercicios.length} ejercicios</p>`
    : `<p class="meta">Objetivo: <b>${e(plan.objetivo || '—')}</b> · ${planDuration(plan)} min</p>`;
  return `<div class="sum plan-print">${head}${rows}${plan.notas ? `<h4>Notas</h4><p class="notes">${e(plan.notas)}</p>` : ''}</div>`;
}

// ---------- Biblioteca ----------

function renderLibrary() {
  const all = loadExercises();
  $('libFilter').replaceChildren(...[['todos', 'Todos'], ...TIPOS].map(([k, label]) => {
    const n = k === 'todos' ? all.length : all.filter((x) => x.tipo === k).length;
    const b = document.createElement('button');
    b.className = 'chip-btn' + (libFilter === k ? ' active' : '');
    b.textContent = `${label} (${n})`;
    b.onclick = () => { libFilter = k; renderLibrary(); };
    return b;
  }));
  const list = all.filter((x) => libFilter === 'todos' || x.tipo === libFilter)
    .sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
  const box = $('libList');
  if (!list.length) {
    box.innerHTML = `<p class="hint">${all.length ? 'No hay ejercicios de este tipo.' : 'Todavía no hay ejercicios guardados.'}</p>`;
    return;
  }
  box.replaceChildren(...list.map((ex) => {
    const card = exerciseCard(ex);
    const tools = document.createElement('div');
    tools.className = 'ex-tools';
    const edit = document.createElement('button');
    edit.className = 'ghost small'; edit.textContent = 'Editar';
    edit.onclick = () => openExerciseEditor(ex, {}, (changed) => { saveLibExercise(changed); renderLibrary(); });
    const del = document.createElement('button');
    del.className = 'ghost small danger'; del.textContent = 'Borrar';
    del.onclick = () => {
      if (!confirm(`¿Borrar «${ex.nombre}» de la biblioteca? Los planes que ya lo usan no cambian.`)) return;
      remove(KEY_EXERCISES, 'ejercicio', ex.id);
      renderLibrary();
    };
    tools.append(edit, del);
    card.append(tools);
    return card;
  }));
}

function newLibraryExercise() {
  const ex = newExercise();
  if (libFilter !== 'todos') ex.tipo = libFilter;
  openExerciseEditor(ex, { isNew: true }, (saved) => { saveLibExercise(saved); renderLibrary(); });
}

// ---------- Editor de un ejercicio ----------

function openExerciseEditor(original, opts, onSave) {
  const ex = JSON.parse(JSON.stringify(original));
  if (!ex.dibujo) ex.dibujo = { items: [] };
  const dlg = $('dlgExercise');
  $('exTitle').textContent = opts.isNew ? 'Nuevo ejercicio' : 'Editar ejercicio';
  $('exNombre').value = ex.nombre || '';
  $('exDur').value = ex.duracion || '';
  $('exDesc').value = ex.descripcion || '';
  $('exLibWrap').hidden = !opts.libOption;
  $('exLib').checked = false;
  const drawTipo = () => {
    $('exTipo').replaceChildren(...TIPOS.map(([k, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `chip-btn t-${k}` + (ex.tipo === k ? ' active' : '');
      b.textContent = label;
      b.onclick = () => { ex.tipo = k; drawTipo(); };
      return b;
    }));
  };
  const drawThumb = () => {
    $('exThumb').classList.remove('video', 'playing');
    if (ex.dibujo.items.length) mountDrawing($('exThumb'), ex.dibujo, () => $('exNombre').value.trim());
    else $('exThumb').innerHTML = '<p class="hint">Sin dibujo</p>';
    $('exDraw').textContent = ex.dibujo.items.length ? '✏️ Editar dibujo' : '✏️ Dibujar en la pista';
  };
  drawTipo();
  drawThumb();
  $('exDraw').onclick = () => openDrawEditor(ex.dibujo, (d) => { ex.dibujo = d; drawThumb(); });
  $('exCancel').onclick = () => dlg.close();
  $('exOk').onclick = () => {
    ex.nombre = $('exNombre').value.trim();
    ex.duracion = Math.max(0, parseInt($('exDur').value, 10) || 0);
    ex.descripcion = $('exDesc').value.trim();
    if (!ex.nombre) { alert('Ponle un nombre al ejercicio.'); return; }
    dlg.close();
    onSave(ex, $('exLib').checked);
  };
  dlg.showModal();
}

// ---------- Dibujo en la pista ----------
// Pista de 40 x 20 m. Elementos: {t, x, y, (x2, y2), n, p}; coordenadas relativas 0–1.
// p = paso de la flecha (orden de los movimientos en la animación).

const DRAW_TOOLS = [
  ['mover', '✋', 'Mover'],
  ['own', '●', 'Nuestra'],
  ['gk', 'P', 'Portera'],
  ['opp', '●', 'Rival'],
  ['ball', '•', 'Bola'],
  ['cone', '▲', 'Cono'],
  ['run', '→', 'Movimiento'],
  ['pass', '⇢', 'Pase'],
  ['drive', '〰', 'Conducción'],
  ['shot', '⇒', 'Tiro'],
  ['setp', '#', 'Poner paso'],
  ['erase', '✕', 'Borrar'],
];
const ARROWS = ['run', 'pass', 'drive', 'shot'];
const DRAW_HINTS = {
  mover: 'Arrastra un elemento para moverlo (en las flechas, arrastra un extremo para cambiarlo).',
  erase: 'Toca un elemento para borrarlo.',
  setp: 'Toca una flecha para ponerle el paso elegido arriba.',
};

let svgSeq = 0;

// Dibujo de la pista (líneas a escala aproximada)
function rinkMarkup() {
  const end = (gx, dir) => {
    const ax = dir > 0 ? gx : gx - 5.4;
    return `
      <rect x="${ax}" y="5.5" width="5.4" height="9" class="rk-line" fill="none"/>
      <path d="M ${gx} 8.5 A 1.5 1.5 0 0 ${dir > 0 ? 1 : 0} ${gx} 11.5" class="rk-line" fill="none"/>
      <rect x="${dir > 0 ? gx - 0.9 : gx}" y="9.15" width="0.9" height="1.7" class="rk-goal"/>
      <circle cx="${gx + dir * 5.4}" cy="10" r="0.15" class="rk-dot"/>
      <circle cx="${gx + dir * 7.4}" cy="10" r="0.15" class="rk-dot"/>`;
  };
  return `
    <rect x="0" y="0" width="40" height="20" rx="1" class="rk-floor"/>
    <line x1="20" y1="0" x2="20" y2="20" class="rk-line"/>
    <circle cx="20" cy="10" r="3" class="rk-line" fill="none"/>
    <circle cx="20" cy="10" r="0.15" class="rk-dot"/>
    ${end(4, 1)}${end(36, -1)}`;
}

// ---------- Caminos (la conducción se dibuja a mano alzada: it.pts = [[x, y], …] en 0–1) ----------
const toM = ([x, y]) => [x * 40, y * 20];
// Puntos de una flecha en metros
// Suaviza un camino (Chaikin), conservando el principio y el final
function smoothPath(P, times = 2) {
  for (let n = 0; n < times && P.length > 2; n++) {
    const out = [P[0]];
    for (let i = 0; i < P.length - 1; i++) {
      const [ax, ay] = P[i], [bx, by] = P[i + 1];
      if (i > 0) out.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25]);
      if (i < P.length - 2) out.push([ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
    }
    out.push(P[P.length - 1]);
    P = out;
  }
  return P;
}
const pathM = (it) => (it.pts && it.pts.length > 2 ? smoothPath(it.pts.map(toM)) : (it.pts && it.pts.length > 1 ? it.pts : [[it.x, it.y], [it.x2, it.y2]]).map(toM));
const pathLen = (P) => P.reduce((L, p, i) => (i ? L + Math.hypot(p[0] - P[i - 1][0], p[1] - P[i - 1][1]) : 0), 0);
// Punto a una distancia s (metros) a lo largo del camino; más allá del final sigue en la última dirección
function pointAlong(P, s) {
  if (P.length < 2) return { x: P[0][0], y: P[0][1], dx: 1, dy: 0 };
  for (let i = 1; i < P.length; i++) {
    const [ax, ay] = P[i - 1], [bx, by] = P[i], l = Math.hypot(bx - ax, by - ay);
    if (s <= l || i === P.length - 1) {
      const k = l ? s / l : 0, dx = l ? (bx - ax) / l : 1, dy = l ? (by - ay) / l : 0;
      return { x: ax + (bx - ax) * k, y: ay + (by - ay) * k, dx, dy };
    }
    s -= l;
  }
}
// Simplifica un trazo a mano (Ramer–Douglas–Peucker, en metros)
function simplifyPath(P, eps = 0.15) {
  if (P.length < 3) return P;
  const [ax, ay] = P[0], [bx, by] = P[P.length - 1];
  const L = Math.hypot(bx - ax, by - ay) || 1;
  let idx = 0, max = 0;
  for (let i = 1; i < P.length - 1; i++) {
    const d = Math.abs((by - ay) * P[i][0] - (bx - ax) * P[i][1] + bx * ay - by * ax) / L;
    if (d > max) { max = d; idx = i; }
  }
  if (max <= eps) return [P[0], P[P.length - 1]];
  return [...simplifyPath(P.slice(0, idx + 1), eps).slice(0, -1), ...simplifyPath(P.slice(idx), eps)];
}

// Camino ondulado (conducción) a lo largo de unos puntos en metros, terminando recto para la punta
function wavePathM(P) {
  const L = pathLen(P);
  const [x1, y1] = P[0], [x2, y2] = P[P.length - 1];
  if (L < 1.2) return `M${x1},${y1} L${x2},${y2}`;
  const waveLen = L - 0.7, steps = Math.max(8, Math.round(waveLen * 6)), waves = Math.max(2, Math.round(waveLen / 1.1));
  let d = `M${x1},${y1}`;
  for (let i = 1; i <= steps; i++) {
    const s = (i / steps) * waveLen, off = Math.sin((i / steps) * waves * 2 * Math.PI) * 0.3;
    const q = pointAlong(P, s);
    d += ` L${(q.x - q.dy * off).toFixed(2)},${(q.y + q.dx * off).toFixed(2)}`;
  }
  return d + ` L${x2},${y2}`;
}
const wavePath = (x1, y1, x2, y2) => wavePathM([[x1, y1], [x2, y2]]);

// opts.pos: posición animada de las fichas (idx → {x, y}); opts.step: paso que se está animando;
// opts.badges: mostrar el número de paso en cada flecha
function itemMarkup(it, id, idx, opts = {}) {
  const at = (opts.pos && opts.pos[idx]) || it;
  const X = at.x * 40, Y = at.y * 20;
  const isArrow = ARROWS.includes(it.t);
  const faded = isArrow && opts.step != null && stepOf(it) !== opts.step;
  const g = (inner) => `<g data-i="${idx}"${faded ? ' opacity="0.25"' : ''}>${inner}</g>`;
  const label = (txt, fill) => `<text x="${X}" y="${Y + 0.3}" font-size="0.8" text-anchor="middle" font-weight="700" fill="${fill}">${escapeHtml(txt || '')}</text>`;
  switch (it.t) {
    case 'own': return g(`<circle cx="${X}" cy="${Y}" r="0.75" fill="#d0102a" stroke="#fff" stroke-width="0.12"/>${label(it.n, '#fff')}`);
    case 'gk': return g(`<circle cx="${X}" cy="${Y}" r="0.75" fill="#f2b705" stroke="#fff" stroke-width="0.12"/>${label('P', '#111')}`);
    case 'opp': return g(`<circle cx="${X}" cy="${Y}" r="0.75" fill="#1f4fa8" stroke="#fff" stroke-width="0.12"/>${label(it.n, '#fff')}`);
    case 'ball': return g(`<circle cx="${X}" cy="${Y}" r="0.32" fill="#ff7a00" stroke="#111" stroke-width="0.08"/>`);
    case 'cone': return g(`<path d="M${X},${Y - 0.6} L${X + 0.5},${Y + 0.4} L${X - 0.5},${Y + 0.4} Z" fill="#ffd400" stroke="#111" stroke-width="0.08"/>`);
    default: {
      const X2 = it.x2 * 40, Y2 = it.y2 * 20;
      const P = pathM(it);
      const d = it.t === 'drive' ? wavePathM(P) : `M${X},${Y} L${X2},${Y2}`;
      const mid = pointAlong(P, pathLen(P) / 2);
      const dash = it.t === 'pass' ? ' stroke-dasharray="0.5 0.35"' : '';
      const width = it.t === 'shot' ? 0.24 : 0.14;
      // número de paso junto a la mitad de la flecha
      const badge = opts.badges
        ? `<circle cx="${mid.x}" cy="${mid.y - 0.7}" r="0.5" fill="#fff" stroke="#111" stroke-width="0.06"/>
           <text x="${mid.x}" y="${mid.y - 0.48}" font-size="0.6" text-anchor="middle" font-weight="700" fill="#111">${stepOf(it)}</text>`
        : '';
      // línea ancha transparente para que sea fácil de tocar
      return g(`<path d="${d}" stroke="transparent" stroke-width="1.2" fill="none"/>
        <path d="${d}" stroke="#111" stroke-width="${width}" fill="none"${dash} stroke-linecap="round" marker-end="url(#ah${id})"/>${badge}`);
    }
  }
}

function drawingSvg(dibujo, preview = null, opts = {}) {
  const id = ++svgSeq;
  const items = [...((dibujo && dibujo.items) || []), ...(preview ? [preview] : [])];
  if (opts.badges == null) opts = { ...opts, badges: maxStep(items) > 1 };
  // orden de dibujo: flechas, luego fichas y la bola encima de todo
  const layer = (it) => (ARROWS.includes(it.t) ? 0 : it.t === 'ball' ? 2 : 1);
  const order = items.map((it, i) => i).sort((a, b) => layer(items[a]) - layer(items[b]));
  return `<svg viewBox="-1 -1 42 22" xmlns="http://www.w3.org/2000/svg" class="rink-svg">
    <defs><marker id="ah${id}" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#111"/></marker></defs>
    ${rinkMarkup()}${order.map((i) => itemMarkup(items[i], id, i, opts)).join('')}</svg>`;
}

// ---------- Animación ("vídeo") de los movimientos ----------
// Cada flecha tiene un paso (p). Las del mismo paso se mueven a la vez.
// - Movimiento / conducción: se mueve la jugadora más cercana al inicio de la flecha
//   (en conducción también la bola que lleva).
// - Pase / tiro: se mueve la bola más cercana al inicio de la flecha.

const stepOf = (it) => it.p || 1;
const maxStep = (items) => items.reduce((m, it) => (ARROWS.includes(it.t) ? Math.max(m, stepOf(it)) : m), 0);
const hasMoves = (dibujo) => !!dibujo && (dibujo.items || []).some((it) => ARROWS.includes(it.t));
const STEP_TIME = { run: 1.4, drive: 1.6, pass: 0.8, shot: 0.7 }; // segundos
const PLAYERS_T = ['own', 'opp', 'gk'];
// Velocidad de la animación (se guarda en el dibujo: dibujo.vel). 1 = normal.
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2];
const speedOf = (dibujo) => (dibujo && SPEEDS.includes(dibujo.vel) ? dibujo.vel : 1);
const speedText = (v) => String(v).replace('.', ',') + '×';

// Calcula la línea de tiempo: [{idx, from, to, t0, t1}] y la duración total.
// vel: velocidad (2 = el doble de rápido; 0,5 = la mitad)
function buildTimeline(items, vel = 1) {
  const pos = {};
  items.forEach((it, i) => { if (!ARROWS.includes(it.t)) pos[i] = { x: it.x, y: it.y }; });
  const dist = (a, b) => Math.hypot((a.x - b.x) * 40, (a.y - b.y) * 20);
  const nearest = (types, p, maxM, used) => {
    let best = null, bd = maxM;
    items.forEach((it, i) => {
      if (!types.includes(it.t) || used.has(i)) return;
      const d = dist(pos[i], p);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };
  const segs = [];
  let t = 0.4; // pequeña pausa al empezar
  for (let s = 1; s <= maxStep(items); s++) {
    const arrows = items.filter((it) => ARROWS.includes(it.t) && stepOf(it) === s);
    if (!arrows.length) continue;
    // conducción a mano alzada: más tiempo si el recorrido es largo (unos 7 m/s)
    const timeOf = (a) => (a.pts ? Math.max(STEP_TIME[a.t], pathLen(pathM(a)) / 7) : STEP_TIME[a.t]);
    const dur = Math.max(...arrows.map(timeOf));
    const used = new Set();
    const moves = [];
    arrows.forEach((a) => {
      const start = { x: a.x, y: a.y }, end = { x: a.x2, y: a.y2 };
      const len = timeOf(a);
      if (a.t === 'pass' || a.t === 'shot') {
        const b = nearest(['ball'], start, 2.5, used);
        if (b != null) { used.add(b); moves.push({ idx: b, from: { ...pos[b] }, to: end, t0: t, t1: t + len }); }
      } else {
        const pl = nearest(PLAYERS_T, start, 2.5, used);
        if (pl != null) {
          used.add(pl);
          if (a.t === 'drive' && a.pts && a.pts.length > 1) {
            // recorrido a mano: la jugadora lo sigue y la bola va un poco por delante en el mismo camino
            const path = [[pos[pl].x, pos[pl].y], ...a.pts.slice(1)];
            const PM = smoothPath(path.map(toM)), L = pathLen(PM);
            const at = (s) => { const q = pointAlong(PM, s); return { x: q.x / 40, y: q.y / 20 }; };
            moves.push({ idx: pl, from: { ...pos[pl] }, to: at(L), t0: t, t1: t + len, path: PM });
            const b = nearest(['ball'], pos[pl], 2, used);
            if (b != null) { used.add(b); moves.push({ idx: b, from: { ...pos[b] }, to: at(L + 0.9), t0: t, t1: t + len, path: PM, lead: 0.9 }); }
            return;
          }
          moves.push({ idx: pl, from: { ...pos[pl] }, to: end, t0: t, t1: t + len });
          if (a.t === 'drive') { // la bola va pegada a la jugadora
            const b = nearest(['ball'], pos[pl], 2, used);
            if (b != null) {
              used.add(b);
              let off = { x: pos[b].x - pos[pl].x, y: pos[b].y - pos[pl].y };
              // si la bola está justo encima de la jugadora, se lleva un poco por delante
              if (Math.hypot(off.x * 40, off.y * 20) < 0.4) {
                const dx = (end.x - pos[pl].x) * 40, dy = (end.y - pos[pl].y) * 20, L = Math.hypot(dx, dy) || 1;
                off = { x: (dx / L) * 0.9 / 40, y: (dy / L) * 0.9 / 20 };
              }
              moves.push({ idx: b, from: { ...pos[b] }, to: { x: end.x + off.x, y: end.y + off.y }, t0: t, t1: t + len });
            }
          }
        }
      }
    });
    moves.forEach((m) => { pos[m.idx] = { ...m.to }; segs.push({ ...m, step: s }); });
    t += dur + 0.3;
  }
  const k = 1 / vel;
  return { segs: segs.map((s) => ({ ...s, t0: s.t0 * k, t1: s.t1 * k })), total: (t + 0.8) * k };
}

// Posición de las fichas en el segundo t
function positionsAt(items, timeline, t) {
  const pos = {};
  const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
  timeline.segs.forEach((s) => {
    if (t < s.t0) return;
    const k = t >= s.t1 ? 1 : ease((t - s.t0) / (s.t1 - s.t0));
    if (s.path) {
      const q = pointAlong(s.path, k * pathLen(s.path) + (s.lead || 0));
      // la bola pasa poco a poco de donde estaba al camino (delante de la jugadora)
      const w = s.lead ? Math.min(1, k * 8) : 1;
      pos[s.idx] = { x: s.from.x + (q.x / 40 - s.from.x) * w, y: s.from.y + (q.y / 20 - s.from.y) * w };
      return;
    }
    pos[s.idx] = { x: s.from.x + (s.to.x - s.from.x) * k, y: s.from.y + (s.to.y - s.from.y) * k };
  });
  const step = (timeline.segs.find((s) => t >= s.t0 && t <= s.t1) || {}).step ?? null;
  return { pos, step };
}

// Reproductor: dibujo con botón ▶; se repite en bucle mientras está a la vista.
// getName: nombre del ejercicio (para el título y el nombre del archivo al descargar)
function mountDrawing(container, dibujo, getName = () => '') {
  container.innerHTML = drawingSvg(dibujo);
  if (!hasMoves(dibujo)) return;
  const items = dibujo.items;
  const timeline = buildTimeline(items, speedOf(dibujo));
  container.classList.add('video');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'video-btn';
  btn.title = 'Ver el ejercicio en movimiento';
  btn.textContent = '▶';
  const bar = document.createElement('div');
  bar.className = 'video-bar';
  container.append(btn, bar);
  let raf = null, t0 = 0;
  const frame = (now) => {
    if (!container.isConnected) { raf = null; return; }
    const t = ((now - t0) / 1000) % timeline.total;
    const { pos, step } = positionsAt(items, timeline, t);
    const svg = container.querySelector('svg');
    const tmp = document.createElement('div');
    tmp.innerHTML = drawingSvg(dibujo, null, { pos, step, badges: maxStep(items) > 1 });
    svg.replaceWith(tmp.firstElementChild);
    bar.style.width = `${(t / timeline.total) * 100}%`;
    raf = requestAnimationFrame(frame);
  };
  const stop = () => {
    cancelAnimationFrame(raf); raf = null;
    btn.textContent = '▶'; container.classList.remove('playing');
    container.querySelector('svg').replaceWith(Object.assign(document.createElement('div'), { innerHTML: drawingSvg(dibujo) }).firstElementChild);
    bar.style.width = '0';
  };
  const toggle = (ev) => {
    ev.stopPropagation();
    if (raf) return stop();
    t0 = performance.now();
    btn.textContent = '❚❚'; container.classList.add('playing');
    raf = requestAnimationFrame(frame);
  };
  btn.onclick = toggle;
  container.onclick = toggle;

  // ⬇ descargar como archivo de vídeo
  const dl = document.createElement('button');
  dl.type = 'button';
  dl.className = 'video-dl';
  dl.title = 'Descargar el vídeo';
  dl.textContent = '⬇ Vídeo';
  dl.onclick = (ev) => {
    ev.stopPropagation();
    if (raf) stop();
    downloadExerciseVideo(dibujo, getName(), dl);
  };
  container.append(dl);
}

// ---------- Descargar el ejercicio como vídeo (MP4 si el navegador puede, si no WebM) ----------

const VIDEO_W = 1280, VIDEO_H = 790, VIDEO_HEAD = 120; // cabecera con escudo y nombre
const SVG_INLINE_STYLE = '<style>.rk-floor{fill:#dcebf5;stroke:#3a4a58;stroke-width:.18}' +
  '.rk-line{stroke:#2c5b8a;stroke-width:.1}.rk-dot{fill:#2c5b8a}.rk-goal{fill:#fff;stroke:#111;stroke-width:.12}' +
  'text{font-family:Arial,Helvetica,sans-serif}</style>';

function videoFormat() {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return null;
  const options = [
    ['video/mp4;codecs=avc1', 'mp4'], ['video/mp4', 'mp4'],
    ['video/webm;codecs=vp9', 'webm'], ['video/webm;codecs=vp8', 'webm'], ['video/webm', 'webm'],
  ];
  const ok = options.find(([type]) => MediaRecorder.isTypeSupported(type));
  return ok ? { type: ok[0], ext: ok[1] } : null;
}

// Convierte el SVG de un fotograma en imagen (con los estilos dentro, porque una imagen no ve la hoja CSS)
function svgToImage(svgMarkup) {
  const svg = svgMarkup
    .replace('<svg ', `<svg width="${VIDEO_W}" height="${VIDEO_H - VIDEO_HEAD}" `)
    .replace('<defs>', SVG_INLINE_STYLE + '<defs>');
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function downloadExerciseVideo(dibujo, nombre, button) {
  const fmt = videoFormat();
  if (!fmt) {
    alert('Este navegador no permite grabar vídeo. Prueba con Chrome, Edge o un iPhone/iPad actualizado.');
    return;
  }
  const label = button.textContent;
  button.disabled = true;
  try {
    const items = dibujo.items;
    const timeline = buildTimeline(items, speedOf(dibujo));
    const duration = timeline.total + 0.6; // una vuelta completa y un momento quieto al final
    const canvas = document.createElement('canvas');
    canvas.width = VIDEO_W; canvas.height = VIDEO_H;
    const ctx = canvas.getContext('2d');
    const crest = await loadImage('crest.png');
    const title = nombre || 'Ejercicio';
    const drawHead = () => {
      ctx.fillStyle = '#0f3d5e';
      ctx.fillRect(0, 0, VIDEO_W, VIDEO_HEAD);
      if (crest) ctx.drawImage(crest, 24, 14, (VIDEO_HEAD - 28) * crest.width / crest.height, VIDEO_HEAD - 28);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 44px Arial, Helvetica, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(title.length > 40 ? title.slice(0, 39) + '…' : title, 130, VIDEO_HEAD / 2 - 12);
      ctx.font = '26px Arial, Helvetica, sans-serif';
      ctx.fillStyle = '#cfe0ee';
      ctx.fillText('Telecable HC', 130, VIDEO_HEAD / 2 + 28);
    };
    const drawFrame = async (t) => {
      const { pos, step } = positionsAt(items, timeline, Math.min(t, timeline.total));
      const img = await svgToImage(drawingSvg(dibujo, null, { pos, step, badges: maxStep(items) > 1 }));
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, VIDEO_HEAD, VIDEO_W, VIDEO_H - VIDEO_HEAD);
      ctx.drawImage(img, 0, VIDEO_HEAD, VIDEO_W, VIDEO_H - VIDEO_HEAD);
      drawHead();
    };

    await drawFrame(0);
    const stream = canvas.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: fmt.type, videoBitsPerSecond: 4000000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const finished = new Promise((resolve) => (rec.onstop = resolve));
    rec.start(250);
    // se graba en tiempo real: cada fotograma corresponde al segundo de la animación
    const start = performance.now();
    for (;;) {
      const t = (performance.now() - start) / 1000;
      if (t >= duration) break;
      await drawFrame(t);
      button.textContent = `Grabando ${Math.round((t / duration) * 100)}%`;
      await new Promise((r) => requestAnimationFrame(r));
    }
    rec.stop();
    await finished;
    stream.getTracks().forEach((tr) => tr.stop());

    const safe = title.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    const file = new File(chunks, `ejercicio-${safe || 'telecable'}.${fmt.ext}`, { type: fmt.type.split(';')[0] });
    await shareOrDownload(file);
    toast('Vídeo listo');
  } catch (err) {
    alert('No se ha podido crear el vídeo: ' + (err && err.message ? err.message : err));
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

// En móvil/tablet: menú Compartir (WhatsApp, Drive, Fotos…). En ordenador: descarga.
async function shareOrDownload(file) {
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: file.name }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  downloadFile(file);
}

function openDrawEditor(dibujo, onDone) {
  let items = JSON.parse(JSON.stringify((dibujo && dibujo.items) || []));
  const undoList = [];
  let tool = 'own';
  let drag = null;
  let step = Math.max(1, maxStep(items)); // paso de las flechas nuevas
  let playing = null; // animación de prueba en marcha
  let vel = speedOf(dibujo); // velocidad de los movimientos
  const svg = $('drawSvg');
  const dlg = $('dlgDraw');
  const snapshot = () => { undoList.push(JSON.stringify(items)); if (undoList.length > 50) undoList.shift(); };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  // seguir el dedo aunque salga de la pista (si el navegador no lo permite, no pasa nada)
  const capture = (ev) => { try { svg.setPointerCapture(ev.pointerId); } catch {} };

  const toPoint = (ev) => {
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    const m = pt.matrixTransform(svg.getScreenCTM().inverse());
    return { x: clamp(m.x, 0, 40) / 40, y: clamp(m.y, 0, 20) / 20 };
  };
  const meters = (a, b) => Math.hypot((a.x - b.x) * 40, (a.y - b.y) * 20);
  const segDist = (p, a, b) => {
    const px = p.x * 40, py = p.y * 20, ax = a.x * 40, ay = a.y * 20, bx = b.x * 40, by = b.y * 20;
    const L2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
    const t = clamp(((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / L2, 0, 1);
    return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
  };
  // ¿Qué elemento hay bajo el dedo? (el de arriba primero)
  const hit = (p) => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (ARROWS.includes(it.t)) {
        const b = { x: it.x2, y: it.y2 };
        if (meters(p, it) < 0.9) return { i, part: 'a' };
        if (meters(p, b) < 0.9) return { i, part: 'b' };
        const pts = it.pts && it.pts.length > 1 ? it.pts : [[it.x, it.y], [it.x2, it.y2]];
        for (let k = 1; k < pts.length; k++) {
          if (segDist(p, { x: pts[k - 1][0], y: pts[k - 1][1] }, { x: pts[k][0], y: pts[k][1] }) < 0.6) return { i, part: 'all' };
        }
      } else if (meters(p, it) < 1) return { i, part: 'all' };
    }
    return null;
  };
  const nextLabel = (t) => String(items.filter((x) => x.t === t).length + 1);

  const redraw = (opts = { badges: true }) => {
    const tmp = document.createElement('div');
    tmp.innerHTML = drawingSvg({ items }, drag && drag.preview, opts);
    svg.innerHTML = tmp.firstElementChild.innerHTML;
  };
  // ▶ Ver: reproduce la animación dentro del editor (mientras tanto no se edita)
  const stopPreview = () => { if (playing) { cancelAnimationFrame(playing.raf); playing = null; redraw(); drawTools(); } };
  const startPreview = () => {
    if (!items.some((it) => ARROWS.includes(it.t))) { alert('Dibuja primero alguna flecha de movimiento, pase o conducción.'); return; }
    const timeline = buildTimeline(items, vel);
    const t0 = performance.now();
    playing = { raf: 0 };
    const frame = (now) => {
      if (!playing || !dlg.open) { playing = null; return; }
      const t = ((now - t0) / 1000) % timeline.total;
      redraw({ ...positionsAt(items, timeline, t), badges: true });
      playing.raf = requestAnimationFrame(frame);
    };
    playing.raf = requestAnimationFrame(frame);
    drawTools();
  };
  const drawTools = () => {
    $('drawTools').replaceChildren(
      ...DRAW_TOOLS.map(([k, icon, label]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `tool tool-${k}` + (tool === k ? ' active' : '');
        b.innerHTML = `<span class="tool-icon">${icon}</span><span class="tool-label">${label}</span>`;
        b.onclick = () => { stopPreview(); tool = k; drawTools(); };
        return b;
      }),
      // paso de las flechas nuevas (orden de los movimientos)
      (() => {
        const box = document.createElement('div');
        box.className = 'tool tool-step';
        box.innerHTML = '<span class="tool-label">Paso</span><span class="step-ctl"><button type="button">−</button><b></b><button type="button">+</button></span>';
        box.querySelector('b').textContent = step;
        const [minus, plus] = box.querySelectorAll('button');
        minus.onclick = () => { step = Math.max(1, step - 1); drawTools(); };
        plus.onclick = () => { step = Math.min(20, step + 1); drawTools(); };
        return box;
      })(),
      // velocidad de los movimientos (se guarda con el dibujo; afecta también al vídeo descargado)
      (() => {
        const box = document.createElement('div');
        box.className = 'tool tool-step tool-speed';
        box.title = 'Velocidad a la que se mueven las jugadoras y la bola';
        box.innerHTML = '<span class="tool-label">Velocidad</span><span class="step-ctl"><button type="button" aria-label="Más lento">−</button><b></b><button type="button" aria-label="Más rápido">+</button></span>';
        box.querySelector('b').textContent = speedText(vel);
        const [minus, plus] = box.querySelectorAll('button');
        const set = (d) => {
          vel = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, SPEEDS.indexOf(vel) + d))];
          if (playing) { cancelAnimationFrame(playing.raf); playing = null; startPreview(); } else drawTools();
        };
        minus.disabled = vel === SPEEDS[0];
        plus.disabled = vel === SPEEDS[SPEEDS.length - 1];
        minus.onclick = () => set(-1);
        plus.onclick = () => set(1);
        return box;
      })(),
      Object.assign(document.createElement('button'), {
        type: 'button', className: 'tool tool-play' + (playing ? ' active' : ''),
        innerHTML: `<span class="tool-icon">${playing ? '■' : '▶'}</span><span class="tool-label">${playing ? 'Parar' : 'Ver'}</span>`,
        onclick: () => (playing ? stopPreview() : startPreview()),
      }),
      Object.assign(document.createElement('button'), {
        type: 'button', className: 'tool', innerHTML: '<span class="tool-icon">↶</span><span class="tool-label">Deshacer</span>',
        onclick: () => { if (undoList.length) { items = JSON.parse(undoList.pop()); redraw(); } },
      }),
      Object.assign(document.createElement('button'), {
        type: 'button', className: 'tool danger', innerHTML: '<span class="tool-icon">🗑</span><span class="tool-label">Limpiar</span>',
        onclick: () => { if (items.length && confirm('¿Borrar todo el dibujo?')) { snapshot(); items = []; redraw(); } },
      }),
    );
    $('drawHint').textContent = playing ? 'Viendo el movimiento. Pulsa «Parar» para seguir dibujando.' : DRAW_HINTS[tool] ||
      (ARROWS.includes(tool)
        ? (tool === 'drive'
          ? `Dibuja con el dedo el recorrido de la conducción, por ejemplo entre los conos (paso ${step}).`
          : `Arrastra desde el inicio hasta el final de la flecha (paso ${step}). Las flechas del mismo paso se mueven a la vez.`)
        : 'Toca la pista para colocarlo.');
  };

  svg.onpointerdown = (ev) => {
    ev.preventDefault();
    if (playing) return;
    const p = toPoint(ev);
    if (tool === 'setp') {
      const h = hit(p);
      if (h && ARROWS.includes(items[h.i].t)) { snapshot(); items[h.i].p = step; redraw(); }
      return;
    }
    if (tool === 'erase') {
      const h = hit(p);
      if (h) { snapshot(); items.splice(h.i, 1); redraw(); }
      return;
    }
    if (tool === 'mover') {
      const h = hit(p);
      if (h) { snapshot(); drag = { ...h, last: p }; capture(ev); }
      return;
    }
    if (ARROWS.includes(tool)) {
      drag = { preview: { t: tool, x: p.x, y: p.y, x2: p.x, y2: p.y, p: step, ...(tool === 'drive' ? { pts: [[p.x, p.y]] } : {}) } };
      capture(ev);
      return;
    }
    snapshot();
    const it = { t: tool, x: p.x, y: p.y };
    if (tool === 'own' || tool === 'opp') it.n = nextLabel(tool);
    items.push(it);
    redraw();
  };
  svg.onpointermove = (ev) => {
    if (!drag) return;
    const p = toPoint(ev);
    if (drag.preview) {
      const a = drag.preview;
      // conducción: se va guardando el recorrido del dedo
      if (a.pts) { const last = a.pts[a.pts.length - 1]; if (meters(p, { x: last[0], y: last[1] }) > 0.25) a.pts.push([p.x, p.y]); }
      a.x2 = p.x; a.y2 = p.y;
    } else {
      const it = items[drag.i];
      const dx = p.x - drag.last.x, dy = p.y - drag.last.y;
      if (drag.part !== 'b') { it.x = clamp(it.x + dx, 0, 1); it.y = clamp(it.y + dy, 0, 1); }
      if (ARROWS.includes(it.t) && drag.part !== 'a') { it.x2 = clamp(it.x2 + dx, 0, 1); it.y2 = clamp(it.y2 + dy, 0, 1); }
      if (it.pts && it.pts.length > 1) {
        // recorrido a mano: se mueve entero, o solo su principio / su final
        if (drag.part === 'all') it.pts = it.pts.map(([x, y]) => [clamp(x + dx, 0, 1), clamp(y + dy, 0, 1)]);
        else if (drag.part === 'a') it.pts[0] = [it.x, it.y];
        else it.pts[it.pts.length - 1] = [it.x2, it.y2];
      }
      drag.last = p;
    }
    redraw();
  };
  svg.onpointerup = svg.onpointercancel = () => {
    if (drag && drag.preview) {
      const a = drag.preview;
      if (a.pts) {
        a.pts.push([a.x2, a.y2]);
        const P = simplifyPath(a.pts.map(toM));
        a.pts = P.map(([x, y]) => [+(x / 40).toFixed(4), +(y / 20).toFixed(4)]);
        if (a.pts.length < 3) delete a.pts; // casi recta: flecha normal
        if (pathLen(P) > 0.8) { snapshot(); items.push(a); }
      } else if (meters(a, { x: a.x2, y: a.y2 }) > 0.8) { snapshot(); items.push(a); }
    }
    drag = null;
    redraw();
  };

  $('drawCancel').onclick = () => { stopPreview(); dlg.close(); };
  // con movimientos se guarda como "vídeo" (animado); sin movimientos, como imagen
  $('drawOk').onclick = () => { stopPreview(); dlg.close(); onDone({ items, animado: hasMoves({ items }), ...(vel !== 1 ? { vel } : {}) }); };
  drawTools();
  redraw();
  dlg.showModal();
}

// ---------- Conexión con la interfaz (se llama al final de app.js) ----------

function initEntrenos() {
  $('menuNewPlan').onclick = createPlan;
  $('menuLibrary').onclick = () => go('biblioteca');
  $('libNew').onclick = newLibraryExercise;
  $('planAddNew').onclick = addNewPlanExercise;
  $('planAddLib').onclick = pickFromLibrary;
  $('libPickClose').onclick = () => $('dlgLibPick').close();
  $('planStart').onclick = startPlan;
  $('planDup').onclick = duplicatePlan;
  $('planDelete').onclick = deleteCurrentPlan;
  $('planPrint').onclick = () => { const p = findPlan(currentPlanId); if (p) printHtml(planHtml(p)); };
  const field = (id, key) => {
    $(id).oninput = () => {
      const plan = findPlan(currentPlanId);
      if (!plan) return;
      plan[key] = $(id).value;
      savePlan(plan);
      $('planTotal').textContent = `${plan.ejercicios.length} · ${planDuration(plan)} min`;
    };
  };
  field('planFecha', 'fecha');
  field('planHora', 'hora');
  field('planObjetivo', 'objetivo');
  field('planNotas', 'notas');
}
