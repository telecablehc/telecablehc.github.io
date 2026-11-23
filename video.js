// AppHóquei — Análisis de vídeo
// 1) Marcar acciones en el vídeo (con su tiempo) y saltar a ellas, con filtros.
// 2) Clips: tramos del vídeo (inicio–fin) organizados por tema; se pueden ver y descargar.
// 3) Dibujar sobre el vídeo (flechas, líneas, círculos, lápiz). Al verlo, el vídeo se para en cada dibujo.
//
// Fuentes:
// - Archivo del tablet/ordenador: todo funciona. El archivo NO se sube a la nube (es muy grande):
//   en cada sesión se vuelve a elegir; las marcas, clips y dibujos sí se sincronizan.
// - Enlace de tiivii (p. ej. https://kennicut.tiivii.com/player/2204): el vídeo es público y se reproduce
//   dentro de la app (hls.js), con todo como un archivo; solo se guarda el enlace (se sincroniza).
// - OK Liga TV: la plataforma no deja que otra app controle su vídeo. Se guarda el enlace y se usa
//   un cronómetro sincronizado a mano para marcar; ver/dibujar/descargar clips necesita el archivo.
// Usa funciones de app.js / entrenos.js solo en tiempo de ejecución.
'use strict';

const KEY_VIDEOS = 'hoquei.videos';
const MARK_TYPES = [
  ['golFavor', 'Gol a favor', '#1f9d55'], ['golContra', 'Gol en contra', '#d64545'],
  ['remate', 'Remate', '#2f6fdb'], ['ocasion', 'Ocasión', '#7b3fe4'],
  ['perdida', 'Pérdida', '#e07b00'], ['recuperacion', 'Recuperación', '#14a3a3'],
  ['falta', 'Falta', '#8a6d3b'], ['bolaParada', 'Bola parada', '#b8860b'],
  ['defensa', 'Defensa', '#5f7d8c'], ['otro', 'Otro', '#888888'],
];
const markType = (k) => MARK_TYPES.find((m) => m[0] === k) || ['otro', 'Otro', '#888'];

// ---------- Teclados (botones de "Marcar acción") ----------
// Cada análisis lleva su propio teclado ({nombre, botones:[{k, label, color}]}); si no tiene, el estándar.
// Los teclados se pueden guardar con un nombre (biblioteca, se sincroniza) para elegirlos en otro partido.
// Cada acción guarda su nombre y color, así no cambia aunque luego se cambie el teclado.
const KEY_KEYBOARDS = 'hoquei.teclados';
const STD_KEYBOARD = { nombre: 'Estándar', botones: MARK_TYPES.map(([k, label, color]) => ({ k, label, color })) };
const KB_COLORS = ['#1f9d55', '#d64545', '#2f6fdb', '#7b3fe4', '#e07b00', '#14a3a3', '#8a6d3b', '#b8860b', '#5f7d8c', '#e83e8c', '#20c997', '#888888'];
const loadKeyboards = () => load(KEY_KEYBOARDS, []);
const keyboardOf = (v) => (v && v.teclado && v.teclado.botones.length ? v.teclado : STD_KEYBOARD);
const STD_JSON = JSON.stringify(STD_KEYBOARD.botones);
const isStdKb = (v) => !v || !v.teclado || (!v.tecladoId && JSON.stringify(v.teclado.botones) === STD_JSON);
// Con el teclado estándar, estas acciones pueden sumar al marcador y la estadística del partido
const STAT_MARKS = ['golFavor', 'golContra', 'falta', 'bolaParada'];
const feedsStats = (v) => !!(v && v.alimentar && isStdKb(v) && v.partido);
const copyKb = (kb) => JSON.parse(JSON.stringify({ nombre: kb.nombre, botones: kb.botones }));

// [clave, nombre, color] de una acción (dibujos aparte)
function markInfo(v, m) {
  if (m.dibujo) return ['dibujos', '✏️ Dibujo', '#555555'];
  const b = keyboardOf(v).botones.find((x) => x.k === m.tipo) || STD_KEYBOARD.botones.find((x) => x.k === m.tipo);
  return [m.tipo, m.label || (b && b.label) || 'Otro', m.color || (b && b.color) || '#888888'];
}
const PRE_ROLL = 5;   // al saltar a una acción, se empieza unos segundos antes
const POST_ROLL = 3;  // en "ver todas", se sigue unos segundos después
const DRAW_HOLD = 3;  // segundos que el vídeo se queda parado en un dibujo
const DRAW_COLORS = ['#ff3b30', '#ffd60a', '#ffffff', '#0a84ff', '#30d158'];

let currentVideoId = null;
let vaTab = 'marks';
let vaFilter = { tipo: 'todos', num: 'todas', tema: 'todos' };
const loadedFiles = {}; // id del análisis → { url, name, size } o { url, stream: true } (solo en esta sesión)
const streamState = {}; // id del análisis → { loading, error } al buscar el vídeo de un enlace
let hls = null;         // reproductor HLS (enlaces de tiivii)
let vaClock = { running: false, base: 0, since: 0 }; // cronómetro (OK Liga TV)
let vaClipStart = null;  // inicio de un clip que se está creando
let vaPlaylist = null;   // reproducción de una lista de tramos
let vaHold = null;       // pausa automática en un dibujo
let vaLastTime = 0;
let vaDrawing = null;    // edición de un dibujo sobre el vídeo

// ---------- Datos ----------

const loadVideos = () => load(KEY_VIDEOS, []);
const findVideo = (id) => loadVideos().find((v) => v.id === id) || null;
const saveVideo = (v) => upsert(KEY_VIDEOS, 'video', v);
const curVideo = () => findVideo(currentVideoId);
// ¿El vídeo se ve dentro de la app? (archivo o enlace de tiivii; OK Liga TV no)
const playsInApp = (v) => v.fuente === 'archivo' || v.fuente === 'tiivii';
const SOURCE_NAME = { archivo: 'Archivo de vídeo', tiivii: 'Enlace (tiivii)', okliga: 'OK Liga TV' };
const notLoaded = (v) => alert(v.fuente === 'tiivii' ? 'El vídeo del enlace aún no se ha cargado.' : 'Primero elige el archivo de vídeo.');

// ---------- Enlaces de tiivii ----------
// https://<club>.tiivii.com/player/<n> → página pública del reproductor → enlace del vídeo (.m3u8)
const TIIVII_RE = /^https:\/\/([a-z0-9-]+)\.tiivii\.(?:com|tv)\/(?:[a-z]{2}\/)?(?:player|videodetail)\/(\d+)/i;

async function resolveTiivii(link) {
  const m = String(link || '').match(TIIVII_RE);
  if (!m) throw new Error('El enlace no es de tiivii (https://….tiivii.com/player/…).');
  const res = await fetch(`https://streamer-cdn.ott.tiivii.com/v1/player/${m[1].toLowerCase()}/${m[2]}?detail=true`);
  if (!res.ok) throw new Error(`No se ha podido abrir ese enlace en tiivii (error ${res.status}). Comprueba que es correcto y que el vídeo se ve sin iniciar sesión.`);
  const html = await res.text();
  const src = (html.match(/videoURLoriginal\s*=\s*"(https:[^"]+\.m3u8[^"]*)"/) || html.match(/"(https:\/\/[^"]+-vod-[^"]+\.m3u8[^"]*)"/) || [])[1];
  if (!src) throw new Error('No se encuentra el vídeo en ese enlace (¿pide iniciar sesión o aún no está publicado?).');
  return src;
}

async function loadStream(v) {
  if (streamState[v.id] && streamState[v.id].loading) return;
  streamState[v.id] = { loading: true };
  renderAnalysis();
  try {
    const url = await resolveTiivii(v.url);
    loadedFiles[v.id] = { url, stream: true, link: v.url };
    streamState[v.id] = {};
  } catch (err) {
    streamState[v.id] = { error: navigator.onLine ? err.message : 'Sin conexión: el vídeo del enlace necesita internet.' };
  }
  if (curVideo() && curVideo().id === v.id) renderAnalysis();
}

// Pone en el reproductor un archivo (blob) o un vídeo HLS
function attachSource(loaded) {
  const video = vid();
  if (video.dataset.src === loaded.url) return;
  if (hls) { hls.destroy(); hls = null; }
  video.dataset.src = loaded.url;
  if (!loaded.stream) { video.removeAttribute('crossorigin'); video.src = loaded.url; return; }
  video.crossOrigin = 'anonymous'; // permite grabar clips del vídeo (el servidor lo autoriza)
  if (window.Hls && Hls.isSupported()) {
    hls = new Hls({ maxBufferLength: 30 });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else toast('Error al reproducir el vídeo del enlace');
    });
    hls.loadSource(loaded.url);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = loaded.url; // Safari (iPhone / iPad) reproduce HLS directamente
  } else {
    toast('Este navegador no puede reproducir el vídeo del enlace');
  }
}

function updateVideo(fn) {
  const v = curVideo();
  if (!v) return;
  fn(v);
  saveVideo(v);
  renderAnalysis();
}

const playerName = (num) => {
  const p = PLAYERS.find((x) => x.num === num);
  return p ? `#${p.num} ${p.name}` : '';
};

// ---------- Lista de análisis ----------

function renderVideoList() {
  const list = loadVideos().sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || (b.creado || '').localeCompare(a.creado || ''));
  const box = $('vList');
  if (!list.length) {
    box.innerHTML = '<p class="hint">Todavía no hay análisis. Crea uno con «Nuevo análisis».</p>';
    return;
  }
  box.replaceChildren(...list.map((v) => {
    const b = document.createElement('button');
    b.className = 'fixture';
    b.innerHTML = '<span class="fx-j"></span><span class="fx-main"><b></b><small></small></span><span class="fx-state"></span>';
    b.querySelector('.fx-j').textContent = { okliga: '📺', tiivii: '🔗' }[v.fuente] || '🎞️';
    b.querySelector('b').textContent = v.titulo || 'Análisis';
    const fecha = v.fecha ? v.fecha.split('-').reverse().join('/') : '';
    b.querySelector('small').textContent = `${fecha}${fecha ? ' · ' : ''}${{ okliga: 'OK Liga TV', tiivii: 'Enlace (tiivii)' }[v.fuente] || 'Archivo'}`;
    const nDraw = v.marcas.filter((m) => m.dibujo).length;
    b.querySelector('.fx-state').textContent =
      `${v.marcas.length - nDraw} acciones · ${v.clips.length} clips${nDraw ? ` · ${nDraw} dibujos` : ''}`;
    b.onclick = () => go('analisis/' + v.id);
    return b;
  }));
}

// Diálogo "Nuevo análisis" / "Editar"
function openVideoDialog(existing = null) {
  const v = existing ? JSON.parse(JSON.stringify(existing)) : {
    id: uid(), titulo: '', fecha: today(), fuente: 'archivo', url: '', partido: '', marcas: [], clips: [],
    creado: new Date().toISOString(),
  };
  $('dvTitle').textContent = existing ? 'Datos del análisis' : 'Nuevo análisis';
  $('dvTitulo').value = v.titulo;
  $('dvFecha').value = v.fecha || '';
  $('dvUrl').value = v.url || '';
  $('dvDelete').hidden = !existing;
  // Teclado (solo al crear; después se cambia en la pantalla del análisis).
  // Viene elegido el del último análisis.
  $('dvKbWrap').hidden = !!existing;
  if (!existing) {
    const saved = loadKeyboards().sort((a, b) => a.nombre.localeCompare(b.nombre));
    $('dvTeclado').replaceChildren(new Option('Estándar', ''), ...saved.map((kb) => new Option(kb.nombre, kb.id)));
    const last = loadVideos().sort((a, b) => (b.creado || '').localeCompare(a.creado || ''))[0];
    $('dvTeclado').value = last && last.tecladoId && saved.some((k) => k.id === last.tecladoId) ? last.tecladoId : '';
  }
  $('dvPartido').replaceChildren(
    new Option('— Ninguno —', ''),
    ...CALENDARIO.map((f) => new Option(`J${f.jornada} · ${f.local ? '🏠' : '✈️'} ${f.rival}`, f.id)),
  );
  $('dvPartido').value = v.partido || '';
  $('dvPartido').onchange = () => {
    const f = CALENDARIO.find((x) => x.id === $('dvPartido').value);
    if (!f) return;
    if (!$('dvTitulo').value.trim()) $('dvTitulo').value = `J${f.jornada} · ${f.local ? 'Telecable HC – ' + f.rival : f.rival + ' – Telecable HC'}`;
    if (f.fecha) $('dvFecha').value = f.fecha;
  };
  const drawFuente = () => {
    $('dvFuente').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.f === v.fuente));
    $('dvUrlWrap').hidden = v.fuente === 'archivo';
    $('dvUrlLabel').textContent = v.fuente === 'tiivii' ? 'Enlace del vídeo en tiivii (uno por partido)' : 'Enlace del partido en OK Liga TV';
    $('dvUrl').placeholder = v.fuente === 'tiivii' ? 'https://kennicut.tiivii.com/player/…' : 'https://www.okliga.tv/…';
  };
  $('dvFuente').querySelectorAll('button').forEach((b) => (b.onclick = () => { v.fuente = b.dataset.f; drawFuente(); }));
  drawFuente();
  $('dvCancel').onclick = () => $('dlgVideo').close();
  $('dvDelete').onclick = () => {
    if (!confirm('¿Borrar este análisis con todas sus acciones, clips y dibujos? El archivo de vídeo no se borra, y lo sumado al marcador del partido tampoco.')) return;
    remove(KEY_VIDEOS, 'video', v.id);
    $('dlgVideo').close();
    go('video');
  };
  $('dvOk').onclick = () => {
    v.titulo = $('dvTitulo').value.trim() || 'Análisis';
    v.fecha = $('dvFecha').value;
    v.partido = $('dvPartido').value;
    v.url = $('dvUrl').value.trim();
    if (!existing) {
      const kb = loadKeyboards().find((k) => k.id === $('dvTeclado').value);
      v.teclado = kb ? copyKb(kb) : null;
      v.tecladoId = kb ? kb.id : null;
    }
    if (v.fuente === 'okliga' && v.url && !/^https:\/\/(www\.)?okliga\.tv\//i.test(v.url)) {
      alert('El enlace debe ser de OK Liga TV (https://www.okliga.tv/…).');
      return;
    }
    if (v.fuente === 'tiivii' && !TIIVII_RE.test(v.url)) {
      alert('Pega el enlace del vídeo en tiivii, por ejemplo https://kennicut.tiivii.com/player/2204');
      return;
    }
    // si cambia el enlace o la fuente, se vuelve a cargar el vídeo
    const lf = loadedFiles[v.id];
    if (lf && (lf.stream ? v.fuente !== 'tiivii' || lf.link !== v.url : v.fuente !== 'archivo')) { delete loadedFiles[v.id]; delete streamState[v.id]; }
    saveVideo(v);
    $('dlgVideo').close();
    if (existing) renderAnalysis(); else go('analisis/' + v.id);
  };
  $('dlgVideo').showModal();
}

// ---------- Pantalla de un análisis ----------

const vid = () => $('vaVideo');

// Tiempo actual (del vídeo o del cronómetro de OK Liga TV), en segundos
function vaNow() {
  const v = curVideo();
  if (v && playsInApp(v)) return vid().currentTime || 0;
  return vaClock.base + (vaClock.running ? (performance.now() - vaClock.since) / 1000 : 0);
}

function fmtVT(sec) {
  sec = Math.max(0, sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function parseVT(text) {
  const parts = String(text || '').trim().split(':').map((x) => x.trim());
  if (!parts.length || parts.some((x) => !/^\d+$/.test(x)) || parts.length > 3) return null;
  return parts.reduce((acc, x) => acc * 60 + +x, 0);
}

function renderAnalysis() {
  const v = curVideo();
  if (!v) { location.replace('#video'); return; }
  const file = playsInApp(v);

  // Cabecera
  const fecha = v.fecha ? v.fecha.split('-').reverse().join('/') : '';
  $('vaHead').innerHTML = '<div class="va-title"><b></b><small></small></div><button class="ghost small">Editar datos</button>';
  $('vaHead').querySelector('b').textContent = v.titulo;
  $('vaHead').querySelector('small').textContent = `${fecha}${fecha ? ' · ' : ''}${SOURCE_NAME[v.fuente] || 'Archivo de vídeo'}`;
  $('vaHead').querySelector('button').onclick = () => openVideoDialog(v);

  // Fuente
  $('vaFileBox').hidden = !file;
  $('vaTvBox').hidden = file;
  const loaded = loadedFiles[v.id];
  const stream = v.fuente === 'tiivii';
  $('vaStreamBox').hidden = !stream || !!loaded;
  if (stream && !loaded) {
    const st = streamState[v.id] || {};
    if (!st.loading && !st.error) setTimeout(() => loadStream(v));
    $('vaStreamText').textContent = st.error ? '⚠️ ' + st.error : 'Cargando el vídeo del enlace…';
    $('vaStreamRetry').hidden = !st.error;
    $('vaStreamRetry').onclick = () => { delete streamState[v.id]; loadStream(v); };
    $('vaStreamLink').href = v.url || '#';
  }
  if (file) {
    $('vaPickFile').hidden = !!loaded || stream;
    $('vaStage').hidden = !loaded;
    $('vaControls').hidden = !loaded;
    $('vaPickText').textContent = v.archivo
      ? `Elige el archivo «${v.archivo.nombre}» (${(v.archivo.tam / 1048576).toFixed(0)} MB). El vídeo no se sube a la nube; solo las marcas, clips y dibujos.`
      : 'Elige el archivo de vídeo del partido o del entreno. El vídeo no se sube a la nube; solo las marcas, clips y dibujos.';
    if (loaded) attachSource(loaded);
  } else {
    $('vaTvLink').href = v.url || 'https://www.okliga.tv/home';
    $('vaTvLink').textContent = v.url ? 'Abrir el partido en OK Liga TV ↗' : 'Abrir OK Liga TV ↗ (añade el enlace en «Editar datos»)';
  }
  $('vaDraw').hidden = !file;
  $('vaAutoPause').parentElement.hidden = !file;
  $('vaDraw').disabled = $('vaClip').disabled = file && !loaded;

  // Botones de acciones (teclado de este análisis)
  const kb = keyboardOf(v);
  $('vaKbName').textContent = kb.nombre || 'Sin nombre';
  $('vaTags').replaceChildren(...kb.botones.map(({ k, label, color }) => {
    const b = document.createElement('button');
    b.className = 'va-tag';
    b.style.setProperty('--tc', color);
    b.textContent = label;
    b.disabled = file && !loaded;
    b.onclick = () => addMark(k);
    return b;
  }));

  renderStatBox(v);
  renderClipBar();
  $('vaTabMarks').classList.toggle('active', vaTab === 'marks');
  $('vaTabClips').classList.toggle('active', vaTab === 'clips');
  if (vaTab === 'marks') renderMarks(v); else renderClips(v);
  vaTick();
}

// ---------- 1) Acciones ----------

// Opción "Sumar al marcador y la estadística del partido" (solo con el teclado estándar)
function renderStatBox(v) {
  const std = isStdKb(v);
  $('vaStatBox').hidden = !std;
  if (!std) return;
  const on = feedsStats(v);
  $('vaStats').checked = on;
  $('vaStatBox').classList.toggle('on', on);
  const sc = v.partido ? videoStatScore(v.partido) : null;
  $('vaStatInfo').textContent = !v.partido
    ? 'Para usarlo, une el análisis a una jornada en «Editar datos».'
    : on
      ? `Gol a favor, Gol en contra, Falta y Bola parada se suman al partido (se pide la parte y el minuto). Marcador guardado: ${sc ? sc.score.join('-') : '0-0'}.`
      : 'Desactivado: las acciones solo quedan en el análisis.';
}

function toggleStats() {
  const v = curVideo();
  const want = $('vaStats').checked;
  if (want && !v.partido) {
    $('vaStats').checked = false;
    alert('Para sumar al marcador, une primero el análisis a una jornada del calendario en «Editar datos».');
    return;
  }
  if (want) {
    const sc = videoStatScore(v.partido);
    if (sc && sc.events && !confirm(`Este partido ya tiene datos guardados (marcador ${sc.score.join('-')}). Las acciones que marques se sumarán a ellos: si ya se apuntaron en directo, saldrán dobles. ¿Activar?`)) {
      $('vaStats').checked = false;
      return;
    }
  }
  updateVideo((x) => (x.alimentar = want));
  toast(want ? 'Las acciones se sumarán al marcador del partido' : 'Las acciones ya no se suman al partido');
}

// Preguntas para una acción que suma al partido. Devuelve el evento para app.js (addVideoStat) o null.
function statFields(tipo) {
  const parts = videoStatParts(curVideo().partido);
  const when = [
    { key: 'part', type: 'seg', label: 'Parte del partido', options: parts },
    { key: 'min', type: 'num', label: 'Minuto de la parte en el marcador (minutos:segundos)', required: true, placeholder: '12:30' },
  ];
  const nota = { key: 'nota', type: 'num', label: 'Nota (opcional)', placeholder: 'Ej.: salida por la izquierda' };
  const rival = (show) => ({ key: 'rival', type: 'num', label: 'Nº de la rival (opcional)', show });
  switch (tipo) {
    case 'golFavor': return [nota, ...when, { key: 'num', type: 'player', label: '¿Quién marca?', all: true }];
    case 'golContra': return [nota, ...when, rival(), { key: 'num', type: 'player', label: 'Jugadora (opcional, solo para el análisis)', all: true, optional: true }];
    case 'falta': return [
      { key: 'team', type: 'seg', label: 'Falta de', options: [['nuestra', 'Nuestra'], ['rival', 'Rival']] },
      nota, ...when, { key: 'num', type: 'player', label: '¿Quién comete la falta?', all: true, show: (x) => x.team === 'nuestra' }];
    case 'bolaParada': return [
      { key: 'kind', type: 'seg', label: 'Tipo', options: [['fd', 'Falta directa'], ['penalti', 'Penalti']] },
      { key: 'side', type: 'seg', label: 'Para', options: [['favor', 'A favor'], ['contra', 'En contra']] },
      { key: 'res', type: 'seg', label: 'Resultado', options: [['gol', 'Gol'], ['fallo', 'Fallado / parado']] },
      nota, ...when, rival((x) => x.side === 'contra'),
      { key: 'num', type: 'player', label: 'Lanzadora', all: true, show: (x) => x.side === 'favor' }];
  }
  return null;
}

function statEvent(tipo, a) {
  switch (tipo) {
    case 'golFavor': return { type: 'golFavor', num: a.num };
    case 'golContra': return { type: 'golContra', rival: a.rival };
    case 'falta': return a.team === 'nuestra' ? { type: 'faltaNuestra', num: a.num } : { type: 'faltaRival' };
    case 'bolaParada': return { type: 'bp', kind: a.kind, side: a.side, res: a.res, num: a.side === 'favor' ? a.num : null, rival: a.rival };
  }
  return null;
}

async function addMark(tipo) {
  const t = vaNow();
  const btn = keyboardOf(curVideo()).botones.find((b) => b.k === tipo) || { label: markType(tipo)[1], color: markType(tipo)[2] };
  const label = btn.label;
  if (feedsStats(curVideo()) && STAT_MARKS.includes(tipo)) return addStatMark(tipo, t, btn);
  // la nota va primero: al tocar la jugadora se guarda directamente
  const ans = await ask(`${label} · ${fmtVT(t)}`, [
    { key: 'nota', type: 'num', label: 'Nota (opcional, escríbela antes de elegir la jugadora)', placeholder: 'Ej.: salida por la izquierda' },
    { key: 'num', type: 'player', label: 'Jugadora', all: true, optional: true },
  ]);
  if (!ans) return;
  updateVideo((x) => {
    x.marcas.push({ id: uid(), t, tipo, label, color: btn.color, num: ans.num || null, nota: ans.nota || '' });
    x.marcas.sort((a, b) => a.t - b.t);
  });
  toast(`${label} marcado en ${fmtVT(t)}`);
}

// Acción que además suma al marcador y la estadística del partido
async function addStatMark(tipo, t, btn) {
  const v = curVideo();
  const parts = videoStatParts(v.partido);
  const ans = await ask(`${btn.label} · ${fmtVT(t)} · suma al partido`, statFields(tipo),
    { part: parts.some((p) => p[0] === v.ultimaParte) ? v.ultimaParte : 1, team: 'nuestra', kind: 'fd', side: 'favor', res: 'gol' });
  if (!ans) return;
  const res = addVideoStat(v.partido, { ...statEvent(tipo, ans), part: ans.part, min: ans.min });
  if (typeof res === 'string') { alert(res); return; }
  updateVideo((x) => {
    x.ultimaParte = res.part;
    x.marcas.push({ id: uid(), t, tipo, label: btn.label, color: btn.color, num: ans.num || null, nota: ans.nota || '',
      stat: { rec: res.rec, ids: res.ids, part: res.part, ms: res.t } });
    x.marcas.sort((a, b) => a.t - b.t);
  });
  toast(`Sumado al partido: ${res.txt}`);
}

// Tras corregir un partido guardado (app.js), las acciones del vídeo unidas a sus eventos se ponen al día
function syncVideoStats(orig, X) {
  loadVideos().forEach((v) => {
    let changed = false;
    v.marcas.forEach((m) => {
      if (!m.stat || m.stat.rec !== X.id) return;
      const main = m.stat.ids.map((id) => X.events.find((e) => e.id === id)).filter((e) => e && !e.bpId);
      if (!main.length) { delete m.stat; changed = true; return; }
      const ids = [...main, ...X.events.filter((e) => e.bpId && main.some((x) => x.id === e.bpId))].map((e) => e.id);
      if (ids.join() !== m.stat.ids.join() || main[0].part !== m.stat.part || main[0].t !== m.stat.ms) {
        m.stat = { ...m.stat, ids, part: main[0].part, ms: main[0].t };
        changed = true;
      }
    });
    if (changed) saveVideo(v);
  });
}

function filteredMarks(v) {
  return v.marcas.filter((m) =>
    (vaFilter.tipo === 'todos' || (vaFilter.tipo === 'dibujos' ? !!m.dibujo : m.tipo === vaFilter.tipo && !m.dibujo)) &&
    (vaFilter.num === 'todas' || m.num === vaFilter.num));
}

function chip(label, active, onclick, color) {
  const b = document.createElement('button');
  b.className = 'chip-btn' + (active ? ' active' : '');
  if (color) b.style.setProperty('--tc', color);
  b.textContent = label;
  b.onclick = onclick;
  return b;
}

function renderMarks(v) {
  // un filtro por cada tipo de acción que haya (en el orden del teclado; después el resto y los dibujos)
  const kinds = new Map();
  const order = keyboardOf(v).botones.map((b) => b.k);
  v.marcas.forEach((m) => {
    const [k, label, color] = markInfo(v, m);
    const e = kinds.get(k) || { label, color, n: 0 };
    e.n++;
    kinds.set(k, e);
  });
  const rank = (k) => (k === 'dibujos' ? 9999 : order.includes(k) ? order.indexOf(k) : 999);
  const players = [...new Set(v.marcas.map((m) => m.num).filter(Boolean))];
  $('vaFilters').replaceChildren(
    chip(`Todas (${v.marcas.length})`, vaFilter.tipo === 'todos', () => { vaFilter.tipo = 'todos'; renderAnalysis(); }),
    ...[...kinds.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(([k, e]) =>
      chip(`${e.label} (${e.n})`, vaFilter.tipo === k, () => { vaFilter.tipo = k; renderAnalysis(); }, k === 'dibujos' ? null : e.color)),
    ...(players.length ? [(() => {
      const sel = document.createElement('select');
      sel.className = 'ghost';
      sel.append(new Option('Todas las jugadoras', 'todas'), ...rosterOrder(PLAYERS.filter((p) => players.includes(p.num))).map((p) => new Option(`#${p.num} ${p.name}`, p.num)));
      sel.value = String(vaFilter.num);
      sel.onchange = () => { vaFilter.num = sel.value === 'todas' ? 'todas' : +sel.value; renderAnalysis(); };
      return sel;
    })()] : []),
  );

  const list = filteredMarks(v);
  const box = $('vaList');
  if (!v.marcas.length) {
    box.innerHTML = `<p class="hint">${playsInApp(v) ? 'Reproduce el vídeo y pulsa un botón de «Marcar acción» cuando ocurra.' : 'Pon en marcha el cronómetro a la vez que el vídeo de OK Liga TV y pulsa un botón de «Marcar acción» cuando ocurra.'}</p>`;
    return;
  }
  const playAll = document.createElement('button');
  playAll.className = 'ghost add-past';
  playAll.textContent = `▶ Ver seguidas (${list.length})`;
  playAll.hidden = !playsInApp(v) || !loadedFiles[v.id] || !list.length;
  playAll.onclick = () => playSegments(list.map((m) => [Math.max(0, m.t - PRE_ROLL), m.t + (m.dibujo ? 0.1 : POST_ROLL)]), false, `${list.length} acciones seguidas`);
  box.replaceChildren(playAll, ...list.map((m) => {
    const [, label, color] = markInfo(v, m);
    const row = document.createElement('div');
    row.className = 'va-mark';
    row.style.setProperty('--tc', color);
    row.innerHTML = '<button class="va-mark-go"><b class="va-t"></b><span class="va-type"></span><span class="va-who"></span><small class="va-note"></small></button><button class="ghost small danger">Borrar</button>';
    row.querySelector('.va-t').textContent = fmtVT(m.t);
    row.querySelector('.va-type').textContent = label;
    row.querySelector('.va-who').textContent = m.num ? playerName(m.num) : '';
    row.querySelector('.va-note').textContent = m.nota || '';
    if (m.stat) {
      const s = document.createElement('small');
      s.className = 'va-statmark';
      s.textContent = `📊 En el marcador · ${m.stat.part}ªP ${fmt(m.stat.ms)}`;
      row.querySelector('.va-mark-go').append(s);
    }
    row.querySelector('.va-mark-go').onclick = () => jumpTo(m.dibujo ? m.t : m.t - PRE_ROLL, m);
    row.querySelector('.danger').onclick = () => {
      if (!confirm(m.stat ? '¿Borrar esta marca? También se quita del marcador y la estadística del partido.' : '¿Borrar esta marca?')) return;
      if (m.stat) { const err = removeVideoStat(m.stat); if (err) { alert(err); return; } }
      updateVideo((x) => (x.marcas = x.marcas.filter((y) => y.id !== m.id)));
    };
    return row;
  }));
}

function jumpTo(t, mark = null) {
  const v = curVideo();
  t = Math.max(0, t);
  if (!playsInApp(v)) {
    vaClock = { running: false, base: t, since: 0 };
    vaTick();
    alert(`Ve al minuto ${fmtVT(t)} en OK Liga TV y pulsa ▶ en los dos a la vez.`);
    return;
  }
  if (!loadedFiles[v.id]) { notLoaded(v); return; }
  stopPlaylist();
  vid().currentTime = t;
  if (mark && mark.dibujo) { vid().pause(); showOverlay(mark.dibujo); }
  else vid().play();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Reproduce varios tramos seguidos [[inicio, fin], …]
function playSegments(segs, loop = false, label = '') {
  if (!segs.length) return;
  vaPlaylist = { segs, i: 0, loop, label };
  vid().currentTime = segs[0][0];
  vid().play();
  renderPlayBar();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Termina la reproducción de un clip / de las acciones seguidas y vuelve al partido normal
function stopPlaylist() {
  if (!vaPlaylist) return;
  vaPlaylist = null;
  renderPlayBar();
}

// Barra "Viendo el clip … [Volver al partido]" mientras se reproduce una lista de tramos
function renderPlayBar() {
  const bar = $('vaPlayBar');
  if (!bar) return;
  bar.hidden = !vaPlaylist;
  if (!vaPlaylist) { bar.replaceChildren(); return; }
  const txt = document.createElement('span');
  txt.textContent = `▶ Viendo ${vaPlaylist.label || 'un tramo'}`;
  const exit = Object.assign(document.createElement('button'), { className: 'primary small-btn', textContent: '✕ Volver al partido' });
  exit.onclick = () => { stopPlaylist(); toast('Ya puedes ver el partido entero'); };
  bar.replaceChildren(txt, exit);
}

// Si se va (con la barra, ±5 s…) a un momento fuera del tramo que se está viendo, se deja la lista
function userSeek(t) {
  const video = vid();
  if (vaPlaylist) {
    const [a, b] = vaPlaylist.segs[vaPlaylist.i];
    if (t < a - 0.5 || t > b) stopPlaylist();
  }
  video.currentTime = t;
}

// ---------- 2) Clips ----------

function renderClipBar() {
  const bar = $('vaClipBar');
  if (vaClipStart == null) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.innerHTML = `<span>✂️ Clip desde <b>${fmtVT(vaClipStart)}</b>. Avanza hasta el final y pulsa «Marcar fin».</span>
    <span class="row-btns"><button class="primary small-btn" id="vaClipEnd">Marcar fin</button><button class="ghost small" id="vaClipCancel">Cancelar</button></span>`;
  $('vaClipEnd').onclick = finishClip;
  $('vaClipCancel').onclick = () => { vaClipStart = null; renderClipBar(); };
}

function startClip() {
  vaClipStart = vaNow();
  renderClipBar();
  toast(`Inicio del clip: ${fmtVT(vaClipStart)}`);
}

async function finishClip() {
  const end = vaNow();
  if (end - vaClipStart < 1) { alert('El final del clip tiene que ser después del inicio (al menos 1 segundo).'); return; }
  const v = curVideo();
  const temas = [...new Set(v.clips.map((c) => c.tema).filter(Boolean))];
  const ans = await ask(`Clip ${fmtVT(vaClipStart)} – ${fmtVT(end)}`, [
    { key: 'nombre', type: 'num', label: 'Nombre del clip', required: true, placeholder: 'Ej.: Salida de presión 2x1' },
    ...(temas.length ? [{ key: 'temaSel', type: 'seg', label: 'Tema', options: [...temas.map((t) => [t, t]), ['__nuevo', '＋ Otro tema']] }] : []),
    { key: 'tema', type: 'num', label: temas.length ? 'Nuevo tema (si eliges «Otro tema»)' : 'Tema (opcional)', placeholder: 'Ej.: Bolas paradas',
      show: (x) => !temas.length || x.temaSel === '__nuevo' },
  ], temas.length ? { temaSel: temas[temas.length - 1] } : {});
  if (!ans) return;
  const tema = ans.temaSel && ans.temaSel !== '__nuevo' ? ans.temaSel : (ans.tema || '').trim();
  const start = vaClipStart;
  vaClipStart = null;
  updateVideo((x) => x.clips.push({ id: uid(), nombre: ans.nombre.trim(), tema, inicio: start, fin: end }));
  vaTab = 'clips';
  renderAnalysis();
  toast('Clip guardado');
}

function renderClips(v) {
  const temas = [...new Set(v.clips.map((c) => c.tema || 'Sin tema'))];
  $('vaFilters').replaceChildren(
    chip(`Todos (${v.clips.length})`, vaFilter.tema === 'todos', () => { vaFilter.tema = 'todos'; renderAnalysis(); }),
    ...temas.map((t) => chip(`${t} (${v.clips.filter((c) => (c.tema || 'Sin tema') === t).length})`, vaFilter.tema === t, () => { vaFilter.tema = t; renderAnalysis(); })),
  );
  const box = $('vaList');
  if (!v.clips.length) {
    box.innerHTML = '<p class="hint">Para crear un clip: ve al inicio de la jugada, pulsa «✂️ Crear clip», avanza hasta el final y pulsa «Marcar fin».</p>';
    return;
  }
  const canPlay = playsInApp(v) && !!loadedFiles[v.id];
  const groups = {};
  const visible = v.clips.filter((c) => vaFilter.tema === 'todos' || (c.tema || 'Sin tema') === vaFilter.tema);
  visible.forEach((c) => (groups[c.tema || 'Sin tema'] = groups[c.tema || 'Sin tema'] || []).push(c));
  // ⬇ todos los clips que se ven (todos, o los del tema elegido), en el orden de la lista
  const all = document.createElement('div');
  all.className = 'row-btns va-dl-all';
  const allBtn = Object.assign(document.createElement('button'), {
    className: 'primary', textContent: `⬇ Descargar ${vaFilter.tema === 'todos' ? 'todos' : 'los de «' + vaFilter.tema + '»'} (${visible.length})`,
  });
  allBtn.onclick = () => (canPlay ? downloadAllClips(Object.values(groups).flat(), allBtn) : notLoaded(v));
  all.append(allBtn);
  all.hidden = !playsInApp(v) || !visible.length;
  box.replaceChildren(all, ...Object.entries(groups).flatMap(([tema, clips]) => {
    const h = document.createElement('h4');
    h.className = 'va-tema';
    h.textContent = tema;
    return [h, ...clips.map((c) => {
      const nDraw = v.marcas.filter((m) => m.dibujo && m.t >= c.inicio && m.t <= c.fin).length;
      const row = document.createElement('div');
      row.className = 'va-clip';
      row.innerHTML = `<div class="va-clip-main"><b></b><small></small></div>
        <div class="row-btns">
          <button class="primary small-btn va-c-play">▶ Ver</button>
          <button class="ghost small va-c-dl">⬇ Descargar</button>
          <button class="ghost small va-c-ed">Editar</button>
          <button class="ghost small danger va-c-del">Borrar</button>
        </div>`;
      row.querySelector('b').textContent = c.nombre;
      row.querySelector('small').textContent = `${fmtVT(c.inicio)} – ${fmtVT(c.fin)} · ${Math.round(c.fin - c.inicio)} s${nDraw ? ` · ✏️ ${nDraw} dibujo${nDraw > 1 ? 's' : ''}` : ''}`;
      const play = row.querySelector('.va-c-play');
      if (canPlay) play.onclick = () => openClipWindow(c);
      else if (playsInApp(v)) play.onclick = () => notLoaded(v);
      else { play.textContent = '📺 Ver en OK Liga TV'; play.onclick = () => alert(`Ve a ${fmtVT(c.inicio)} en OK Liga TV (hasta ${fmtVT(c.fin)}).`); }
      const dl = row.querySelector('.va-c-dl');
      dl.hidden = !playsInApp(v);
      dl.onclick = () => (canPlay ? downloadClip(c, dl) : notLoaded(v));
      row.querySelector('.va-c-ed').onclick = async () => {
        const ans = await ask('Editar clip', [
          { key: 'nombre', type: 'num', label: 'Nombre', required: true },
          { key: 'tema', type: 'num', label: 'Tema' },
          { key: 'inicio', type: 'num', label: 'Inicio (mm:ss)', required: true },
          { key: 'fin', type: 'num', label: 'Fin (mm:ss)', required: true },
        ], { nombre: c.nombre, tema: c.tema || '', inicio: fmtVT(c.inicio), fin: fmtVT(c.fin) });
        if (!ans) return;
        const ini = parseVT(ans.inicio), fin = parseVT(ans.fin);
        if (ini == null || fin == null || fin <= ini) { alert('Revisa el inicio y el fin (mm:ss); el fin tiene que ser después del inicio.'); return; }
        updateVideo((x) => Object.assign(x.clips.find((y) => y.id === c.id), { nombre: ans.nombre.trim(), tema: (ans.tema || '').trim(), inicio: ini, fin }));
      };
      row.querySelector('.va-c-del').onclick = () => {
        if (!confirm(`¿Borrar el clip «${c.nombre}»?`)) return;
        updateVideo((x) => (x.clips = x.clips.filter((y) => y.id !== c.id)));
      };
      return row;
    })];
  }));
}

// ---------- 3) Dibujar sobre el vídeo ----------
// Elementos: {t: 'arrow'|'line'|'circle'|'pen', c: color, x1,y1,x2,y2 | pts:[[x,y]…]} en coordenadas 0–1 del fotograma.

// Ajusta la capa de dibujo al rectángulo real de la imagen (el vídeo puede tener bandas negras)
function layoutOverlay(video = vid(), svg = $('vaOverlay')) {
  if (!video.videoWidth) return;
  const W = video.clientWidth, H = video.clientHeight;
  const ar = video.videoWidth / video.videoHeight;
  let w = W, h = W / ar;
  if (h > H) { h = H; w = H * ar; }
  Object.assign(svg.style, { left: `${(W - w) / 2}px`, top: `${(H - h) / 2}px`, width: `${w}px`, height: `${h}px` });
  svg.setAttribute('viewBox', `0 0 1000 ${Math.round(1000 / ar)}`);
}

function overlayMarkup(items, ar) {
  const H = 1000 / ar;
  const P = (x, y) => `${(x * 1000).toFixed(1)},${(y * H).toFixed(1)}`;
  // una punta de flecha por color
  const markers = DRAW_COLORS.map((c, i) =>
    `<marker id="vah${i}" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${c}" stroke="rgba(0,0,0,.55)" stroke-width="1"/></marker>`).join('');
  return `<defs>${markers}</defs>` +
    items.map((it) => {
      const st = `stroke="${it.c}" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
      const shadow = `stroke="rgba(0,0,0,.55)" stroke-width="11" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
      let d;
      if (it.t === 'pen') d = 'M' + it.pts.map(([x, y]) => P(x, y)).join(' L');
      else if (it.t === 'circle') {
        const cx = (it.x1 + it.x2) / 2 * 1000, cy = (it.y1 + it.y2) / 2 * H, rx = Math.abs(it.x2 - it.x1) / 2 * 1000, ry = Math.abs(it.y2 - it.y1) / 2 * H;
        return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" ${shadow}/><ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" ${st}/>`;
      } else d = `M${P(it.x1, it.y1)} L${P(it.x2, it.y2)}`;
      const marker = it.t === 'arrow' ? ` marker-end="url(#vah${Math.max(0, DRAW_COLORS.indexOf(it.c))})"` : '';
      return `<path d="${d}" ${shadow}/><path d="${d}" ${st}${marker}/>`;
    }).join('');
}

function showOverlay(dibujo) {
  const video = vid(), svg = $('vaOverlay');
  layoutOverlay();
  svg.innerHTML = dibujo ? overlayMarkup(dibujo.items, video.videoWidth / video.videoHeight || 16 / 9) : '';
  svg.classList.toggle('visible', !!dibujo);
}

function startDrawing() {
  const v = curVideo();
  if (!loadedFiles[v.id]) { notLoaded(v); return; }
  vid().pause();
  stopPlaylist();
  vaDrawing = { t: vid().currentTime, items: [], tool: 'arrow', color: DRAW_COLORS[0], undo: [], cur: null };
  drawToolbar();
  const svg = $('vaOverlay');
  svg.classList.add('editing', 'visible');
  layoutOverlay();
  redrawOverlayEdit();
  const pt = (ev) => {
    const r = svg.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))];
  };
  svg.onpointerdown = (ev) => {
    if (!vaDrawing) return;
    ev.preventDefault();
    try { svg.setPointerCapture(ev.pointerId); } catch {}
    const [x, y] = pt(ev);
    const d = vaDrawing;
    d.cur = d.tool === 'pen' ? { t: 'pen', c: d.color, pts: [[x, y]] } : { t: d.tool, c: d.color, x1: x, y1: y, x2: x, y2: y };
    redrawOverlayEdit();
  };
  svg.onpointermove = (ev) => {
    const d = vaDrawing;
    if (!d || !d.cur) return;
    const [x, y] = pt(ev);
    if (d.cur.t === 'pen') d.cur.pts.push([x, y]); else { d.cur.x2 = x; d.cur.y2 = y; }
    redrawOverlayEdit();
  };
  svg.onpointerup = svg.onpointercancel = () => {
    const d = vaDrawing;
    if (!d || !d.cur) return;
    const c = d.cur;
    const big = c.t === 'pen' ? c.pts.length > 2 : Math.hypot(c.x2 - c.x1, c.y2 - c.y1) > 0.02;
    if (big) { d.undo.push(JSON.stringify(d.items)); d.items.push(c); }
    d.cur = null;
    redrawOverlayEdit();
  };
}

function redrawOverlayEdit() {
  const d = vaDrawing, video = vid();
  $('vaOverlay').innerHTML = overlayMarkup([...d.items, ...(d.cur ? [d.cur] : [])], video.videoWidth / video.videoHeight || 16 / 9);
}

function drawToolbar() {
  const d = vaDrawing, bar = $('vaDrawBar');
  bar.hidden = false;
  const tools = [['arrow', '➜', 'Flecha'], ['line', '／', 'Línea'], ['circle', '◯', 'Círculo'], ['pen', '✎', 'Lápiz']];
  bar.replaceChildren(
    Object.assign(document.createElement('span'), { className: 'va-draw-t', textContent: `Dibujo en ${fmtVT(d.t)}` }),
    ...tools.map(([k, icon, label]) => {
      const b = document.createElement('button');
      b.className = 'tool' + (d.tool === k ? ' active' : '');
      b.innerHTML = `<span class="tool-icon">${icon}</span><span class="tool-label">${label}</span>`;
      b.onclick = () => { d.tool = k; drawToolbar(); };
      return b;
    }),
    ...DRAW_COLORS.map((c) => {
      const b = document.createElement('button');
      b.className = 'va-color' + (d.color === c ? ' active' : '');
      b.style.background = c;
      b.title = 'Color';
      b.onclick = () => { d.color = c; drawToolbar(); };
      return b;
    }),
    Object.assign(document.createElement('button'), { className: 'tool', innerHTML: '<span class="tool-icon">↶</span><span class="tool-label">Deshacer</span>',
      onclick: () => { if (d.undo.length) { d.items = JSON.parse(d.undo.pop()); redrawOverlayEdit(); } } }),
    Object.assign(document.createElement('button'), { className: 'ghost', textContent: 'Cancelar', onclick: () => endDrawing(false) }),
    Object.assign(document.createElement('button'), { className: 'primary', textContent: 'Guardar dibujo', onclick: () => endDrawing(true) }),
  );
}

function endDrawing(saveIt) {
  const d = vaDrawing;
  vaDrawing = null;
  $('vaDrawBar').hidden = true;
  const svg = $('vaOverlay');
  svg.classList.remove('editing');
  svg.onpointerdown = svg.onpointermove = svg.onpointerup = svg.onpointercancel = null;
  if (saveIt && d && d.items.length) {
    updateVideo((x) => {
      x.marcas.push({ id: uid(), t: d.t, tipo: 'dibujo', dibujo: { items: d.items } });
      x.marcas.sort((a, b) => a.t - b.t);
    });
    showOverlay({ items: d.items });
    toast(`Dibujo guardado en ${fmtVT(d.t)}`);
  } else showOverlay(null);
}

// ---------- Reproducción: tiempo, listas de tramos y paradas en los dibujos ----------

function vaTick() {
  const v = curVideo();
  if (!v) return;
  if (playsInApp(v)) {
    const video = vid();
    $('vaTime').textContent = `${fmtVT(video.currentTime)} / ${fmtVT(video.duration || 0)}`;
    $('vaPlay').textContent = video.paused ? '▶' : '❚❚';
    if (video.duration && document.activeElement !== $('vaSeek')) $('vaSeek').value = Math.round((video.currentTime / video.duration) * 1000);
  } else {
    $('vaClockTime').textContent = fmtVT(vaNow());
    $('vaClockPlay').textContent = vaClock.running ? '❚❚' : '▶';
  }
}

function onTimeUpdate() {
  const video = vid(), t = video.currentTime, v = curVideo();
  if (!v) return;
  // lista de tramos
  if (vaPlaylist && !video.paused) {
    const [, end] = vaPlaylist.segs[vaPlaylist.i];
    if (t >= end) {
      vaPlaylist.i++;
      if (vaPlaylist.i >= vaPlaylist.segs.length) {
        if (vaPlaylist.loop) vaPlaylist.i = 0; else { stopPlaylist(); video.pause(); }
      }
      if (vaPlaylist) video.currentTime = vaPlaylist.segs[vaPlaylist.i][0];
    }
  }
  // parar en los dibujos
  if (!video.paused && $('vaAutoPause').checked && !vaDrawing) {
    const m = v.marcas.find((x) => x.dibujo && x.t > vaLastTime && x.t <= t && t - x.t < 1);
    if (m) {
      video.pause();
      video.currentTime = m.t;
      showOverlay(m.dibujo);
      clearTimeout(vaHold);
      vaHold = setTimeout(() => { if (curVideo() && vid().paused && !vaDrawing) { showOverlay(null); vid().play(); } }, DRAW_HOLD * 1000);
    }
  }
  // mostrar el dibujo si está parado justo en él
  if (video.paused && !vaDrawing && !vaHold) {
    const m = v.marcas.find((x) => x.dibujo && Math.abs(x.t - t) < 0.25);
    showOverlay(m ? m.dibujo : null);
  }
  vaLastTime = t;
  vaTick();
}

function pauseAnalysisVideo() {
  try { vid().pause(); } catch {}
  stopPlaylist();
  if (vaDrawing) endDrawing(false);
}

// ---------- Descargar un clip como vídeo (con sus dibujos) ----------

function clipVideoFormat() {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return null;
  const options = [
    ['video/mp4;codecs=avc1,mp4a.40.2', 'mp4'], ['video/mp4;codecs=avc1', 'mp4'], ['video/mp4', 'mp4'],
    ['video/webm;codecs=vp9,opus', 'webm'], ['video/webm;codecs=vp8,opus', 'webm'], ['video/webm', 'webm'],
  ];
  const ok = options.find(([type]) => MediaRecorder.isTypeSupported(type));
  return ok ? { type: ok[0], ext: ok[1] } : null;
}

let vaAudio = null; // el audio del vídeo pasa por aquí para poder grabarlo
// Devuelve el sonido del vídeo para grabarlo, o null si el navegador no lo tiene activo
// (si se grabara una pista de sonido vacía, el archivo saldría con la duración mal).
async function audioStream() {
  try {
    if (!vaAudio) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaElementSource(vid());
      const dest = ctx.createMediaStreamDestination();
      src.connect(ctx.destination);
      src.connect(dest);
      vaAudio = { ctx, dest };
    }
    await Promise.race([vaAudio.ctx.resume(), new Promise((r) => setTimeout(r, 500))]);
    return vaAudio.ctx.state === 'running' ? vaAudio.dest.stream : null;
  } catch { return null; }
}

function seekTo(t) {
  return new Promise((resolve) => {
    const video = vid();
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = t;
    setTimeout(done, 3000);
  });
}

// Graba un clip (con sus dibujos) y devuelve el archivo, o null si se cancela.
// onProgress(fracción 0–1, parado en un dibujo); isCancelled() se consulta en cada fotograma.
async function recordClip(clip, onProgress = () => {}, isCancelled = () => false) {
  const fmt = clipVideoFormat();
  const v = curVideo(), video = vid();
  const scale = Math.min(1, 1280 / video.videoWidth);
  const W = Math.round(video.videoWidth * scale / 2) * 2, H = Math.round(video.videoHeight * scale / 2) * 2;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const draws = v.marcas.filter((m) => m.dibujo && m.t >= clip.inicio && m.t <= clip.fin).sort((a, b) => a.t - b.t);
  const images = {};
  for (const m of draws) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 1000 ${Math.round(1000 * H / W)}">${overlayMarkup(m.dibujo.items, W / H)}</svg>`;
    images[m.id] = await new Promise((res) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => res(null); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
  }
  let overlay = null;
  const paint = () => {
    ctx.drawImage(video, 0, 0, W, H);
    if (overlay) ctx.drawImage(overlay, 0, 0, W, H);
  };
  const frame = () => new Promise((r) => requestAnimationFrame(r));

  await seekTo(clip.inicio);
  paint();
  const stream = canvas.captureStream(30);
  const audio = await audioStream();
  if (audio) audio.getAudioTracks().forEach((tr) => stream.addTrack(tr));
  // sin sonido, se graba solo imagen (formato sin pista de audio)
  const mime = audio ? fmt.type : (videoFormat() || fmt).type;
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5000000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const finished = new Promise((r) => (rec.onstop = r));
  rec.start(250);
  await video.play();
  let next = 0, cancelled = false;
  // se graba en tiempo real; en cada dibujo, el vídeo se para DRAW_HOLD segundos
  for (;;) {
    if (isCancelled()) { cancelled = true; break; }
    if (video.currentTime >= clip.fin || video.ended) break;
    if (next < draws.length && video.currentTime >= draws[next].t) {
      video.pause();
      overlay = images[draws[next].id];
      const until = performance.now() + DRAW_HOLD * 1000;
      while (performance.now() < until && !isCancelled()) {
        paint();
        onProgress((video.currentTime - clip.inicio) / (clip.fin - clip.inicio), true);
        await frame();
      }
      overlay = null;
      next++;
      await video.play();
    }
    paint();
    onProgress((video.currentTime - clip.inicio) / (clip.fin - clip.inicio), false);
    await frame();
  }
  video.pause();
  rec.stop();
  await finished;
  stream.getVideoTracks().forEach((tr) => tr.stop());
  if (cancelled) return null;
  const safe = (clip.nombre || 'clip').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  return new File(chunks, `clip-${safe || 'telecable'}.${fmt.ext}`, { type: mime.split(';')[0] });
}

// Prepara el vídeo para grabar y lo deja como estaba al terminar
async function withRecording(fn) {
  if (!clipVideoFormat()) { alert('Este navegador no permite grabar vídeo. Prueba con Chrome, Edge o un iPhone/iPad actualizado.'); return; }
  pauseAnalysisVideo();
  const autoPause = $('vaAutoPause').checked;
  $('vaAutoPause').checked = false; // aquí las paradas en los dibujos las hace la grabación
  $('vaRec').hidden = false;
  try {
    await fn();
  } catch (err) {
    alert('No se ha podido crear el vídeo: ' + (err && err.message ? err.message : err));
  } finally {
    $('vaRec').hidden = true;
    $('vaRec').textContent = '● Grabando clip…';
    $('vaAutoPause').checked = autoPause;
  }
}

async function downloadClip(clip, button) {
  const label = button.textContent;
  button.disabled = true;
  await withRecording(async () => {
    const file = await recordClip(clip, (k, hold) => (button.textContent = hold ? 'Grabando…' : `Grabando ${Math.round(k * 100)}%`));
    if (file) { await shareOrDownload(file); toast('Clip listo'); }
  });
  button.disabled = false;
  button.textContent = label;
}

// Descarga varios clips de una vez: en móvil/tablet se comparten juntos; en ordenador, un .zip
let vaCancelAll = false;
async function downloadAllClips(clips, button) {
  if (!clips.length) return;
  const v = curVideo();
  const holds = v.marcas.filter((m) => m.dibujo && clips.some((c) => m.t >= c.inicio && m.t <= c.fin)).length;
  const secs = Math.round(clips.reduce((a, c) => a + (c.fin - c.inicio), 0) + holds * DRAW_HOLD);
  if (!confirm(`Se van a grabar ${clips.length} clips (unos ${fmtVT(secs)}). El vídeo se reproduce mientras se graba. ¿Empezar?`)) return;
  const label = button.textContent;
  button.disabled = true;
  vaCancelAll = false;
  const cancelBtn = Object.assign(document.createElement('button'), {
    className: 'ghost small danger', textContent: 'Cancelar',
    onclick: () => { vaCancelAll = true; },
  });
  button.after(cancelBtn);
  await withRecording(async () => {
    const files = [];
    for (let i = 0; i < clips.length; i++) {
      const prefix = `Clip ${i + 1}/${clips.length}`;
      $('vaRec').textContent = `● ${prefix}: ${clips[i].nombre}`;
      const file = await recordClip(clips[i],
        (k, hold) => (button.textContent = `${prefix} · ${hold ? 'dibujo' : Math.round(k * 100) + '%'}`),
        () => vaCancelAll);
      if (!file) break;
      // número delante para que queden en orden y sin nombres repetidos
      files.push(new File([file], `${String(i + 1).padStart(2, '0')}-${file.name}`, { type: file.type }));
    }
    if (vaCancelAll) { toast('Descarga cancelada'); return; }
    await shareAllOrZip(files, `clips-${(v.titulo || 'analisis').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}`);
    toast(`${files.length} clips listos`);
  });
  cancelBtn.remove();
  button.disabled = false;
  button.textContent = label;
}

async function shareAllOrZip(files, zipName) {
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files, title: zipName }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  downloadFile(new File([await makeZip(files)], `${zipName}.zip`, { type: 'application/zip' }));
}

// ZIP sencillo (sin comprimir: los vídeos ya van comprimidos)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
async function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const data = new Uint8Array(await f.arrayBuffer());
    const name = enc.encode(f.name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); // UTF-8
    local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    parts.push(local.buffer, name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true); cd.setUint16(12, dosTime, true); cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
    central.push(cd.buffer, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((a, p) => a + (p.byteLength ?? p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

// ---------- Archivo de vídeo ----------

function rememberFile(v) {
  const f = loadedFiles[v.id];
  if (f) updateVideo((x) => (x.archivo = { nombre: f.name, tam: f.size }));
}

function onFileChosen(file) {
  const v = curVideo();
  if (!v || !file) return;
  if (v.archivo && (v.archivo.nombre !== file.name || v.archivo.tam !== file.size) &&
      !confirm(`Este análisis se hizo con «${v.archivo.nombre}». ¿Usar «${file.name}» de todas formas? Las marcas podrían no coincidir.`)) return;
  if (loadedFiles[v.id]) URL.revokeObjectURL(loadedFiles[v.id].url);
  loadedFiles[v.id] = { url: URL.createObjectURL(file), name: file.name, size: file.size };
  if (!v.archivo || v.archivo.nombre !== file.name || v.archivo.tam !== file.size) rememberFile(v); else renderAnalysis();
}

// ---------- Elegir / editar / guardar teclados ----------

function applyKeyboard(kb, fromId = null) {
  // el estándar no se copia: así se sabe que es el estándar (y puede sumar al marcador)
  updateVideo((x) => { x.teclado = kb === STD_KEYBOARD ? null : copyKb(kb); x.tecladoId = fromId; });
  toast(`Teclado: ${kb.nombre}`);
}

function openKeyboardPicker() {
  const v = curVideo();
  const draw = () => {
    const saved = loadKeyboards().sort((a, b) => a.nombre.localeCompare(b.nombre));
    const current = keyboardOf(v);
    const row = (kb, id, canDelete) => {
      const r = document.createElement('div');
      r.className = 'kb-item' + ((id ? v.tecladoId === id : !v.teclado) ? ' active' : '');
      const pick = document.createElement('button');
      pick.className = 'kb-pick';
      pick.innerHTML = '<b></b><span class="kb-dots"></span><small></small>';
      pick.querySelector('b').textContent = kb.nombre;
      pick.querySelector('small').textContent = `${kb.botones.length} botones: ${kb.botones.map((b) => b.label).join(', ')}`;
      pick.querySelector('.kb-dots').append(...kb.botones.map((b) => Object.assign(document.createElement('i'), { style: `background:${b.color}` })));
      pick.onclick = () => { $('dlgKbPick').close(); applyKeyboard(kb, id); };
      r.append(pick);
      if (canDelete) {
        const del = Object.assign(document.createElement('button'), { className: 'ghost small danger', textContent: 'Borrar' });
        del.onclick = () => {
          if (!confirm(`¿Borrar el teclado guardado «${kb.nombre}»? Los partidos que ya lo usan no cambian.`)) return;
          remove(KEY_KEYBOARDS, 'teclado', id);
          draw();
        };
        r.append(del);
      }
      return r;
    };
    $('kbPickList').replaceChildren(
      row(STD_KEYBOARD, null, false),
      ...saved.map((kb) => row(kb, kb.id, true)),
      ...(saved.length ? [] : [Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Todavía no hay teclados guardados. Edita el teclado y pulsa «Guardar con este nombre».' })]),
    );
    return current;
  };
  draw();
  $('kbNew').onclick = () => {
    $('dlgKbPick').close();
    openKeyboardEditor({ nombre: '', botones: [{ k: 'b' + uid(), label: '', color: KB_COLORS[0] }] }, null, true);
  };
  $('kbPickClose').onclick = () => $('dlgKbPick').close();
  $('dlgKbPick').showModal();
}

function openKeyboardEditor(kbIn, fromId = null, isNew = false) {
  const kb = copyKb(kbIn);
  $('kbTitle').textContent = isNew ? 'Teclado nuevo' : 'Editar teclado';
  $('kbName').value = isNew ? '' : kb.nombre === STD_KEYBOARD.nombre && !fromId ? '' : kb.nombre;
  const draw = () => {
    $('kbRows').replaceChildren(...kb.botones.map((b, i) => {
      const r = document.createElement('div');
      r.className = 'kb-row';
      const color = Object.assign(document.createElement('button'), { className: 'va-color', title: 'Cambiar color' });
      color.style.background = b.color;
      color.onclick = () => { b.color = KB_COLORS[(KB_COLORS.indexOf(b.color) + 1) % KB_COLORS.length]; draw(); };
      const input = Object.assign(document.createElement('input'), { type: 'text', value: b.label, placeholder: 'Nombre del botón' });
      input.oninput = () => { b.label = input.value; drawPreview(); };
      const btn = (txt, title, fn, cls = '') => Object.assign(document.createElement('button'), { className: 'ghost small ' + cls, textContent: txt, title, onclick: fn });
      const up = btn('↑', 'Subir', () => { [kb.botones[i - 1], kb.botones[i]] = [kb.botones[i], kb.botones[i - 1]]; draw(); });
      const down = btn('↓', 'Bajar', () => { [kb.botones[i + 1], kb.botones[i]] = [kb.botones[i], kb.botones[i + 1]]; draw(); });
      up.disabled = i === 0; down.disabled = i === kb.botones.length - 1;
      r.append(color, input, up, down, btn('✕', 'Quitar', () => { kb.botones.splice(i, 1); draw(); }, 'danger'));
      return r;
    }));
    drawPreview();
  };
  const drawPreview = () => {
    $('kbPreview').replaceChildren(...kb.botones.map((b) => {
      const t = Object.assign(document.createElement('button'), { className: 'va-tag', textContent: b.label || '…', tabIndex: -1 });
      t.style.setProperty('--tc', b.color);
      return t;
    }));
  };
  // revisa el teclado antes de usarlo o guardarlo
  const valid = () => {
    kb.botones.forEach((b) => (b.label = b.label.trim()));
    if (!kb.botones.length) { alert('Añade al menos un botón.'); return false; }
    if (kb.botones.some((b) => !b.label)) { alert('Todos los botones necesitan un nombre.'); return false; }
    const names = kb.botones.map((b) => b.label.toLowerCase());
    if (new Set(names).size !== names.length) { alert('Hay dos botones con el mismo nombre.'); return false; }
    return true;
  };
  $('kbAdd').onclick = () => {
    kb.botones.push({ k: 'b' + uid(), label: '', color: KB_COLORS[kb.botones.length % KB_COLORS.length] });
    draw();
    const inputs = $('kbRows').querySelectorAll('input');
    inputs[inputs.length - 1].focus();
  };
  $('kbCancel').onclick = () => $('dlgKbEdit').close();
  $('kbOk').onclick = () => {
    if (!valid()) return;
    kb.nombre = $('kbName').value.trim() || (isNew ? 'Teclado del partido' : kb.nombre);
    $('dlgKbEdit').close();
    applyKeyboard(kb, fromId);
  };
  $('kbSaveLib').onclick = () => {
    if (!valid()) return;
    const nombre = $('kbName').value.trim();
    if (!nombre) { alert('Ponle un nombre al teclado para guardarlo.'); $('kbName').focus(); return; }
    kb.nombre = nombre;
    // mismo nombre que uno guardado: se actualiza; si no, se crea uno nuevo
    const existing = loadKeyboards().find((x) => x.nombre.toLowerCase() === nombre.toLowerCase());
    if (existing && !confirm(`Ya hay un teclado «${existing.nombre}». ¿Sustituirlo por este?`)) return;
    const id = existing ? existing.id : uid();
    upsert(KEY_KEYBOARDS, 'teclado', { id, ...copyKb(kb) });
    $('dlgKbEdit').close();
    applyKeyboard(kb, id);
    toast(`Teclado «${nombre}» guardado`);
  };
  draw();
  $('dlgKbEdit').showModal();
}

// ---------- Conexión con la interfaz (se llama al final de app.js) ----------

// ---------- Ver un clip en su propia ventana ----------
// El clip se ve en otro reproductor encima de la app; el partido se queda parado donde estaba.
let clipWin = null; // { clip, hls, hold, last, draws }

function openClipWindow(c) {
  const v = curVideo(), loaded = v && loadedFiles[v.id];
  if (!loaded) { notLoaded(v); return; }
  pauseAnalysisVideo();
  closeClipSource();
  const video = $('clipVideo');
  clipWin = { clip: c, hls: null, hold: null, last: c.inicio, draws: v.marcas.filter((m) => m.dibujo && m.t >= c.inicio && m.t <= c.fin) };
  $('clipTitle').textContent = c.nombre;
  const nDraw = clipWin.draws.length;
  $('clipSub').textContent = `${c.tema || 'Sin tema'} · ${fmtVT(c.inicio)} – ${fmtVT(c.fin)}${nDraw ? ` · ✏️ ${nDraw} dibujo${nDraw > 1 ? 's' : ''}` : ''}`;
  showClipOverlay(null);
  if (loaded.stream) {
    video.crossOrigin = 'anonymous';
    if (window.Hls && Hls.isSupported()) {
      clipWin.hls = new Hls({ maxBufferLength: 20, startPosition: c.inicio });
      clipWin.hls.loadSource(loaded.url);
      clipWin.hls.attachMedia(video);
    } else video.src = loaded.url;
  } else {
    video.removeAttribute('crossorigin');
    video.src = loaded.url;
  }
  video.playbackRate = +$('clipSpeed').value || 1;
  const start = () => { if (!clipWin) return; video.currentTime = c.inicio; video.play().catch(() => {}); };
  if (video.readyState >= 1) start(); else video.addEventListener('loadedmetadata', start, { once: true });
  $('dlgClip').showModal();
  clipTick();
}

function closeClipSource() {
  const video = $('clipVideo');
  if (clipWin) { clearTimeout(clipWin.hold); if (clipWin.hls) clipWin.hls.destroy(); }
  clipWin = null;
  video.pause();
  video.removeAttribute('src');
  try { video.load(); } catch {}
}

function closeClipWindow() {
  closeClipSource();
  if ($('dlgClip').open) $('dlgClip').close();
}

function showClipOverlay(dibujo) {
  const video = $('clipVideo'), svg = $('clipOverlay');
  layoutOverlay(video, svg);
  svg.innerHTML = dibujo ? overlayMarkup(dibujo.items, video.videoWidth / video.videoHeight || 16 / 9) : '';
  svg.classList.toggle('visible', !!dibujo);
}

function clipTick() {
  if (!clipWin) return;
  const video = $('clipVideo'), c = clipWin.clip;
  const len = c.fin - c.inicio, pos = Math.min(len, Math.max(0, video.currentTime - c.inicio));
  $('clipTime').textContent = `${fmtVT(pos)} / ${fmtVT(len)}`;
  $('clipPlay').textContent = video.paused && !clipWin.hold ? '▶' : '❚❚';
  if (document.activeElement !== $('clipSeek')) $('clipSeek').value = Math.round((pos / (len || 1)) * 1000);
}

function onClipTime() {
  if (!clipWin) return;
  const video = $('clipVideo'), c = clipWin.clip, t = video.currentTime;
  if (t >= c.fin) {
    if ($('clipLoop').checked) { video.currentTime = c.inicio; clipWin.last = c.inicio; }
    else { video.pause(); }
  } else if (t < c.inicio - 1 && video.readyState >= 1) {
    video.currentTime = c.inicio;
  }
  // se para unos segundos en cada dibujo del clip
  if (!video.paused && !clipWin.hold) {
    const m = clipWin.draws.find((x) => x.t > clipWin.last && x.t <= t && t - x.t < 1);
    if (m) {
      video.pause();
      video.currentTime = m.t;
      showClipOverlay(m.dibujo);
      clipWin.hold = setTimeout(() => {
        if (!clipWin) return;
        clipWin.hold = null;
        showClipOverlay(null);
        video.play().catch(() => {});
      }, DRAW_HOLD * 1000);
    }
  }
  if (!clipWin.hold && !video.paused) showClipOverlay(null);
  clipWin.last = t;
  clipTick();
}

function initClipWindow() {
  const video = $('clipVideo');
  video.addEventListener('timeupdate', onClipTime);
  ['play', 'pause', 'seeked'].forEach((e) => video.addEventListener(e, clipTick));
  $('clipPlay').onclick = () => {
    if (!clipWin) return;
    if (clipWin.hold) { clearTimeout(clipWin.hold); clipWin.hold = null; showClipOverlay(null); video.play(); return; }
    if (video.paused) {
      if (video.currentTime >= clipWin.clip.fin - 0.05) video.currentTime = clipWin.clip.inicio;
      video.play();
    } else video.pause();
  };
  $('clipRestart').onclick = () => {
    if (!clipWin) return;
    clearTimeout(clipWin.hold); clipWin.hold = null; showClipOverlay(null);
    video.currentTime = clipWin.clip.inicio; clipWin.last = clipWin.clip.inicio; video.play();
  };
  $('clipSeek').oninput = () => {
    if (!clipWin) return;
    const c = clipWin.clip;
    clearTimeout(clipWin.hold); clipWin.hold = null; showClipOverlay(null);
    video.currentTime = c.inicio + ($('clipSeek').value / 1000) * (c.fin - c.inicio);
    clipWin.last = video.currentTime;
  };
  $('clipSpeed').onchange = () => { video.playbackRate = +$('clipSpeed').value; };
  $('clipDl').onclick = () => { if (!clipWin) return; const c = clipWin.clip; closeClipWindow(); downloadClip(c, $('clipDl')); };
  $('clipClose').onclick = closeClipWindow;
  $('dlgClip').addEventListener('close', closeClipSource);
  window.addEventListener('resize', () => { if (clipWin && $('clipOverlay').classList.contains('visible')) layoutOverlay(video, $('clipOverlay')); });
}

function initVideo() {
  initClipWindow();
  $('vNew').onclick = () => openVideoDialog();
  $('vaKbChange').onclick = openKeyboardPicker;
  $('vaStats').onchange = toggleStats;
  $('vaKbEdit').onclick = () => { const v = curVideo(); openKeyboardEditor(keyboardOf(v), v.tecladoId || null); };
  $('vaFile').onchange = (ev) => { const f = ev.target.files[0]; ev.target.value = ''; onFileChosen(f); };
  const video = vid();
  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('play', () => { clearTimeout(vaHold); vaHold = null; if (!vaDrawing) showOverlay(null); vaTick(); });
  video.addEventListener('pause', vaTick);
  video.addEventListener('loadedmetadata', () => { layoutOverlay(); vaTick(); });
  video.addEventListener('seeked', () => { vaLastTime = video.currentTime - 0.01; onTimeUpdate(); });
  window.addEventListener('resize', layoutOverlay);
  video.onclick = () => { if (!vaDrawing) (video.paused ? video.play() : video.pause()); };
  $('vaPlay').onclick = () => (video.paused ? video.play() : video.pause());
  $('vaBack5').onclick = () => userSeek(Math.max(0, video.currentTime - 5));
  $('vaFwd5').onclick = () => userSeek(Math.min(video.duration || 0, video.currentTime + 5));
  $('vaSpeed').onchange = () => { video.playbackRate = +$('vaSpeed').value; };
  $('vaSeek').oninput = () => { if (video.duration) userSeek(($('vaSeek').value / 1000) * video.duration); };
  $('vaDraw').onclick = startDrawing;
  $('vaClip').onclick = startClip;
  $('vaTabMarks').onclick = () => { vaTab = 'marks'; renderAnalysis(); };
  $('vaTabClips').onclick = () => { vaTab = 'clips'; renderAnalysis(); };
  // Cronómetro para OK Liga TV
  $('vaClockPlay').onclick = () => {
    vaClock = vaClock.running ? { running: false, base: vaNow(), since: 0 } : { running: true, base: vaClock.base, since: performance.now() };
    vaTick();
  };
  $('vaClockBack').onclick = () => { vaClock.base = Math.max(0, vaClock.base - 5); vaTick(); };
  $('vaClockFwd').onclick = () => { vaClock.base += 5; vaTick(); };
  $('vaClockSet').onclick = async () => {
    const ans = await ask('Tiempo del vídeo', [{ key: 't', type: 'num', label: 'Escribe el tiempo que marca OK Liga TV (mm:ss o h:mm:ss)', required: true, placeholder: '12:30' }], { t: fmtVT(vaNow()) });
    const t = ans && parseVT(ans.t);
    if (t == null) { if (ans) alert('Escribe el tiempo como 12:30 o 1:05:20.'); return; }
    vaClock = { running: vaClock.running, base: t, since: performance.now() };
    vaTick();
  };
  setInterval(() => { if (route === 'analisis') vaTick(); }, 250);
}
