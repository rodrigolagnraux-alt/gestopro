// @ts-check
// RUTAS, UI/UX Y ACCESIBILIDAD
// Cubre: enlaces internos rotos/404, elementos flotantes (botón WhatsApp),
// layout responsive en viewport mobile (390x844), que un modal abierto
// bloquee la interacción con lo que queda detrás, y manejo de errores de
// red (falla silenciosa al cargar el negocio).
const { test: base, expect } = require('../fixtures/mockBackend');
const { loginConSesionSemilla, irAApp, esperarDashboard } = require('../fixtures/helpers');
const { createDb } = require('../fixtures/mockBackend');

// La landing (index.html) no pasa por installMockBackend (no usa Supabase),
// así que sin esto su @import de Google Fonts sale a la red real — bloqueada
// por la política de egress de este sandbox, cada test tarda ~13s en el
// timeout en vez de fallar rápido. Es un artefacto del sandbox, no de la app.
const test = base.extend({
  page: async ({ page }, use) => {
    await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await use(page);
  },
});

test.describe('Landing page: enlaces y elementos flotantes', () => {
  test('carga sin errores de consola', async ({ page }) => {
    const errores = [];
    page.on('pageerror', (err) => errores.push(err.message));
    await page.goto('/index.html');
    await expect(page.locator('.wa-float')).toBeVisible();
    expect(errores).toEqual([]);
  });

  test('el botón flotante de WhatsApp abre wa.me en una pestaña nueva', async ({ page }) => {
    await page.goto('/index.html');
    const boton = page.locator('.wa-float');
    await expect(boton).toHaveAttribute('href', /^https:\/\/wa\.me\/\d+/);
    await expect(boton).toHaveAttribute('target', '_blank');
  });

  test('los links a Términos y Privacidad resuelven a páginas reales (no 404)', async ({ page }) => {
    await page.goto('/index.html');
    for (const texto of ['Términos y Condiciones', 'Política de Privacidad']) {
      const link = page.locator(`a:text-is("${texto}")`).first();
      const href = await link.getAttribute('href');
      const res = await page.request.get(href);
      expect(res.status(), `${texto} (${href}) debería responder 200`).toBe(200);
    }
  });

  test('los CTA "Probar/Empezar gratis" apuntan a /app/ y esa ruta carga', async ({ page }) => {
    await page.goto('/index.html');
    const ctas = page.locator('a[href="/app/"]');
    expect(await ctas.count()).toBeGreaterThan(0);
    const res = await page.request.get('/app/');
    expect(res.status()).toBe(200);
  });

  test('una ruta inexistente devuelve un 404 real (no un fallback silencioso a index)', async ({ page }) => {
    const res = await page.request.get('/esta-ruta-no-existe-nunca.html');
    expect(res.status()).toBe(404);
  });
});

test.describe('Responsive: viewport mobile 390x844', () => {
  test('la landing no tiene scroll horizontal', async ({ page }) => {
    await page.goto('/index.html');
    const [scrollWidth, clientWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(scrollWidth, 'la página no debería ser más ancha que el viewport (elemento desbordando)').toBeLessThanOrEqual(clientWidth + 1);
  });

  test('el dashboard de la app no tiene scroll horizontal', async ({ page }) => {
    await loginConSesionSemilla(page);
    await irAApp(page);
    await esperarDashboard(page);
    const [scrollWidth, clientWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(scrollWidth, 'el dashboard no debería desbordar horizontalmente en mobile').toBeLessThanOrEqual(clientWidth + 1);
  });
});

test.describe('Modales: bloquean la interacción con el fondo', () => {
  test('con un modal abierto, un click "a través" no llega a los botones del dashboard', async ({ page }) => {
    await loginConSesionSemilla(page);
    await irAApp(page);
    await esperarDashboard(page);

    await page.locator('.action-btn.producto').click(); // abre modal-prod
    await page.waitForSelector('#modal-prod.on');

    // Intentar clickear el botón "Cobrar" del dashboard, que queda detrás del
    // overlay — Playwright debe fallar por actionability (el overlay
    // intercepta el puntero) en vez de dispararlo silenciosamente a través
    // del modal.
    await expect(page.locator('.action-btn.cobrar').click({ timeout: 1500 })).rejects.toThrow(/intercepts pointer events/);
    await expect(page.locator('#modal-prod')).toHaveClass(/\bon\b/);

    await page.locator('#modal-prod button:has-text("Cancelar")').click();
    await expect(page.locator('#modal-prod')).not.toHaveClass(/\bon\b/);
  });
});

test.describe('Manejo de errores: red caída', () => {
  test('si falla la carga del negocio tras el login, la app no queda colgada en el splash', async ({ page }) => {
    const db = createDb();
    await loginConSesionSemilla(page, { db });
    // Sin esto el negocio cargaría normal — lo interceptamos para simular
    // una caída de red específicamente en la consulta de "negocios" que
    // hace cargarNegocio() justo después del login.
    await page.route('**/rest/v1/negocios*', (route) => route.abort('failed'));
    await irAApp(page);

    // cargarNegocio() atrapa el error en un .catch() que solo hace
    // console.log — la promesa se resuelve igual, así que ocultarLogin()
    // se ejecuta y el splash desaparece.
    await page.locator('#login-screen').waitFor({ state: 'hidden', timeout: 15000 });

    // Hallazgo real de UX: no hay NINGÚN toast ni mensaje de error visible
    // para el usuario — el dashboard queda montado pero sin negocio cargado
    // (currentNegocioId nunca se seteó), mostrando KPIs en $0 sin ninguna
    // pista de que en realidad hubo una falla de red y no "no hay datos".
    const toastVisible = await page.locator('#toast.on').isVisible().catch(() => false);
    expect(toastVisible, 'la app no muestra ningún aviso de error ante esta falla de red — queda en $0 silenciosamente').toBe(false);
  });
});
