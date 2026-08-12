// @ts-check
// AUTENTICACIÓN Y ONBOARDING
// Cubre: login, registro, confirmación de código de 8 dígitos, persistencia
// de sesión, y la lógica de redirección según estado de aprobación/plan/trial
// (verificarAccesoNegocio en app/index.html).
const { test, expect } = require('../fixtures/mockBackend');
const { seedNegocio, TEST_EMAIL } = require('../fixtures/mockBackend');
const { loginConSesionSemilla, irAApp, esperarDashboard, autoAceptarDialogos, abrirMenuSiHaceFalta } = require('../fixtures/helpers');

test.describe('Login', () => {
  test('campos vacíos: muestra error client-side, sin llamar al backend', async ({ page, mockState }) => {
    await page.goto('/app/');
    await page.locator('#login-form button:has-text("Entrar")').click();
    await expect(page.locator('#login-error')).toBeVisible();
    await expect(page.locator('#login-error')).toHaveText(/Completa email y contrasena/i);
    expect(mockState.calls.filter((c) => c.type === 'auth')).toHaveLength(0);
  });

  test('credenciales inválidas: muestra el error real de Supabase', async ({ page, mockState }) => {
    await page.goto('/app/');
    await page.locator('#login-email').fill('test@test.com');
    await page.locator('#login-pass').fill('123'); // <6 chars → nuestro mock lo trata como inválido
    await page.locator('#login-form button:has-text("Entrar")').click();
    await expect(page.locator('#login-error')).toBeVisible();
    await expect(page.locator('#login-error')).toHaveText(/Email o contrasena incorrectos/i);
  });

  test('credenciales válidas: entra al dashboard (vía onAuthStateChange, no vía el .then() del login)', async ({ page, mockState }) => {
    await page.goto('/app/');
    await page.locator('#login-email').fill(TEST_EMAIL);
    await page.locator('#login-pass').fill('password123');
    await page.locator('#login-form button:has-text("Entrar")').click();
    await esperarDashboard(page);
    await expect(page.locator('#pg-dash')).toBeVisible();
  });
});

test.describe('Registro', () => {
  test('campos vacíos: muestra error client-side', async ({ page, mockState }) => {
    await page.goto('/app/');
    // El link "Registrate gratis" es un <span onclick>, no un <a>: entramos
    // directo por la función que dispara para evitar depender del markup exacto.
    await page.evaluate(() => { if (typeof mostrarRegistro === 'function') mostrarRegistro(); });
    await page.locator('#register-form button:has-text("Crear cuenta")').click();
    await expect(page.locator('#reg-error')).toBeVisible();
    await expect(page.locator('#reg-error')).toHaveText(/Completa todos los campos/i);
  });

  test('contraseña corta: muestra error client-side sin llamar a signUp', async ({ page, mockState }) => {
    await page.goto('/app/');
    await page.evaluate(() => { if (typeof mostrarRegistro === 'function') mostrarRegistro(); });
    await page.locator('#reg-nombre').fill('Mi Negocio Test');
    await page.locator('#reg-email').fill('nuevo@test.com');
    await page.locator('#reg-pass').fill('12345'); // 5 chars
    await page.locator('#register-form button:has-text("Crear cuenta")').click();
    await expect(page.locator('#reg-error')).toHaveText(/minimo 6 caracteres/i);
    expect(mockState.calls.filter((c) => c.type === 'auth' && c.op === 'signup')).toHaveLength(0);
  });

  test('alta válida sin sesión inmediata: pasa a pantalla de código de 8 dígitos', async ({ page, mockState }) => {
    await page.goto('/app/');
    await page.evaluate(() => { if (typeof mostrarRegistro === 'function') mostrarRegistro(); });
    await page.locator('#reg-nombre').fill('Mi Negocio Test');
    await page.locator('#reg-email').fill('nuevo@test.com');
    await page.locator('#reg-pass').fill('password123');
    await page.locator('#register-form button:has-text("Crear cuenta")').click();
    await expect(page.locator('#confirm-form')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('#confirm-email-lbl')).toHaveText('nuevo@test.com');
  });

  test('código de confirmación con longitud inválida: error client-side', async ({ page, mockState }) => {
    await page.goto('/app/');
    await page.evaluate(() => { if (typeof mostrarConfirmarCodigo === 'function') mostrarConfirmarCodigo('nuevo@test.com'); });
    await page.locator('#confirm-code').fill('123');
    await page.locator('#confirm-form button:has-text("Confirmar")').click();
    await expect(page.locator('#confirm-error')).toHaveText(/8 dígitos/i);
  });

  test('código incorrecto: muestra error del backend', async ({ page, mockState }) => {
    await page.goto('/app/');
    await page.evaluate(() => { if (typeof mostrarConfirmarCodigo === 'function') mostrarConfirmarCodigo('nuevo@test.com'); });
    await page.locator('#confirm-code').fill('99999999'); // convención del mock: siempre inválido
    await page.locator('#confirm-form button:has-text("Confirmar")').click();
    await expect(page.locator('#confirm-error')).toHaveText(/incorrecto o vencido/i);
  });

  test('código correcto: establece sesión y entra al dashboard', async ({ page, mockState }) => {
    await page.goto('/app/');
    await page.evaluate(() => { if (typeof mostrarConfirmarCodigo === 'function') mostrarConfirmarCodigo('nuevo@test.com'); });
    await page.locator('#confirm-code').fill('12345678');
    await page.locator('#confirm-form button:has-text("Confirmar")').click();
    await esperarDashboard(page);
    await expect(page.locator('#pg-dash')).toBeVisible();
  });
});

test.describe('Persistencia de sesión', () => {
  test('con sesión válida en localStorage, recarga la página directo al dashboard (sin ver el login)', async ({ page }) => {
    await loginConSesionSemilla(page);
    await irAApp(page);
    await esperarDashboard(page);

    await page.reload();
    await esperarDashboard(page);
    await expect(page.locator('#pg-dash')).toBeVisible();
  });
});

test.describe('Logout', () => {
  test('cerrar sesión pide confirmación nativa y vuelve a la pantalla de login', async ({ page }) => {
    await loginConSesionSemilla(page);
    autoAceptarDialogos(page);
    await irAApp(page);
    await esperarDashboard(page);

    const btnLogout = page.locator('button:has-text("Cerrar sesión")');
    await abrirMenuSiHaceFalta(page, btnLogout);

    await btnLogout.click();
    await expect(page.locator('#login-screen')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('#login-form')).toBeVisible();
  });
});

test.describe('Redirección según estado de la cuenta (verificarAccesoNegocio)', () => {
  test('negocio con aprobado=false: muestra la pantalla de espera y no la app', async ({ page }) => {
    await loginConSesionSemilla(page, { negocioOverrides: { aprobado: false } });
    await irAApp(page);
    await expect(page.getByText('Tu cuenta está siendo revisada')).toBeVisible({ timeout: 10000 });
    // La función reemplaza document.body.innerHTML entero — confirmamos que
    // el resto de la UI de la app ya no está en el DOM.
    await expect(page.locator('#pg-dash')).toHaveCount(0);
  });

  test('trial vencido (35+ días desde el registro, plan gratis): redirige a paywall.html', async ({ page }) => {
    const fechaVieja = new Date(Date.now() - 40 * 86400000).toISOString();
    await loginConSesionSemilla(page, { negocioOverrides: { plan: 'gratis', fecha_registro: fechaVieja, trial_dias: 35 } });
    await irAApp(page);
    await page.waitForURL(/paywall\.html/, { timeout: 10000 });
    expect(page.url()).toContain('paywall.html');
  });

  test('plan pago vencido más allá del período de gracia (5 días): redirige a paywall.html', async ({ page }) => {
    const vencidoHaceMucho = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
    await loginConSesionSemilla(page, { negocioOverrides: { plan: 'basico', plan_vencimiento: vencidoHaceMucho } });
    await irAApp(page);
    await page.waitForURL(/paywall\.html/, { timeout: 10000 });
  });

  test('plan pago vencido pero DENTRO del período de gracia: deja pasar con aviso, no redirige', async ({ page }) => {
    const vencidoHace2Dias = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    await loginConSesionSemilla(page, { negocioOverrides: { plan: 'basico', plan_vencimiento: vencidoHace2Dias } });
    await irAApp(page);
    await esperarDashboard(page);
    await expect(page.locator('#pg-dash')).toBeVisible();
    await expect(page.locator('#toast')).toContainText(/venció/i, { timeout: 5000 });
  });

  test('trial activo con pocos días restantes: muestra aviso pero no bloquea', async ({ page }) => {
    const haceCasiUnMes = new Date(Date.now() - 33 * 86400000).toISOString(); // quedan 2 días de 35
    await loginConSesionSemilla(page, { negocioOverrides: { plan: 'gratis', fecha_registro: haceCasiUnMes, trial_dias: 35 } });
    await irAApp(page);
    await esperarDashboard(page);
    await expect(page.locator('#toast')).toContainText(/día.*de prueba/i, { timeout: 5000 });
  });
});
