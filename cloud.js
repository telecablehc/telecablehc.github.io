// AppHóquei — cuentas y sincronización en la nube (Supabase)
//
// Cómo funciona:
// - La app sigue guardando todo en el dispositivo (funciona sin internet).
// - Con sesión iniciada y conexión, los partidos terminados se suben a la nube
//   y se bajan los que hayan guardado otros dispositivos de la cuenta del equipo.
// - El partido en curso también se sube, para poder seguirlo en otro dispositivo.
// - Solo los emails de la tabla "miembros" pueden ver y guardar datos.
//
// Si CLOUD.url está vacío, la app funciona como antes (solo en el dispositivo).
'use strict';

const CLOUD = {
  // Proyecto Supabase del equipo. La clave "anon" es pública por diseño:
  // los datos los protegen las reglas (RLS) de supabase/setup.sql.
  url: 'https://yrhyjyupzoqlszdmqtkh.supabase.co',
  key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlyaHlqeXVwem9xbHN6ZG1xdGtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ4MTUzODksImV4cCI6MjExMDM5MTM4OX0.qmVa99a2RSDFuafDVouA9J0CMpnGzykpeEFSTSVsmwk',
};

const KEY_DIRTY = 'hoquei.cloud.dirty';       // ids de partidos pendientes de subir
const KEY_DELETED = 'hoquei.cloud.deleted';   // ids borrados pendientes de subir
const KEY_LASTPULL = 'hoquei.cloud.lastPull'; // última fecha de cambios bajados
const KEY_ACCOUNT = 'hoquei.cloud.account';   // { id, email } del usuario de este dispositivo
// Planes de entreno y biblioteca de ejercicios: tabla "documentos" (id = "tipo:id")
const KEY_DOCS_DIRTY = 'hoquei.cloud.docsDirty';
const KEY_DOCS_LASTPULL = 'hoquei.cloud.docsLastPull';
const DOC_KEYS = { plan: 'hoquei.planes', ejercicio: 'hoquei.ejercicios', video: 'hoquei.videos', teclado: 'hoquei.teclados' };
let docsError = ''; // p. ej. si aún no se ha creado la tabla en Supabase

let sb = null;
let cloudUser = null;
let syncing = false;
let sessionTimer = null;
let sessionPending = false;
let cloudStatus = { state: 'off', last: null, msg: '' }; // off | ok | syncing | offline | error

const cloudEnabled = () => !!(CLOUD.url && CLOUD.key && window.supabase);
const isNetworkError = (err) => !navigator.onLine || (err && /fetch|network|Retryable/i.test(`${err.name} ${err.message}`));

// ---------- Marcas de cambios pendientes ----------

function cloudMarkDirty(id) {
  if (!cloudEnabled()) return;
  const d = new Set(load(KEY_DIRTY, []));
  d.add(id);
  store(KEY_DIRTY, [...d]);
  scheduleSync();
}

function cloudMarkDeleted(id) {
  if (!cloudEnabled()) return;
  const del = new Set(load(KEY_DELETED, []));
  del.add(id);
  store(KEY_DELETED, [...del]);
  cloudMarkDirty(id);
}

function cloudMarkDoc(kind, id) {
  if (!cloudEnabled()) return;
  const d = new Set(load(KEY_DOCS_DIRTY, []));
  d.add(`${kind}:${id}`);
  store(KEY_DOCS_DIRTY, [...d]);
  scheduleSync();
}

async function pushDocs() {
  const dirty = load(KEY_DOCS_DIRTY, []);
  if (!dirty.length) return;
  const rows = dirty.map((key) => {
    const [kind, id] = key.split(':');
    const item = load(DOC_KEYS[kind], []).find((x) => x.id === id);
    return item ? { id: key, tipo: kind, datos: item, borrado: false } : { id: key, tipo: kind, datos: {}, borrado: true };
  });
  const { error } = await sb.from('documentos').upsert(rows);
  if (error) throw error;
  const done = new Set(dirty);
  store(KEY_DOCS_DIRTY, load(KEY_DOCS_DIRTY, []).filter((k) => !done.has(k)));
}

async function pullDocs() {
  const since = load(KEY_DOCS_LASTPULL, null);
  let q = sb.from('documentos').select('id, tipo, datos, borrado, actualizado').order('actualizado', { ascending: true });
  if (since) q = q.gt('actualizado', since);
  const { data, error } = await q;
  if (error) throw error;
  if (!data.length) return false;
  const dirty = new Set(load(KEY_DOCS_DIRTY, []));
  const lists = {};
  Object.entries(DOC_KEYS).forEach(([kind, key]) => (lists[kind] = load(key, [])));
  data.forEach((row) => {
    if (dirty.has(row.id) || !lists[row.tipo]) return; // el cambio local, aún sin subir, manda
    const id = row.id.slice(row.tipo.length + 1);
    lists[row.tipo] = lists[row.tipo].filter((x) => x.id !== id);
    if (!row.borrado && row.datos && row.datos.id) lists[row.tipo].push(row.datos);
  });
  Object.entries(DOC_KEYS).forEach(([kind, key]) => store(key, lists[kind]));
  store(KEY_DOCS_LASTPULL, data[data.length - 1].actualizado);
  return true;
}

// Llamada desde save(): sube el partido en curso unos segundos después del último cambio
function cloudSessionChanged() {
  if (!cloudUser) return;
  sessionPending = true;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(pushSession, 3000);
}

let syncTimer = null;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(cloudSync, 1000);
}

// ---------- Sincronización ----------

async function pushSession() {
  if (!cloudUser || !sessionPending || !navigator.onLine) return;
  sessionPending = false;
  const { error } = await sb.from('sesiones').upsert({ usuario: cloudUser.id, datos: S });
  if (error) { sessionPending = true; setStatus(isNetworkError(error) ? 'offline' : 'error', error.message); }
}

async function pushGames() {
  const dirty = load(KEY_DIRTY, []);
  if (!dirty.length) return;
  const history = load(KEY_HISTORY, []);
  // si ya no está en el historial es que se ha borrado
  const rows = dirty.map((id) => {
    const rec = history.find((r) => r.id === id);
    return rec ? { id, datos: rec, borrado: false } : { id, datos: {}, borrado: true };
  });
  const { error } = await sb.from('partidos').upsert(rows);
  if (error) throw error;
  // quitar de pendientes solo lo que se ha subido (pudo cambiar algo mientras tanto)
  const done = new Set(dirty);
  store(KEY_DIRTY, load(KEY_DIRTY, []).filter((id) => !done.has(id)));
  store(KEY_DELETED, load(KEY_DELETED, []).filter((id) => !done.has(id)));
}

async function pullGames() {
  const since = load(KEY_LASTPULL, null);
  let q = sb.from('partidos').select('id, datos, borrado, actualizado').order('actualizado', { ascending: true });
  if (since) q = q.gt('actualizado', since);
  const { data, error } = await q;
  if (error) throw error;
  if (!data.length) return false;

  const dirty = new Set(load(KEY_DIRTY, []));
  let history = load(KEY_HISTORY, []);
  data.forEach((row) => {
    if (dirty.has(row.id)) return; // el cambio local, aún sin subir, manda
    history = history.filter((r) => r.id !== row.id);
    if (!row.borrado && row.datos && row.datos.id) history.push(row.datos);
  });
  history.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  store(KEY_HISTORY, history);
  store(KEY_LASTPULL, data[data.length - 1].actualizado);
  return true;
}

// Si en este dispositivo no hay partido empezado y en la nube sí, se recupera
async function pullSession() {
  const { data, error } = await sb.from('sesiones').select('datos').eq('usuario', cloudUser.id).maybeSingle();
  if (error) throw error;
  const remote = data && data.datos;
  const hasData = (x) => x && x.version === VERSION && (sum(x.partMs) > 0 || x.running || (x.events || []).length > 0);
  if (hasData(remote) && !hasData(S)) {
    S = remote;
    undoStack = [];
    store(KEY_SESSION, S); // sin volver a subirla
    render();
    toast('Partido en curso recuperado de la nube');
  }
}

async function cloudSync() {
  if (!cloudUser || syncing) return;
  if (!navigator.onLine) { setStatus('offline'); return; }
  syncing = true;
  setStatus('syncing');
  try {
    const { data } = await sb.auth.getSession();
    if (!data.session) {
      if (navigator.onLine) { showLogin('Tu sesión ha caducado. Vuelve a entrar.'); }
      return;
    }
    await pushGames();
    let changed = await pullGames();
    if (sessionPending) await pushSession();
    // Planes y biblioteca: si falla (p. ej. falta la tabla), los partidos siguen sincronizando
    try {
      await pushDocs();
      changed = (await pullDocs()) || changed;
      docsError = '';
    } catch (err) {
      if (isNetworkError(err)) throw err;
      docsError = /documentos/.test(err.message || '') ? 'falta crear la tabla «documentos» en Supabase' : err.message;
    }
    setStatus('ok');
    if (changed) render();
  } catch (err) {
    setStatus(isNetworkError(err) ? 'offline' : 'error', err.message);
  } finally {
    syncing = false;
  }
}

function setStatus(state, msg = '') {
  cloudStatus = { state, last: state === 'ok' ? Date.now() : cloudStatus.last, msg };
  updateCloudUI();
}

// ---------- Interfaz: indicador y ajustes ----------

function updateCloudUI() {
  const dot = $('cloudDot');
  const box = $('cloudBox');
  if (!cloudEnabled()) { dot.hidden = true; box.hidden = true; return; }
  const pending = load(KEY_DIRTY, []).length + (sessionPending ? 1 : 0) +
    (docsError ? 0 : load(KEY_DOCS_DIRTY, []).length);
  const st = cloudStatus.state;
  dot.hidden = false;
  dot.className = 'cloud-dot ' + (st === 'ok' && !pending ? 'ok' : st === 'error' ? 'bad' : st === 'offline' ? 'off' : 'wait');
  box.hidden = false;
  const last = cloudStatus.last ? new Date(cloudStatus.last).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '—';
  const text = {
    ok: pending ? `Pendiente de subir (${pending})` : `✓ Sincronizado (${last})`,
    syncing: 'Sincronizando…',
    offline: `Sin conexión: se subirá al volver internet${pending ? ` (${pending} pendientes)` : ''}`,
    error: `✗ Error al sincronizar: ${cloudStatus.msg}`,
    off: '',
  }[st];
  $('cloudInfo').textContent = cloudUser
    ? `${cloudUser.email} · ${text}${docsError ? ` · Planes de entreno sin sincronizar: ${docsError}` : ''}`
    : 'Sin sesión';
}

// ---------- Pantalla de acceso ----------

let loginMode = 'login'; // login | signup | recovery

function cloudLocked() {
  return !$('login').hidden;
}

function showLogin(message = '', mode = 'login') {
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  loginMode = mode;
  $('login').hidden = false;
  $('loginMsg').textContent = message;
  $('loginMsg').className = 'login-msg';
  drawLogin();
}

function hideLogin() {
  $('login').hidden = true;
  $('loginPass').value = '';
}

function drawLogin() {
  const m = loginMode;
  $('loginTitle').textContent = { login: 'Iniciar sesión', signup: 'Crear cuenta', recovery: 'Nueva contraseña' }[m];
  $('loginEmail').hidden = m === 'recovery';
  $('loginGo').textContent = { login: 'Entrar', signup: 'Crear cuenta', recovery: 'Guardar contraseña' }[m];
  $('loginSwitch').hidden = m === 'recovery';
  $('loginSwitch').textContent = m === 'login' ? '¿No tienes cuenta? Crear cuenta' : 'Ya tengo cuenta: iniciar sesión';
  $('loginForgot').hidden = m !== 'login';
  $('loginPass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
}

function loginMessage(text, ok = false) {
  $('loginMsg').textContent = text;
  $('loginMsg').className = 'login-msg ' + (ok ? 'ok' : 'bad');
}

const AUTH_ERRORS = {
  'Invalid login credentials': 'Email o contraseña incorrectos.',
  'Email not confirmed': 'Falta confirmar el email: abre el enlace que te hemos enviado.',
  'User already registered': 'Ya existe una cuenta con este email. Inicia sesión.',
};
const authError = (err) => AUTH_ERRORS[err.message] || (isNetworkError(err) ? 'Sin conexión a internet.' : err.message);

async function submitLogin(ev) {
  ev.preventDefault();
  const email = $('loginEmail').value.trim();
  const password = $('loginPass').value;
  const redirect = location.origin + location.pathname;
  if (password.length < 6) return loginMessage('La contraseña debe tener al menos 6 caracteres.');
  $('loginGo').disabled = true;
  try {
    if (loginMode === 'login') {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) return loginMessage(authError(error));
      await afterLogin(data.user);
    } else if (loginMode === 'signup') {
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: redirect } });
      if (error) return loginMessage(authError(error));
      if (data.session) await afterLogin(data.user);
      else { loginMode = 'login'; drawLogin(); loginMessage('Te hemos enviado un email para confirmar la cuenta. Ábrelo y después inicia sesión aquí.', true); }
    } else {
      const { error } = await sb.auth.updateUser({ password });
      if (error) return loginMessage(authError(error));
      const { data } = await sb.auth.getUser();
      await afterLogin(data.user);
      toast('Contraseña cambiada');
    }
  } finally {
    $('loginGo').disabled = false;
  }
}

async function forgotPassword() {
  const email = $('loginEmail').value.trim();
  if (!email) return loginMessage('Escribe tu email y vuelve a pulsar «He olvidado la contraseña».');
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  if (error) return loginMessage(authError(error));
  loginMessage('Te hemos enviado un email para cambiar la contraseña.', true);
}

async function afterLogin(user) {
  // Comprobar que el email está autorizado
  const { data: member, error } = await sb.rpc('es_miembro');
  if (!error && member === false) {
    await sb.auth.signOut();
    showLogin(`El email ${user.email} no está autorizado. Pide a la administradora que lo añada a la lista de miembros.`);
    return;
  }
  const prev = load(KEY_ACCOUNT, null);
  if (!prev || prev.id !== user.id) {
    // Primera vez en este dispositivo: se suben los partidos que ya había guardados
    store(KEY_LASTPULL, null);
    store(KEY_DOCS_LASTPULL, null);
    load(KEY_HISTORY, []).forEach((r) => cloudMarkDirty(r.id));
    Object.entries(DOC_KEYS).forEach(([kind, key]) => load(key, []).forEach((x) => cloudMarkDoc(kind, x.id)));
  }
  cloudUser = { id: user.id, email: user.email };
  store(KEY_ACCOUNT, cloudUser);
  hideLogin();
  updateCloudUI();
  try { await pullSession(); } catch {}
  await cloudSync();
  startupChecks();
}

async function cloudLogout() {
  if (!confirm('¿Cerrar sesión? Los datos guardados en este dispositivo se mantienen.')) return;
  await pushSession().catch(() => {});
  await cloudSync();
  await sb.auth.signOut().catch(() => {});
  store(KEY_ACCOUNT, null);
  cloudUser = null;
  $('dlgSettings').close();
  showLogin('Has cerrado la sesión.');
}

// ---------- Arranque ----------

async function cloudInit() {
  updateCloudUI();
  if (!cloudEnabled()) return;

  sb = window.supabase.createClient(CLOUD.url, CLOUD.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'hoquei.auth' },
  });

  $('loginForm').onsubmit = submitLogin;
  $('loginSwitch').onclick = () => { loginMode = loginMode === 'login' ? 'signup' : 'login'; drawLogin(); loginMessage(''); };
  $('loginForgot').onclick = forgotPassword;
  $('btnSync').onclick = cloudSync;
  $('btnLogout').onclick = cloudLogout;

  const account = load(KEY_ACCOUNT, null);
  if (!account) showLogin(); // nadie ha entrado aún en este dispositivo

  sb.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') showLogin('Escribe tu nueva contraseña.', 'recovery');
  });

  const { data, error } = await sb.auth.getSession();
  if (loginMode === 'recovery' && cloudLocked()) return;
  if (data.session) {
    await afterLogin(data.session.user);
  } else if (account && isNetworkError(error)) {
    // Sin internet y con una sesión anterior: se entra en modo sin conexión
    cloudUser = account;
    hideLogin();
    setStatus('offline');
  } else if (account && !navigator.onLine) {
    cloudUser = account;
    hideLogin();
    setStatus('offline');
  } else {
    showLogin(account ? 'Tu sesión ha caducado. Vuelve a entrar.' : '');
  }

  window.addEventListener('online', cloudSync);
  window.addEventListener('offline', () => setStatus('offline'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') pushSession();
    else cloudSync();
  });
  setInterval(() => { if (document.visibilityState === 'visible') cloudSync(); }, 60000);
}
