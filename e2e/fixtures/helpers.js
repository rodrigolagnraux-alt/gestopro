// @ts-check
const { installMockBackend, createDb, seedNegocio, TEST_USER_ID, TEST_EMAIL, TEST_PASSWORD } = require('./mockBackend');

const SESSION_STORAGE_KEY = 'sb-hnaewjnvxlvywnihxkgv-auth-token';

/**
 * Instala el mock de backend y pre-siembra una sesión válida en
 * localStorage (mismo formato que persiste supabase-js) para entrar
 * directo al dashboard sin pasar por la UI de login en cada test — el
 * flujo de login/registro real en sí se prueba a fondo en auth.spec.js.
 *
 * Por default el negocio de test queda en plan "business" sin PIN de caja
 * configurado, para poder recorrer TODOS los módulos del sidebar sin que
 * el gate de plan (`goLocked`) ni el de PIN (`goConPin`) bloqueen la
 * navegación — no es lo que tendría un negocio real, es a propósito para
 * poder testear cada módulo de forma aislada.
 */
async function loginConSesionSemilla(page, { db, negocioOverrides = {}, edgeFunctionHandlers = {} } = {}) {
  const seededDb = db || createDb();
  seededDb.negocios = [
    seedNegocio({
      plan: 'business',
      config: JSON.stringify({
        nombre: 'Almacén E2E Test',
        alias: 'almacen.e2e.test',
        cvu: '0000003100000000000000',
        recargoDomingo: 50,
        pin: '', // sin PIN de caja: bypassea el gate de goConPin a propósito
        tel: '5491100000000',
        emailDueno: TEST_EMAIL,
      }),
      ...negocioOverrides,
    }),
  ];

  const state = await installMockBackend(page, { db: seededDb, edgeFunctionHandlers });

  const session = {
    access_token: state._fakeAccessTokenFor ? state._fakeAccessTokenFor(TEST_USER_ID) : undefined,
  };

  // Semilla de sesión: usamos el mismo helper interno que usa el mock de
  // /auth/v1/token para que el shape sea idéntico al que el SDK ya sabe leer.
  await page.addInitScript(
    ({ key, userId, email }) => {
      // Construye el mismo JWT-shape que el fixture usa en el servidor mock,
      // así el SDK lo acepta como sesión local válida sin necesitar red.
      function b64url(obj) {
        return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      }
      const header = b64url({ alg: 'HS256', typ: 'JWT' });
      const payload = b64url({ sub: userId, email, role: 'authenticated', aud: 'authenticated', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });
      const accessToken = `${header}.${payload}.mock-signature`;
      const sessionObj = {
        access_token: accessToken,
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: 'mock-refresh-token-' + userId,
        user: {
          id: userId, aud: 'authenticated', role: 'authenticated', email,
          email_confirmed_at: new Date().toISOString(), app_metadata: { provider: 'email', providers: ['email'] },
          user_metadata: {}, identities: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        },
      };
      localStorage.setItem(key, JSON.stringify(sessionObj));
    },
    { key: SESSION_STORAGE_KEY, userId: TEST_USER_ID, email: TEST_EMAIL }
  );

  return state;
}

/** Navega a la app y espera a que termine de resolver la sesión inicial (login visible u oculto). */
async function irAApp(page) {
  await page.goto('/app/');
}

/** Espera a que el dashboard esté realmente visible (negocio cargado, login oculto). */
async function esperarDashboard(page) {
  await page.locator('#pg-dash.on').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('#login-screen').waitFor({ state: 'hidden', timeout: 15000 });
}

/** Acepta automáticamente cualquier confirm()/alert() nativo del navegador (ej. eliminar producto, cerrar sesión). */
function autoAceptarDialogos(page) {
  page.on('dialog', (dialog) => dialog.accept());
}

/**
 * En mobile (<=700px) el sidebar arranca fuera de pantalla (position:fixed,
 * left:-210px) y solo entra con la clase "on" al tocar el botón ☰
 * (toggleSB()) — ese botón no tiene display:none propio en desktop, así que
 * en vez de basarnos en su visibilidad chequeamos si el elemento objetivo ya
 * está dentro del viewport actual; si no, recién ahí abrimos el sidebar.
 * go() ya se encarga de cerrarlo (closeSB()) después de navegar.
 */
async function abrirMenuSiHaceFalta(page, locator) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  const fueraDePantalla = !box || !viewport || box.x < 0 || box.x > viewport.width;
  if (fueraDePantalla) await page.locator('.mbtn').click();
}

/** Navega a un módulo del sidebar por el id que usa go()/goLocked()/goConPin(), ej. 'productos', 'fiado'. */
async function irAModulo(page, moduloId) {
  const item = page.locator(`.sb-i[onclick*="'${moduloId}'"]`).first();
  await abrirMenuSiHaceFalta(page, item);
  await item.click();
  await page.locator(`#pg-${moduloId}.on`).waitFor({ state: 'visible', timeout: 10000 });
}

module.exports = {
  SESSION_STORAGE_KEY,
  loginConSesionSemilla,
  irAApp,
  esperarDashboard,
  autoAceptarDialogos,
  irAModulo,
  abrirMenuSiHaceFalta,
  TEST_USER_ID,
  TEST_EMAIL,
  TEST_PASSWORD,
};
