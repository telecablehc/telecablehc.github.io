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
      ${(ex.dibujo && ex.dibujo.items.length) ? `<div class="draw-thumb">${drawingSvg(ex.dibujo)}</div>` : ''}
      <p class="ex-desc"></p>
    </div>`;
  card.querySelector('.ex-name').textContent = ex.nombre || 'Ejercicio sin nombre';
  card.querySelector('.tipo').textContent = tipoLabel(ex.tipo);
  card.querySelector('.ex-dur').textContent = `${ex.duracion || 0} min${timeText ? ' · ' + timeText : ''}`;
  card.querySelector('.ex-desc').textContent = ex.descripcion || '';
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
    $('exThumb').innerHTML = ex.dibujo.items.length ? drawingSvg(ex.dibujo) : '<p class="hint">Sin dibujo</p>';
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
// Pista de 40 x 20 m. Elementos: {t, x, y, (x2, y2), n}; coordenadas relativas 0–1.

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
  ['erase', '✕', 'Borrar'],
];
const ARROWS = ['run', 'pass', 'drive', 'shot'];
const DRAW_HINTS = {
  mover: 'Arrastra un elemento para moverlo (en las flechas, arrastra un extremo para cambiarlo).',
  erase: 'Toca un elemento para borrarlo.',
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

// Camino ondulado (conducción) entre dos puntos, terminando recto para la punta
function wavePath(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy);
  if (L < 1.2) return `M${x1},${y1} L${x2},${y2}`;
  const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
  const waveLen = L - 0.7, steps = Math.max(8, Math.round(waveLen * 6)), waves = Math.max(2, Math.round(waveLen / 1.1));
  let d = `M${x1},${y1}`;
  for (let i = 1; i <= steps; i++) {
    const s = (i / steps) * waveLen, off = Math.sin((i / steps) * waves * 2 * Math.PI) * 0.3;
    d += ` L${(x1 + ux * s + nx * off).toFixed(2)},${(y1 + uy * s + ny * off).toFixed(2)}`;
  }
  return d + ` L${x2},${y2}`;
}

function itemMarkup(it, id, idx) {
  const X = it.x * 40, Y = it.y * 20;
  const g = (inner) => `<g data-i="${idx}">${inner}</g>`;
  const label = (txt, fill) => `<text x="${X}" y="${Y + 0.3}" font-size="0.8" text-anchor="middle" font-weight="700" fill="${fill}">${escapeHtml(txt || '')}</text>`;
  switch (it.t) {
    case 'own': return g(`<circle cx="${X}" cy="${Y}" r="0.75" fill="#d0102a" stroke="#fff" stroke-width="0.12"/>${label(it.n, '#fff')}`);
    case 'gk': return g(`<circle cx="${X}" cy="${Y}" r="0.75" fill="#f2b705" stroke="#fff" stroke-width="0.12"/>${label('P', '#111')}`);
    case 'opp': return g(`<circle cx="${X}" cy="${Y}" r="0.75" fill="#1f4fa8" stroke="#fff" stroke-width="0.12"/>${label(it.n, '#fff')}`);
    case 'ball': return g(`<circle cx="${X}" cy="${Y}" r="0.32" fill="#ff7a00" stroke="#111" stroke-width="0.08"/>`);
    case 'cone': return g(`<path d="M${X},${Y - 0.6} L${X + 0.5},${Y + 0.4} L${X - 0.5},${Y + 0.4} Z" fill="#ffd400" stroke="#111" stroke-width="0.08"/>`);
    default: {
      const X2 = it.x2 * 40, Y2 = it.y2 * 20;
      const d = it.t === 'drive' ? wavePath(X, Y, X2, Y2) : `M${X},${Y} L${X2},${Y2}`;
      const dash = it.t === 'pass' ? ' stroke-dasharray="0.5 0.35"' : '';
      const width = it.t === 'shot' ? 0.24 : 0.14;
      // línea ancha transparente para que sea fácil de tocar
      return g(`<path d="${d}" stroke="transparent" stroke-width="1.2" fill="none"/>
        <path d="${d}" stroke="#111" stroke-width="${width}" fill="none"${dash} stroke-linecap="round" marker-end="url(#ah${id})"/>`);
    }
  }
}

function drawingSvg(dibujo, preview = null) {
  const id = ++svgSeq;
  const items = [...((dibujo && dibujo.items) || []), ...(preview ? [preview] : [])];
  return `<svg viewBox="-1 -1 42 22" xmlns="http://www.w3.org/2000/svg" class="rink-svg">
    <defs><marker id="ah${id}" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#111"/></marker></defs>
    ${rinkMarkup()}${items.map((it, i) => itemMarkup(it, id, i)).join('')}</svg>`;
}

function openDrawEditor(dibujo, onDone) {
  let items = JSON.parse(JSON.stringify((dibujo && dibujo.items) || []));
  const undoList = [];
  let tool = 'own';
  let drag = null;
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
        if (segDist(p, it, b) < 0.6) return { i, part: 'all' };
      } else if (meters(p, it) < 1) return { i, part: 'all' };
    }
    return null;
  };
  const nextLabel = (t) => String(items.filter((x) => x.t === t).length + 1);

  const redraw = () => {
    const tmp = document.createElement('div');
    tmp.innerHTML = drawingSvg({ items }, drag && drag.preview);
    svg.innerHTML = tmp.firstElementChild.innerHTML;
  };
  const drawTools = () => {
    $('drawTools').replaceChildren(
      ...DRAW_TOOLS.map(([k, icon, label]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `tool tool-${k}` + (tool === k ? ' active' : '');
        b.innerHTML = `<span class="tool-icon">${icon}</span><span class="tool-label">${label}</span>`;
        b.onclick = () => { tool = k; drawTools(); };
        return b;
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
    $('drawHint').textContent = DRAW_HINTS[tool] ||
      (ARROWS.includes(tool) ? 'Arrastra desde el inicio hasta el final de la flecha.' : 'Toca la pista para colocarlo.');
  };

  svg.onpointerdown = (ev) => {
    ev.preventDefault();
    const p = toPoint(ev);
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
      drag = { preview: { t: tool, x: p.x, y: p.y, x2: p.x, y2: p.y } };
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
      drag.preview.x2 = p.x; drag.preview.y2 = p.y;
    } else {
      const it = items[drag.i];
      const dx = p.x - drag.last.x, dy = p.y - drag.last.y;
      if (drag.part !== 'b') { it.x = clamp(it.x + dx, 0, 1); it.y = clamp(it.y + dy, 0, 1); }
      if (ARROWS.includes(it.t) && drag.part !== 'a') { it.x2 = clamp(it.x2 + dx, 0, 1); it.y2 = clamp(it.y2 + dy, 0, 1); }
      drag.last = p;
    }
    redraw();
  };
  svg.onpointerup = svg.onpointercancel = () => {
    if (drag && drag.preview) {
      const a = drag.preview;
      if (meters(a, { x: a.x2, y: a.y2 }) > 0.8) { snapshot(); items.push(a); }
    }
    drag = null;
    redraw();
  };

  $('drawCancel').onclick = () => dlg.close();
  $('drawOk').onclick = () => { dlg.close(); onDone({ items }); };
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
