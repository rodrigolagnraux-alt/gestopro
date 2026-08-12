// @ts-check
// MÓDULO FIADO / CUENTAS CORRIENTES
// Cubre: alta de cliente, registro de deuda vía cobro (pagoActual==='fiado'
// en confirmarCobro → registrarFiadoCliente), pagos parciales/totales
// (pagarFiado, con cálculo FIFO en calcularDeudaPendiente) y bloqueo por
// límite de crédito.
const { test, expect } = require('../fixtures/mockBackend');
const { loginConSesionSemilla, irAApp, esperarDashboard, autoAceptarDialogos, irAModulo, abrirMenuSiHaceFalta } = require('../fixtures/helpers');
const AYER = new Date(Date.now() - 86400000).toISOString();
const { createDb, TEST_NEGOCIO_ID } = require('../fixtures/mockBackend');

function clienteFiadoSemilla(overrides = {}) {
  return {
    id: 'cli-e2e-1',
    negocio_id: TEST_NEGOCIO_ID,
    nom: 'Juan García',
    tel: '2473123456',
    email: '',
    limite: 0,
    via_libre: false,
    deuda: 0,
    activo: true,
    ...overrides,
  };
}

async function entrarAFiado(page, { clientes = [], movimientos = [] } = {}) {
  const db = createDb();
  db.fiados_clientes = clientes;
  db.fiados_movimientos = movimientos;
  const state = await loginConSesionSemilla(page, { db });
  autoAceptarDialogos(page);
  await irAApp(page);
  await esperarDashboard(page);
  await irAModulo(page, 'fiado');
  return state;
}

/** El botón "Cobrar" vive en el Dashboard — abre la caja (cajero=dueño) desde ahí. */
async function abrirCajaDesde(page) {
  await irAModulo(page, 'dash');
  const btnCobrar = page.locator('[onclick*="abrirCobrar"]').first();
  await abrirMenuSiHaceFalta(page, btnCobrar);
  await btnCobrar.click();
  await page.waitForSelector('#modal-sesion-caja.on', { timeout: 8000 });
  await page.locator('#caja-cajero-sel').selectOption('dueno');
  await page.locator('#caja-pin-inp').fill('1111');
  await page.locator('#modal-sesion-caja button:has-text("Abrir")').click();
  await page.waitForSelector('#modal-cobrar.on', { timeout: 8000 });
}

test.describe('Fiado: alta de cliente', () => {
  test('crear un cliente nuevo lo agrega a la lista sin deuda', async ({ page }) => {
    await entrarAFiado(page);
    await page.locator('button:has-text("+ Cliente")').click();
    await page.waitForSelector('#modal-fiado-nuevo.on');

    await page.locator('#fn-nombre').fill('María López');
    await page.locator('#fn-limite').fill('5000');
    await page.locator('#modal-fiado-nuevo button:has-text("Guardar cliente")').click();

    await expect(page.locator('#toast')).toContainText(/agregado/i, { timeout: 5000 });
    await expect(page.locator('#fiado-lista')).toContainText('María López');
    await expect(page.locator('#fiado-lista')).toContainText('Saldado');
  });

  test('nombre vacío bloquea el guardado', async ({ page }) => {
    await entrarAFiado(page);
    await page.locator('button:has-text("+ Cliente")').click();
    await page.waitForSelector('#modal-fiado-nuevo.on');
    await page.locator('#modal-fiado-nuevo button:has-text("Guardar cliente")').click();
    await expect(page.locator('#toast')).toContainText(/nombre del cliente/i, { timeout: 5000 });
  });
});

test.describe('Fiado: registro de deuda vía cobro', () => {
  test('cobrar con método fiado crea la deuda en el cliente elegido', async ({ page }) => {
    const state = await entrarAFiado(page, { clientes: [clienteFiadoSemilla()] });
    await abrirCajaDesde(page);

    await page.locator('#cobrar-monto').fill('1500');
    await page.locator('#pm-fiado').click();
    await page.locator('#fiado-cliente-sel').selectOption('cli-e2e-1');
    await page.locator('#modal-cobrar button:has-text("Confirmar cobro")').click();

    await expect(page.locator('#toast')).toContainText(/Fiado cargado/i, { timeout: 8000 });
    await expect.poll(() => state.db.fiados_clientes[0]?.deuda, { timeout: 5000 }).toBe(1500);
  });

  test('el límite de crédito ya superado bloquea nuevas compras a fiado', async ({ page }) => {
    const state = await entrarAFiado(page, { clientes: [clienteFiadoSemilla({ limite: 1000, deuda: 1000 })] });
    await abrirCajaDesde(page);

    await page.locator('#cobrar-monto').fill('500');
    await page.locator('#pm-fiado').click();
    await page.locator('#fiado-cliente-sel').selectOption('cli-e2e-1');
    await page.locator('#modal-cobrar button:has-text("Confirmar cobro")').click();

    await expect(page.locator('#toast')).toContainText(/superó el límite/i, { timeout: 5000 });
    // La deuda no debe haber cambiado — la compra quedó bloqueada.
    expect(state.db.fiados_clientes[0].deuda).toBe(1000);
  });
});

// calcularDeudaPendiente recalcula la deuda en base al historial de
// fiados_movimientos (FIFO), no toma el campo `deuda` del cliente como dato
// de verdad si no hay ningún movimiento tipo "deuda" que lo respalde — por
// eso los tests de pago necesitan sembrar el movimiento de deuda original,
// no solo el campo `deuda` en el cliente (que en la app real siempre viene
// acompañado de su fiados_movimientos correspondiente).
function movimientoDeudaSemilla(clienteId, monto) {
  return {
    id: 'mov-deuda-1',
    negocio_id: TEST_NEGOCIO_ID,
    cliente_id: clienteId,
    tipo: 'deuda',
    monto,
    descripcion: 'Compra fiada',
    fecha: AYER.slice(0, 10),
    created_at: AYER,
  };
}

test.describe('Fiado: pagos', () => {
  test('un pago parcial reduce la deuda sin saldarla', async ({ page }) => {
    const state = await entrarAFiado(page, {
      clientes: [clienteFiadoSemilla({ deuda: 1000 })],
      movimientos: [movimientoDeudaSemilla('cli-e2e-1', 1000)],
    });
    await page.locator('.fiado-item').click();
    await page.waitForSelector('#modal-fiado-detalle.on');

    await page.locator('#fd-pago').fill('400');
    await page.locator('#modal-fiado-detalle button:has-text("Registrar pago")').click();

    await expect(page.locator('#toast')).toContainText(/Pago registrado/i, { timeout: 8000 });
    await expect.poll(() => state.db.fiados_clientes[0]?.deuda, { timeout: 5000 }).toBe(600);
  });

  test('pagar el total exacto salda al cliente', async ({ page }) => {
    const state = await entrarAFiado(page, {
      clientes: [clienteFiadoSemilla({ deuda: 1000 })],
      movimientos: [movimientoDeudaSemilla('cli-e2e-1', 1000)],
    });
    await page.locator('.fiado-item').click();
    await page.waitForSelector('#modal-fiado-detalle.on');

    await page.locator('#fd-pago').fill('1000');
    await page.locator('#modal-fiado-detalle button:has-text("Registrar pago")').click();

    await expect(page.locator('#toast')).toContainText(/Pago registrado/i, { timeout: 8000 });
    await expect.poll(() => state.db.fiados_clientes[0]?.deuda, { timeout: 5000 }).toBe(0);
    await expect(page.locator('#fiado-lista')).toContainText('Saldado');
  });

  test('un pago mayor a la deuda pendiente es rechazado', async ({ page }) => {
    await entrarAFiado(page, {
      clientes: [clienteFiadoSemilla({ deuda: 1000 })],
      movimientos: [movimientoDeudaSemilla('cli-e2e-1', 1000)],
    });
    await page.locator('.fiado-item').click();
    await page.waitForSelector('#modal-fiado-detalle.on');

    await page.locator('#fd-pago').fill('5000');
    await page.locator('#modal-fiado-detalle button:has-text("Registrar pago")').click();
    await expect(page.locator('#toast')).toContainText(/supera la deuda/i, { timeout: 5000 });
  });
});
