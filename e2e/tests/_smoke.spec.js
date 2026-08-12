// @ts-check
const { test, expect } = require('../fixtures/mockBackend');
const { loginConSesionSemilla, irAApp, esperarDashboard, TEST_EMAIL, TEST_PASSWORD } = require('../fixtures/helpers');

test('smoke: la app carga el SDK real (vía mock de CDN) y llega a la pantalla de login', async ({ page, mockState }) => {
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  await page.goto('/app/');

  const supabaseDefined = await page.waitForFunction(() => typeof window.supabase !== 'undefined', null, { timeout: 8000 }).then(() => true).catch(() => false);
  expect(supabaseDefined, 'window.supabase debería estar definido (SDK real cargado vía mock de CDN)').toBe(true);

  await expect(page.locator('#login-screen')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#login-form')).toBeVisible();

  console.log('Errores de consola detectados:', JSON.stringify(consoleErrors, null, 2));
});

test('smoke: login por UI llega al dashboard', async ({ page, mockState }) => {
  await page.goto('/app/');
  await page.locator('#login-email').fill('cualquier-email@test.com');
  await page.locator('#login-pass').fill('cualquier-pass-123');
  await page.locator('#login-form button:has-text("Entrar")').click();
  await esperarDashboard(page);
  await expect(page.locator('#pg-dash')).toBeVisible();
});

test('smoke: sesión pre-semillada entra directo al dashboard sin login', async ({ page }) => {
  await loginConSesionSemilla(page);
  await irAApp(page);
  await esperarDashboard(page);
  await expect(page.locator('#pg-dash')).toBeVisible();
});
