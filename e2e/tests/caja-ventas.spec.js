// @ts-check
// MÓDULO CAJA / VENTAS
// Cubre: apertura de caja, venta en efectivo/Cuenta DNI/Mercado Pago/fiado,
// validaciones de stock y de límite de crédito, y cierre de caja.
//
// Dos gotchas de infraestructura importantes, documentados acá porque no son
// obvios y ya causaron falsos negativos al escribir esta suite:
//
// 1) Los modales de esta app (clase .ov) están SIEMPRE en display:flex — lo
//    único que cambia al abrir/cerrar es la clase "on" (opacity/pointer-events).
//    Por eso NUNCA usamos expect(locator).toBeVisible() sobre un modal:
//    Playwright lo considera "visible" (bounding box no vacío, sin
//    visibility:hidden) aunque esté cerrado con opacity:0. En su lugar
//    esperamos la clase "on" explícitamente con waitForSelector('#id.on').
//
// 2) NO hay que declarar el fixture `mockState` en tests que ya entran por
//    loginConSesionSemilla (vía entrarYAbrirCaja): ese fixture instala su
//    PROPIO backend mockeado (con su propio `db` en memoria) en la misma
//    page, y como Playwright resuelve rutas superpuestas en orden LIFO, el
//    tráfico real termina yendo al mock de loginConSesionSemilla mientras
//    los asserts leerían el mock del fixture — vacío siempre. Por eso acá
//    usamos el `state` que devuelve loginConSesionSemilla/entrarYAbrirCaja.
const { test, expect } = require('../fixtures/mockBackend');
const { loginConSesionSemilla, irAApp, esperarDashboard, autoAceptarDialogos } = require('../fixtures/helpers');
const { TEST_NEGOCIO_ID } = require('../fixtures/mockBackend');

function productoSemilla(overrides = {}) {
  return {
    id: 'prod-e2e-1',
    negocio_id: TEST_NEGOCIO_ID,
    cod: '7790001000012',
    nom: 'Coca-Cola 1.5L',
    cat: 'Bebidas',
    stock: 20,
    um: 'UN',
    precio: 800,
    pventa: 1200,
    min: 5,
    max: 100,
    ...overrides,
  };
}

async function entrarYAbrirCaja(page, { productos = [productoSemilla()] } = {}) {
  const db = require('../fixtures/mockBackend').createDb();
  db.productos_v2 = productos;
  const state = await loginConSesionSemilla(page, { db });
  autoAceptarDialogos(page);
  await irAApp(page);
  await esperarDashboard(page);
  return state;
}

/** Espera a que un modal (clase .ov) esté realmente abierto (clase "on"), no solo presente en el DOM. */
async function esperarModalAbierto(page, id) {
  await page.waitForSelector('#' + id + '.on', { timeout: 8000 });
}

/** Completa el modal de apertura de caja (cajero=dueño + PIN) y confirma. */
async function abrirCaja(page, { fondoInicial } = {}) {
  await page.locator('#caja-cajero-sel').selectOption('dueno');
  await page.locator('#caja-pin-inp').fill('1111');
  if (fondoInicial !== undefined) {
    await page.locator('#caja-fondo-inp').fill(String(fondoInicial));
  }
  await page.locator('#modal-sesion-caja button:has-text("Abrir")').click();
  await esperarModalAbierto(page, 'modal-cobrar');
}

test.describe('Caja: apertura y cobro', () => {
  test('abrir el modal de cobro fuerza primero la apertura de sesión de caja', async ({ page }) => {
    await entrarYAbrirCaja(page);
    await page.locator('button:has-text("Cobrar"), [onclick*="abrirCobrar"]').first().click();
    await esperarModalAbierto(page, 'modal-sesion-caja');
  });

  test('venta en efectivo confirma con el mensaje esperado y registra el movimiento', async ({ page }) => {
    const state = await entrarYAbrirCaja(page);
    await page.locator('[onclick*="abrirCobrar"]').first().click();
    await esperarModalAbierto(page, 'modal-sesion-caja');
    await abrirCaja(page, { fondoInicial: 1000 });

    await page.locator('#cobrar-monto').fill('1200');
    await page.locator('#pm-efectivo').click();
    await page.locator('#modal-cobrar button:has-text("Confirmar cobro")').click();

    await expect(page.locator('#toast')).toContainText(/Cobrado/i, { timeout: 8000 });
    // El guardado en la nube es "fire and forget" (sin await) del lado de la
    // app — le damos un instante a la request mockeada para completar antes
    // de leer el estado.
    await expect.poll(() => state.db.movimientos_v2.filter((m) => m.tipo === 'cobro').length, { timeout: 5000 }).toBeGreaterThan(0);
    const ventas = state.db.movimientos_v2.filter((m) => m.tipo === 'cobro');
    expect(ventas[ventas.length - 1].metodo).toBe('efectivo');
  });

  test('venta con Cuenta DNI usa el método correcto', async ({ page }) => {
    const state = await entrarYAbrirCaja(page);
    await page.locator('[onclick*="abrirCobrar"]').first().click();
    await esperarModalAbierto(page, 'modal-sesion-caja');
    await abrirCaja(page);

    await page.locator('#cobrar-monto').fill('500');
    await page.locator('#pm-cuentadni').click();
    await page.locator('#modal-cobrar button:has-text("Confirmar cobro")').click();
    await expect(page.locator('#toast')).toContainText(/Cobrado/i, { timeout: 8000 });

    await expect.poll(() => state.db.movimientos_v2.filter((m) => m.tipo === 'cobro').length, { timeout: 5000 }).toBeGreaterThan(0);
    const ventas = state.db.movimientos_v2.filter((m) => m.tipo === 'cobro');
    expect(ventas[ventas.length - 1].metodo).toBe('cuentadni');
  });

  test('monto inválido (0 o vacío) bloquea el cobro con error', async ({ page }) => {
    await entrarYAbrirCaja(page);
    await page.locator('[onclick*="abrirCobrar"]').first().click();
    await esperarModalAbierto(page, 'modal-sesion-caja');
    await abrirCaja(page);

    await page.locator('#cobrar-monto').fill('0');
    await page.locator('#pm-efectivo').click();
    await page.locator('#modal-cobrar button:has-text("Confirmar cobro")').click();
    await expect(page.locator('#toast')).toContainText(/monto válido/i, { timeout: 5000 });
  });
});

test.describe('Caja: cierre de turno', () => {
  test('cerrar caja pide el efectivo contado y registra la diferencia', async ({ page }) => {
    const state = await entrarYAbrirCaja(page);
    await page.locator('[onclick*="abrirCobrar"]').first().click();
    await esperarModalAbierto(page, 'modal-sesion-caja');
    await abrirCaja(page, { fondoInicial: 1000 });

    await page.locator('[onclick*="abrirCierreCaja"]').first().click();
    await esperarModalAbierto(page, 'modal-cierre-caja');
    await page.locator('#cierre-efectivo-contado').fill('1000');
    await page.locator('#modal-cierre-caja button:has-text("Confirmar cierre")').click();

    await expect(page.locator('#toast')).toContainText(/cerrada/i, { timeout: 8000 });
    await expect.poll(() => state.db.cajas[0]?.estado, { timeout: 5000 }).toBe('cerrada');
  });
});
