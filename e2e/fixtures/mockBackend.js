// @ts-check
// Mock completo del backend de Supabase (Auth + REST/PostgREST + RPC) y de
// las Edge Functions, para poder correr la suite E2E sin salir a la red real
// — sin costo (Anthropic/Resend), sin tocar datos reales, y sin depender de
// que este sandbox pueda llegar a supabase.co (no puede: bloqueado por la
// política de egress del entorno).
//
// Para correr esta misma suite contra el backend REAL (con una cuenta de
// test real y aislada), ver README.md — básicamente es correr con
// GESTOPRO_E2E_MODE=real y no cargar este fixture.

const { test: base, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// La app carga el SDK real de Supabase (y SheetJS) desde CDNs externos, que
// este sandbox tampoco puede alcanzar (mismo bloqueo de egress que
// supabase.co). Sin el SDK real, `window.supabase` nunca se define y la app
// cae directo a su modo 100% local (`entrarSinNube()`) — ningún mock de
// Auth/REST de abajo llegaría a ejecutarse nunca. Por eso serví el mismo
// paquete real (instalado por npm, que sí está permitido) desde disco,
// interceptando exactamente la URL del CDN — la app no se entera de la
// diferencia, sigue pensando que cargó el CDN real.
const SUPABASE_SDK_LOCAL_PATH = path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js');
const XLSX_LOCAL_PATH = path.join(__dirname, '..', 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js');

async function installVendorCdnMocks(page) {
  const supabaseSdk = fs.readFileSync(SUPABASE_SDK_LOCAL_PATH, 'utf-8');
  await page.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: supabaseSdk })
  );

  const xlsxLib = fs.readFileSync(XLSX_LOCAL_PATH, 'utf-8');
  await page.route('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: xlsxLib })
  );

  // Cosmético únicamente (tipografías) — se responde vacío para no dejar el
  // request colgado esperando una red bloqueada, sin gastar tiempo en
  // servir fuentes reales que no afectan ningún test funcional.
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
}

const TEST_USER_ID = 'e2e00000-0000-4000-8000-000000000001';
const TEST_NEGOCIO_ID = 'e2e00000-0000-4000-8000-000000000002';
const TEST_EMAIL = 'e2e-test@gestopro.local';
const TEST_PASSWORD = 'Test1234!';

function uuid() {
  return 'e2e0' + Math.random().toString(16).slice(2).padEnd(28, '0').slice(0, 28);
}

function base64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * supabase-js decodifica localmente el access_token para leer `exp` (no
 * valida la firma, eso es trabajo del servidor real) — si no tiene forma de
 * JWT, el SDK puede tratarlo como inválido y forzar un refresh o un logout
 * silencioso al recargar la página. Con esto alcanza para que el SDK lo
 * acepte como una sesión local válida.
 */
function fakeJwt(user, expiresInSec) {
  const header = base64url({ alg: 'HS256', typ: 'JWT' });
  const payload = base64url({
    sub: user.id,
    email: user.email,
    role: 'authenticated',
    aud: 'authenticated',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expiresInSec,
  });
  return `${header}.${payload}.mock-signature-not-verified-by-client`;
}

function fakeSession(user, expiresInSec = 3600) {
  return {
    access_token: fakeJwt(user, expiresInSec),
    token_type: 'bearer',
    expires_in: expiresInSec,
    expires_at: Math.floor(Date.now() / 1000) + expiresInSec,
    refresh_token: 'mock-refresh-token-' + user.id,
    user,
  };
}

function fakeUser(overrides = {}) {
  return {
    id: TEST_USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: TEST_EMAIL,
    email_confirmed_at: new Date().toISOString(),
    phone: '',
    confirmed_at: new Date().toISOString(),
    last_sign_in_at: new Date().toISOString(),
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Negocio semilla: cuenta de test aislada, plan gratis, trial recién arrancado. */
function seedNegocio(overrides = {}) {
  return {
    id: TEST_NEGOCIO_ID,
    user_id: TEST_USER_ID,
    nombre: 'Almacén E2E Test',
    email: TEST_EMAIL,
    plan: 'gratis',
    aprobado: true,
    exento: false,
    plan_vencimiento: null,
    plan_periodo: null,
    trial_dias: 35,
    fecha_registro: new Date().toISOString(),
    config: JSON.stringify({
      nombre: 'Almacén E2E Test',
      alias: 'almacen.e2e.test',
      cvu: '0000003100000000000000',
      recargoDomingo: 0,
      pin: '1111',
      tel: '5491100000000',
      emailDueno: TEST_EMAIL,
    }),
    mp_preapproval_id: null,
    ...overrides,
  };
}

/**
 * Base de datos en memoria, con las tablas reales de GestoPro. Se reinicia
 * en cada test (test-scoped fixture), así que no hay contaminación entre
 * tests ni con datos reales — todo vive y muere en el proceso de Node del
 * test runner.
 */
function createDb() {
  return {
    negocios: [seedNegocio()],
    productos_v2: [],
    movimientos_v2: [],
    fiados_clientes: [],
    fiados_movimientos: [],
    empleados: [],
    empleados_mercaderia: [],
    empleados_semanas: [],
    empleados_horas: [],
    facturas_v2: [],
    gastos_fijos: [],
    gastos_fijos_pagos: [],
    cajas: [],
    proveedores: [],
    insumos: [],
    recetas: [],
    menu_items: [],
    pedidos: [],
    mp_pagos_procesados: [],
    chat_rate_limit: [],
  };
}

function parseFilterValue(op, raw) {
  if (op === 'in') {
    // in.(a,b,c)
    const inner = raw.replace(/^\(/, '').replace(/\)$/, '');
    return inner.split(',').map((v) => v.replace(/^"|"$/g, ''));
  }
  return raw;
}

/**
 * Compara cell/value numéricamente si ambos son números válidos; si no (ej.
 * fechas ISO "2026-08-10", que Number() convierte a NaN), compara como
 * string — funciona porque YYYY-MM-DD (y timestamps ISO) ordenan igual
 * lexicográfica y cronológicamente. Sin esto, todo filtro gte/lte/gt/lt
 * sobre una columna de fecha quedaba roto en silencio (NaN >= NaN es false).
 */
function compararOrden(cell, value) {
  const cellNum = Number(cell);
  const valueNum = Number(value);
  if (!Number.isNaN(cellNum) && !Number.isNaN(valueNum)) return cellNum < valueNum ? -1 : cellNum > valueNum ? 1 : 0;
  const cellStr = String(cell ?? '');
  const valueStr = String(value ?? '');
  return cellStr < valueStr ? -1 : cellStr > valueStr ? 1 : 0;
}

function matchFilter(row, col, op, value) {
  const cell = row[col];
  switch (op) {
    case 'eq':
      return String(cell) === String(value);
    case 'neq':
      return String(cell) !== String(value);
    case 'gt':
      return compararOrden(cell, value) > 0;
    case 'gte':
      return compararOrden(cell, value) >= 0;
    case 'lt':
      return compararOrden(cell, value) < 0;
    case 'lte':
      return compararOrden(cell, value) <= 0;
    case 'like':
    case 'ilike': {
      const pattern = '^' + value.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
      const re = new RegExp(pattern, op === 'ilike' ? 'i' : '');
      return re.test(String(cell ?? ''));
    }
    case 'in':
      return value.includes(String(cell));
    case 'is':
      if (value === 'null') return cell === null || cell === undefined;
      return String(cell) === String(value);
    default:
      return true;
  }
}

function applyQuery(rows, searchParams) {
  let result = rows.slice();
  for (const [key, raw] of searchParams.entries()) {
    if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
    const [op, ...rest] = raw.split('.');
    const value = parseFilterValue(op, rest.join('.'));
    result = result.filter((row) => matchFilter(row, key, op, value));
  }
  const order = searchParams.get('order');
  if (order) {
    const [col, dir] = order.split('.');
    result.sort((a, b) => {
      const av = a[col];
      const bv = b[col];
      if (av === bv) return 0;
      const cmp = av < bv ? -1 : 1;
      return dir === 'desc' ? -cmp : cmp;
    });
  }
  const limit = searchParams.get('limit');
  if (limit) result = result.slice(0, Number(limit));
  return result;
}

/**
 * Instala en `page` los interceptores de red que reemplazan por completo
 * al backend real de Supabase (Auth + REST + RPC + Storage) y a las Edge
 * Functions (leer-factura, interpretar-productos-ia, chatbot-ia,
 * notificar-*, trial_dias_para_usuario_actual), devolviendo un objeto con
 * la base en memoria (`db`) y un log de llamadas (`calls`) para asserts.
 */
async function installMockBackend(page, { db, edgeFunctionHandlers = {} } = {}) {
  const state = { db: db || createDb(), calls: [] };

  await installVendorCdnMocks(page);

  // ---- AUTH ----
  await page.route('**/auth/v1/token*', async (route) => {
    const req = route.request();
    let body = {};
    try { body = req.postDataJSON(); } catch (_e) {}
    state.calls.push({ type: 'auth', op: 'token', body });

    if (body.email && body.password) {
      if (body.password.length < 6) {
        return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid login credentials' }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fakeSession(fakeUser({ email: body.email }))) });
    }
    if (body.refresh_token) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fakeSession(fakeUser())) });
    }
    return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_request' }) });
  });

  await page.route('**/auth/v1/signup*', async (route) => {
    const req = route.request();
    let body = {};
    try { body = req.postDataJSON(); } catch (_e) {}
    state.calls.push({ type: 'auth', op: 'signup', body });
    const user = fakeUser({ id: uuid(), email: body.email, user_metadata: body.data || {} });
    // Simula confirmación de email ACTIVADA por default (igual que producción):
    // signUp no devuelve sesión, el flujo pasa a mostrarConfirmarCodigo().
    state.pendingSignup = { email: body.email, user };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: user.id, email: user.email, user, session: null }) });
  });

  await page.route('**/auth/v1/verify*', async (route) => {
    const req = route.request();
    let body = {};
    try { body = req.postDataJSON(); } catch (_e) {}
    state.calls.push({ type: 'auth', op: 'verify', body });
    if (body.token === '99999999') {
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_otp', error_description: 'Token has expired or is invalid' }) });
    }
    const user = (state.pendingSignup && state.pendingSignup.email === body.email) ? state.pendingSignup.user : fakeUser({ email: body.email });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fakeSession(user)) });
  });

  await page.route('**/auth/v1/logout*', async (route) => {
    state.calls.push({ type: 'auth', op: 'logout' });
    return route.fulfill({ status: 204, body: '' });
  });

  await page.route('**/auth/v1/user*', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fakeUser()) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fakeUser()) });
  });

  await page.route('**/auth/v1/recover*', async (route) => {
    state.calls.push({ type: 'auth', op: 'recover' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.route('**/auth/v1/resend*', async (route) => {
    state.calls.push({ type: 'auth', op: 'resend' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  // ---- REST (PostgREST) + RPC ----
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();

    if (method === 'OPTIONS') {
      return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' }, body: '' });
    }

    const pathParts = url.pathname.split('/rest/v1/')[1] || '';

    // RPC
    if (pathParts.startsWith('rpc/')) {
      const fnName = pathParts.slice(4);
      let body = {};
      try { body = req.postDataJSON(); } catch (_e) {}
      state.calls.push({ type: 'rpc', fn: fnName, body });

      if (fnName === 'trial_dias_para_usuario_actual') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.trialDiasOverride ?? 35) });
      }
      if (fnName === 'verificar_pin_empleado') {
        // A diferencia de verificar_pin_negocio (abajo), este SÍ compara
        // contra el pin_caja real del empleado — lo necesitamos para poder
        // probar el caso de PIN incorrecto en empleados.spec.js, y ningún
        // test existente depende de que este siempre devuelva válido.
        const emp = (state.db.empleados || []).find((e) => String(e.id) === String(body.p_empleado_id));
        const valido = !!emp && !!emp.pin_caja && String(emp.pin_caja) === String(body.p_pin || '');
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ valido }) });
      }
      if (fnName === 'verificar_pin_negocio') {
        // Siempre válido a propósito: el PIN real del negocio vive en una
        // columna server-side separada del `config` JSON que sembramos acá
        // (no tenemos visibilidad de esa función SQL real para replicarla
        // fielmente), y varios specs ya asumen que abrir caja como "dueño"
        // con cualquier PIN de 4 dígitos funciona.
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ valido: true }) });
      }
      if (fnName === 'ajustar_stock_producto') {
        const prod = (state.db.productos_v2 || []).find((p) => String(p.id) === String(body.p_producto_id));
        if (prod) prod.stock = Math.max(0, (Number(prod.stock) || 0) + Number(body.p_delta || 0));
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(prod ? prod.stock : null) });
      }
      // RPC desconocida en el mock: devolvemos null en vez de romper el test,
      // pero queda registrado en `calls` para poder detectarlo en el assert.
      return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    }

    const table = pathParts.split('?')[0];
    if (!state.db[table]) state.db[table] = [];
    state.calls.push({ type: 'rest', method, table, query: url.search });

    const preferHeader = req.headers()['prefer'] || '';
    const acceptHeader = req.headers()['accept'] || '';
    const wantsRepresentation = preferHeader.includes('return=representation');
    const wantsSingle = acceptHeader.includes('vnd.pgrst.object');

    if (method === 'GET') {
      const results = applyQuery(state.db[table], url.searchParams);
      if (wantsSingle) {
        if (results.length === 0) {
          return route.fulfill({ status: 406, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }) });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(results[0]) });
      }
      const countHeader = (req.headers()['prefer'] || '').includes('count=exact') ? { 'content-range': `0-${results.length}/${results.length}` } : {};
      return route.fulfill({ status: 200, contentType: 'application/json', headers: countHeader, body: JSON.stringify(results) });
    }

    if (method === 'POST') {
      let body = [];
      try { body = req.postDataJSON(); } catch (_e) {}
      const rows = Array.isArray(body) ? body : [body];
      // Varias tablas reales tienen columnas booleanas con default a nivel de
      // columna en Postgres que la app no manda explícito en sus inserts:
      // `activo` (fiados_clientes, empleados, insumos) default TRUE, y
      // `descontado` (empleados_mercaderia) default FALSE. Sin estos
      // defaults el mock las deja fuera de cualquier .eq(col, valor) que
      // dependa de ellas.
      const inserted = rows.map((r) => ({ id: r.id || uuid(), created_at: new Date().toISOString(), activo: true, descontado: false, ...r }));
      state.db[table].push(...inserted);
      if (wantsRepresentation) {
        const payload = wantsSingle ? inserted[0] : inserted;
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(payload) });
      }
      return route.fulfill({ status: 201, contentType: 'application/json', body: '' });
    }

    if (method === 'PATCH') {
      let body = {};
      try { body = req.postDataJSON(); } catch (_e) {}
      const matches = applyQuery(state.db[table], url.searchParams);
      const matchIds = new Set(matches.map((r) => r.id));
      state.db[table] = state.db[table].map((r) => (matchIds.has(r.id) ? { ...r, ...body } : r));
      const updated = state.db[table].filter((r) => matchIds.has(r.id));
      if (wantsRepresentation) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(wantsSingle ? updated[0] : updated) });
      }
      return route.fulfill({ status: 204, body: '' });
    }

    if (method === 'DELETE') {
      const matches = applyQuery(state.db[table], url.searchParams);
      const matchIds = new Set(matches.map((r) => r.id));
      state.db[table] = state.db[table].filter((r) => !matchIds.has(r.id));
      if (wantsRepresentation) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(matches) });
      }
      return route.fulfill({ status: 204, body: '' });
    }

    return route.fulfill({ status: 405, body: 'Method not mocked' });
  });

  // ---- STORAGE ----
  await page.route('**/storage/v1/object/**', async (route) => {
    state.calls.push({ type: 'storage', method: route.request().method() });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ Key: 'mock/path.png', path: 'mock/path.png' }) });
  });

  // ---- EDGE FUNCTIONS ----
  // Default: cualquier función no explícitamente mockeada por el test
  // devuelve un error controlado en vez de intentar salir a la red real.
  await page.route('**/functions/v1/**', async (route) => {
    const req = route.request();
    const fnName = new URL(req.url()).pathname.split('/functions/v1/')[1];
    let body = {};
    try { body = req.postDataJSON(); } catch (_e) {}
    state.calls.push({ type: 'function', fn: fnName, body });

    if (edgeFunctionHandlers[fnName]) {
      const result = await edgeFunctionHandlers[fnName](body, state);
      return route.fulfill({ status: result.status || 200, contentType: 'application/json', body: JSON.stringify(result.body ?? {}) });
    }

    // Default seguro: simula éxito vacío para notificaciones (no son
    // críticas para el flujo principal) y error explícito para todo lo demás
    // no cubierto, así un test que dependa de un mock faltante falla fuerte
    // y visible en vez de colgarse esperando una red que no existe.
    if (fnName && fnName.startsWith('notificar-')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    return route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({ error: `Edge function "${fnName}" no tiene mock configurado en este test` }) });
  });

  return state;
}

const test = base.extend({
  mockState: async ({ page }, use) => {
    const state = await installMockBackend(page, {});
    await use(state);
  },
});

module.exports = {
  test,
  expect,
  installMockBackend,
  createDb,
  seedNegocio,
  TEST_USER_ID,
  TEST_NEGOCIO_ID,
  TEST_EMAIL,
  TEST_PASSWORD,
};
