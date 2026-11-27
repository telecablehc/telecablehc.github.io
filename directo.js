// =============================================================
// Modo espectador ("En directo")
// Cualquier miembro del equipo puede seguir, sin poder cambiar nada, el partido que
// otra persona está registrando en otro dispositivo: marcador, reloj, minutos de cada
// jugadora, faltas, sanciones, eventos y el resumen estadístico completo.
// Los datos salen de la tabla "sesiones" (partido en curso de cada usuario), que se
// sube unos segundos después de cada cambio; el reloj se calcula aquí a partir de la
// hora de arranque, así que corre solo entre una actualización y otra.
// Necesita supabase/directo.sql (para poder leer las sesiones de los compañeros).
// =============================================================

const LIVE_MAX_AGE = 6 * 3600e3;   // sesiones tocadas en las últimas 6 h
const LIVE_LIST_EVERY = 10000;     // en el menú de Partidos, buscar partidos en directo cada 10 s
const LIVE_GAME_EVERY = 2500;      // viendo un partido, refrescar cada 2,5 s
const LIVE_STALE = 90000;          // sin datos nuevos en 90 s con el reloj en marcha → aviso

let liveList = [];                 // [{ usuario, email, datos, actualizado }]
let liveListAt = 0;
let liveListBusy = false;
let liveUser = null;               // usuario cuyo partido se está viendo
let liveRow = null;                // última fila recibida de ese usuario
let liveGone = false;              // el partido ya no está en curso (terminado o borrado)
let liveAt = 0;
let liveBusy = false;
let liveError = '';
let liveDrawnKey = '';             // para no repintar el resumen si no ha cambiado nada
let liveHasEmail = true;           // la columna "email" existe (directo.sql ejecutado)

const liveIsGame = (x) => x && x.version === VERSION && x.mode === 'partido' && isStarted(x);

async function fetchLiveRows(usuario = null) {
  if (typeof sb === 'undefined' || !sb || !cloudUser || !navigator.onLine) return null;
  const since = new Date(Date.now() - LIVE_MAX_AGE).toISOString();
  const query = (cols) => {
    let q = sb.from('sesiones').select(cols).neq('usuario', cloudUser.id).gt('actualizado', since);
    if (usuario) q = q.eq('usuario', usuario);
    return q;
  };
  let { data, error } = await query(liveHasEmail ? 'usuario, email, datos, actualizado' : 'usuario, datos, actualizado');
  if (error && liveHasEmail && /email/.test(error.message || '')) {
    liveHasEmail = false; // falta directo.sql: se sigue sin el nombre de quien registra
    ({ data, error } = await query('usuario, datos, actualizado'));
  }
  if (error) throw error;
  return data.filter((r) => liveIsGame(r.datos));
}

// ---------- Lista de partidos en directo (menú de Partidos) ----------

async function refreshLiveList() {
  if (liveListBusy) return;
  liveListBusy = true;
  liveListAt = Date.now();
  try {
    const rows = await fetchLiveRows();
    if (rows) liveList = rows.sort((a, b) => b.actualizado.localeCompare(a.actualizado));
  } catch {
    // sin conexión o sin permiso: simplemente no se enseña nada
  } finally {
    liveListBusy = false;
    if (route === 'partidos') renderLiveBox();
  }
}

function renderLiveBox() {
  const box = $('menuLive');
  if (!box) return;
  box.hidden = !liveList.length;
  const list = $('menuLiveList');
  list.replaceChildren(...liveList.map((r) => {
    const X = liveSnapshot(r.datos);
    const b = document.createElement('button');
    b.className = 'menu-btn live-card';
    b.innerHTML = `<span class="menu-btn-title"><span class="live-dot"></span> <span class="t"></span></span>
      <span class="menu-btn-sub"></span>`;
    b.querySelector('.t').textContent = (() => { const [a, b2] = homeFirst(X, X.info.team || 'Nosotras', X.info.rival || 'Rival'); return `${a} ${scoreText(X, '–')} ${b2}`; })();
    b.querySelector('.menu-btn-sub').textContent =
      `${partName(X, X.part)} · ${fmt(X.partMs[X.part - 1])}${r.datos.running ? '' : ' (parado)'}` +
      (r.email ? ` · lo registra ${r.email}` : '');
    b.onclick = () => go('directo/' + r.usuario);
    return b;
  }));
}

// ---------- Ver un partido ----------

// Copia del partido con el tiempo en curso ya sumado (como si se hubiera hecho commit ahora)
function liveSnapshot(datos) {
  const X = JSON.parse(JSON.stringify(datos));
  if (X.running) {
    const d = Math.max(0, Date.now() - X.runStart);
    const i = X.part - 1;
    X.partMs[i] += d;
    if (X.poss === 'us') X.possMs[i][0] += d;
    if (X.poss === 'them') X.possMs[i][1] += d;
    X.players.forEach((p) => { if (p.on) p.ms[i] += d; });
    X.running = false;
  }
  return X;
}

function openLive(usuario) {
  if (liveUser !== usuario) {
    liveUser = usuario;
    liveRow = liveList.find((r) => r.usuario === usuario) || null;
    liveGone = false;
    liveError = '';
    liveDrawnKey = '';
  }
  renderLive();
  if (!liveRow || Date.now() - liveAt > 1000) refreshLive();
}

async function refreshLive() {
  if (!liveUser || liveBusy) return;
  liveBusy = true;
  liveAt = Date.now();
  try {
    const rows = await fetchLiveRows(liveUser);
    if (rows) {
      liveError = '';
      if (rows.length) { liveRow = rows[0]; liveGone = false; }
      else if (liveRow) {
        if (!liveGone) scheduleSync(); // ha terminado: traer el partido guardado al historial
        liveGone = true;
      } else liveGone = true;
    } else liveError = navigator.onLine ? '' : 'Sin conexión: se muestran los últimos datos recibidos.';
  } catch (err) {
    liveError = 'No se pueden leer los datos en directo' + (err && err.message ? ` (${err.message})` : '') + '.';
  } finally {
    liveBusy = false;
    if (route === 'directo') renderLive();
  }
}

function renderLive() {
  const head = $('liveHead');
  const body = $('liveBody');
  if (!liveRow) {
    head.innerHTML = `<p class="hint">${liveGone ? 'Este partido ya no está en directo.' : 'Cargando…'}</p>`;
    body.replaceChildren();
    return;
  }
  const e = escapeHtml;
  const D = liveRow.datos;
  const X = liveSnapshot(D);
  const part = X.partMs[X.part - 1];
  const total = sum(X.partMs);
  const [us, them] = homeFirst(X, ...score(X));       // en orden local-visitante (RFEP)
  const [nameL, nameR] = homeFirst(X, X.info.team || 'Nosotras', X.info.rival || 'Rival');
  const fouls = (side) => X.events.filter((ev) => ev.type === 'falta' && ev.side === side && ev.part === X.part).length;
  const age = Date.now() - new Date(liveRow.actualizado).getTime();

  let status;
  if (liveGone) status = '<span class="live-badge done">Terminado</span>';
  else if (D.running) status = '<span class="live-badge on"><span class="live-dot"></span> EN DIRECTO</span>';
  else status = '<span class="live-badge paused">⏸ Reloj parado</span>';

  let rem = '';
  if (X.partLen > 0) {
    const left = X.partLen * 60000 - part;
    rem = left >= 0 ? `Quedan ${fmt(left)}` : `Tiempo cumplido (+${fmt(-left)})`;
  }

  const sanc = X.events.filter((ev) => ev.type === 'sancion' && ev.endAbs == null);
  const notes = [];
  if (liveGone) notes.push('El partido ha terminado: el resumen final aparecerá en el historial cuando se sincronice.');
  if (liveError) notes.push(liveError);
  else if (!liveGone && D.running && age > LIVE_STALE) notes.push(`Sin datos nuevos desde hace ${Math.round(age / 60000) || 1} min: puede que el dispositivo que registra se haya quedado sin conexión.`);

  head.innerHTML = `
    <div class="live-top">${status}
      <span class="live-who">${liveRow.email ? 'Lo registra ' + e(liveRow.email) + ' · ' : ''}actualizado hace ${fmtAgo(age)}</span>
    </div>
    ${notes.map((n) => `<p class="banner info">${e(n)}</p>`).join('')}
    <section class="clock live-clock">
      <div class="clock-info">
        <div class="part">${e(partName(X, X.part))}</div>
        <div class="time">${fmt(part)}</div>
        <div class="sub${rem.startsWith('Tiempo') ? ' over' : ''}">${rem || 'Total ' + fmt(total)}</div>
      </div>
      <div class="score">
        <div class="team">${e(nameL)}</div>
        <div class="goals"><span>${us}</span><span class="dash">–</span><span>${them}</span></div>
        <div class="team">${e(nameR)}</div>
      </div>
      <div class="clock-row">
        <div class="poss"><span class="lbl">Posesión</span>
          <span class="live-pill${X.poss === 'us' ? ' active' : ''}">Nosotras <b>${pct(X.possMs[X.part - 1][0], part)}</b></span>
          <span class="live-pill${X.poss === 'them' ? ' active' : ''}">Rival <b>${pct(X.possMs[X.part - 1][1], part)}</b></span>
        </div>
        <div class="fouls" title="Faltas de equipo en esta parte">FE <b>${homeFirst(X, fouls('nuestra'), fouls('rival'))[0]}</b> · <b>${homeFirst(X, fouls('nuestra'), fouls('rival'))[1]}</b></div>
      </div>
      <div class="chips">${sanc.map((ev) => `<span class="chip ${ev.card}">${ev.side === 'nuestra' ? 'Inferioridad' : 'Superioridad'} · ${e(whoText(X, ev))} <b>${fmt(ev.abs + ev.dur - total)}</b></span>`).join('')}</div>
    </section>`;

  // Jugadoras: se repintan en cada vuelta (los minutos corren)
  const called = rosterOrder(X.players.filter((p) => p.called));
  const pcard = (p) => {
    const stint = Math.max(0, total - p.since);
    return `<div class="card${p.on ? ' on' : ''}"><span class="num">${p.num}</span><span class="name">${e(p.name)}</span>
      <span class="total">${fmt(sum(p.ms))}</span><span class="stint">${total === 0 ? '' : (p.on ? 'En pista ' : 'Descansa ') + fmt(stint)}</span></div>`;
  };
  const on = called.filter((p) => p.on);
  const players = `
    <h2>En pista <span class="count">${on.length}</span></h2>
    <div class="grid live-grid">${on.map(pcard).join('') || '<p class="hint">Nadie en pista.</p>'}</div>
    <h2>Banquillo</h2>
    <div class="grid live-grid">${called.filter((p) => !p.on).map(pcard).join('')}</div>`;

  // Eventos y resumen: solo cuando llegan datos nuevos (o cada 10 s, para los minutos)
  const key = liveRow.actualizado + '|' + Math.floor(Date.now() / 10000);
  if (key !== liveDrawnKey || !body.firstChild) {
    liveDrawnKey = key;
    const evs = [...X.events].reverse().map((ev) =>
      `<div class="ev ev-${ev.type} ev-${ev.side}"><span class="ev-time">${when(ev.part, ev.t)}</span><span class="ev-text">${e(describe(X, ev))}</span></div>`).join('');
    body.innerHTML = `<div id="livePlayers">${players}</div>
      <h2>Eventos</h2><div class="live-events">${evs || '<p class="hint">Aún no hay eventos.</p>'}</div>
      <h2>Resumen estadístico</h2><div class="res-body live-summary">${summaryHtml(X)}</div>`;
  } else {
    $('livePlayers').innerHTML = players;
  }
}

function fmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

// Llamada desde tick() (4 veces por segundo)
function liveTick() {
  if (route === 'partidos' && Date.now() - liveListAt > LIVE_LIST_EVERY) refreshLiveList();
  if (route === 'directo') {
    if (Date.now() - liveAt > LIVE_GAME_EVERY) refreshLive();
    if (!tick.liveFrame || Date.now() - tick.liveFrame > 900) { tick.liveFrame = Date.now(); renderLive(); }
  }
}
