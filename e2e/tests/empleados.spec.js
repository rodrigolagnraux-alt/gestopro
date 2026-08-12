// @ts-check
// MÓDULO EMPLEADOS
// Cubre: alta de empleado (con validación de PIN duplicado), registro de
// mercadería, anticipo, liquidación semanal con la fórmula real (horas
// normales + recargo domingo - anticipos - mercadería - deuda arrastrada de
// la semana anterior, ver cargarSemanaActual()/confirmarLiquidacion()), y
// validación de PIN de empleado vía RPC (verificar_pin_empleado) al abrir
// caja.
const { test, expect } = require('../fixtures/mockBackend');
const { loginConSesionSemilla, irAApp, esperarDashboard, autoAceptarDialogos, irAModulo, abrirMenuSiHaceFalta } = require('../fixtures/helpers');
const { createDb, TEST_NEGOCIO_ID } = require('../fixtures/mockBackend');

function empleadoSemilla(overrides = {}) {
  return {
    id: 'emp-e2e-1',
    negocio_id: TEST_NEGOCIO_ID,
    nombre: 'Pedro Gómez',
    rol: 'Repositor',
    valor_hora: 1000,
    pin_caja: '2222',
    activo: true,
    ...overrides,
  };
}

// Mismo cálculo que getLunesActual()/getDomingoActual() en app/index.html —
// lo replicamos en el test para poder sembrar horas dentro de "esta semana"
// sin importar qué día sea hoy cuando corra la suite.
function fechaLocalStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dia}`;
}
function lunesActual() {
  const hoy = new Date();
  const dia = hoy.getDay();
  const diff = dia === 0 ? -6 : 1 - dia;
  const lunes = new Date(hoy);
  lunes.setDate(hoy.getDate() + diff);
  lunes.setHours(0, 0, 0, 0);
  return lunes;
}
function domingoActual() {
  const lunes = lunesActual();
  const dom = new Date(lunes);
  dom.setDate(lunes.getDate() + 6);
  return dom;
}
function fechaLunesAnterior() {
  const lunes = lunesActual();
  const anterior = new Date(lunes);
  anterior.setDate(lunes.getDate() - 7);
  return anterior;
}

async function entrarAEmpleados(page, { empleados = [], db: extraDb = {} } = {}) {
  const db = createDb();
  db.empleados = empleados;
  Object.assign(db, extraDb);
  const state = await loginConSesionSemilla(page, { db });
  autoAceptarDialogos(page);
  await irAApp(page);
  await esperarDashboard(page);
  await irAModulo(page, 'empleados');
  return state;
}

test.describe('Empleados: alta', () => {
  test('crear un empleado nuevo lo agrega a la lista', async ({ page }) => {
    await entrarAEmpleados(page);
    await page.locator(':text-is("+ Nuevo empleado")').click();
    await page.waitForSelector('#modal-empleado.on');

    await page.locator('#emp-form-nombre').fill('Ana Torres');
    await page.locator('#emp-form-rol').fill('Cajera');
    await page.locator('#emp-form-valorhora').fill('1200');
    await page.locator('#emp-form-pin').fill('3333');
    await page.locator('#modal-empleado button:has-text("Guardar")').click();

    await expect(page.locator('#toast')).toContainText(/Empleado agregado/i, { timeout: 5000 });
    await expect(page.locator('#emp-lista-container')).toContainText('Ana Torres');
  });

  test('nombre vacío bloquea el guardado', async ({ page }) => {
    await entrarAEmpleados(page);
    await page.locator(':text-is("+ Nuevo empleado")').click();
    await page.waitForSelector('#modal-empleado.on');
    await page.locator('#emp-form-valorhora').fill('1000');
    await page.locator('#modal-empleado button:has-text("Guardar")').click();
    await expect(page.locator('#toast')).toContainText(/nombre del empleado/i, { timeout: 5000 });
  });

  test('valor por hora en 0 bloquea el guardado', async ({ page }) => {
    await entrarAEmpleados(page);
    await page.locator(':text-is("+ Nuevo empleado")').click();
    await page.waitForSelector('#modal-empleado.on');
    await page.locator('#emp-form-nombre').fill('Ana Torres');
    await page.locator('#modal-empleado button:has-text("Guardar")').click();
    await expect(page.locator('#toast')).toContainText(/valor por hora/i, { timeout: 5000 });
  });

  test('un PIN ya usado por otro empleado activo es rechazado', async ({ page }) => {
    await entrarAEmpleados(page, { empleados: [empleadoSemilla({ pin_caja: '2222' })] });
    await page.locator(':text-is("+ Nuevo empleado")').click();
    await page.waitForSelector('#modal-empleado.on');
    await page.locator('#emp-form-nombre').fill('Ana Torres');
    await page.locator('#emp-form-valorhora').fill('1000');
    await page.locator('#emp-form-pin').fill('2222');
    await page.locator('#modal-empleado button:has-text("Guardar")').click();
    await expect(page.locator('#toast')).toContainText(/ya lo usa Pedro Gómez/i, { timeout: 5000 });
  });
});

test.describe('Empleados: mercadería y anticipo', () => {
  test('registrar mercadería la descuenta del resumen semanal', async ({ page }) => {
    const state = await entrarAEmpleados(page, { empleados: [empleadoSemilla()] });
    await page.locator('.fiado-item').click();
    await page.waitForSelector('#emp-vista-detalle', { state: 'visible' });

    await page.locator('button:has-text("🛒 Mercadería")').click();
    await page.waitForSelector('#modal-emp-mercaderia.on');
    await page.locator('#emp-merc-prod').fill('Fideos');
    await page.locator('#emp-merc-cant').fill('2');
    await page.locator('#emp-merc-precio').fill('500');
    await page.locator('#modal-emp-mercaderia button:has-text("Registrar")').click();

    await expect(page.locator('#toast')).toContainText(/Mercadería registrada.*\$1\.000/i, { timeout: 5000 });
    await expect.poll(() => state.db.empleados_mercaderia.length, { timeout: 5000 }).toBe(1);
    expect(state.db.empleados_mercaderia[0].total).toBe(1000);
    await expect(page.locator('#emp-sw-merc')).toContainText('1.000');
  });

  test('un anticipo se registra como egreso y aparece en el resumen semanal', async ({ page }) => {
    const state = await entrarAEmpleados(page, { empleados: [empleadoSemilla()] });
    await page.locator('.fiado-item').click();
    await page.waitForSelector('#emp-vista-detalle', { state: 'visible' });

    await page.locator('button:has-text("💵 Anticipo"), button[onclick="abrirModalAnticipo()"]').first().click();
    await page.waitForSelector('#modal-emp-anticipo.on');
    await page.locator('#emp-anticipo-monto').fill('2000');
    await page.locator('#modal-emp-anticipo button:has-text("Registrar")').click();

    await expect(page.locator('#toast')).toContainText(/Anticipo de \$2\.000 registrado/i, { timeout: 5000 });
    await expect.poll(() => state.db.empleados_semanas.length, { timeout: 5000 }).toBe(1);
    expect(state.db.empleados_semanas[0].anticipos).toBe(2000);
    await expect(page.locator('#emp-sw-anticipos')).toContainText('2.000');
  });
});

test.describe('Empleados: liquidación semanal', () => {
  test('la liquidación calcula horas normales + recargo domingo - anticipos - mercadería', async ({ page }) => {
    const lunes = fechaLocalStr(lunesActual());
    const domingoDeEstaSemana = new Date(lunesActual());
    domingoDeEstaSemana.setDate(domingoDeEstaSemana.getDate() + 6);
    const domingoStr = fechaLocalStr(domingoDeEstaSemana);

    const state = await entrarAEmpleados(page, {
      empleados: [empleadoSemilla({ valor_hora: 1000 })],
      db: {
        // 8hs un día de semana (normal) + 4hs el domingo (recargo 50% seteado
        // en loginConSesionSemilla → config.recargoDomingo:50).
        empleados_horas: [
          { id: 'h1', negocio_id: TEST_NEGOCIO_ID, empleado_id: 'emp-e2e-1', fecha: lunes, horas: 8 },
          { id: 'h2', negocio_id: TEST_NEGOCIO_ID, empleado_id: 'emp-e2e-1', fecha: domingoStr, horas: 4 },
        ],
        empleados_mercaderia: [
          { id: 'm1', negocio_id: TEST_NEGOCIO_ID, empleado_id: 'emp-e2e-1', producto_nom: 'Fideos', cantidad: 1, total: 1000, descontado: false },
        ],
      },
    });
    await page.locator('.fiado-item').click();
    await page.waitForSelector('#emp-vista-detalle', { state: 'visible' });

    // montoNormal = 8*1000=8000, montoDomingo = 4*1000*1.5=6000 → bruto 14000
    // - mercadería 1000 = 13000 a liquidar, sin anticipos ni deuda previa.
    await expect(page.locator('#emp-sw-total')).toContainText('13.000', { timeout: 8000 });

    await page.locator('button[onclick="abrirModalLiquidar()"]').click();
    await page.waitForSelector('#modal-emp-liquidar.on');
    await expect(page.locator('#liq-total')).toContainText('13.000');
    await page.locator('#modal-emp-liquidar button:has-text("Confirmar")').click();

    await expect(page.locator('#toast')).toContainText(/Semana liquidada.*13\.000/i, { timeout: 8000 });
    await expect.poll(() => state.db.empleados_semanas[0]?.total_pagado, { timeout: 5000 }).toBe(13000);
    expect(state.db.empleados_semanas[0].pagado).toBe(true);
    expect(state.db.empleados_mercaderia[0].descontado).toBe(true);
  });

  test('la deuda de la semana anterior se arrastra y reduce el sueldo a liquidar', async ({ page }) => {
    const lunes = fechaLocalStr(lunesActual());
    const lunesAnterior = fechaLocalStr(fechaLunesAnterior());
    const domingoAnterior = fechaLocalStr(new Date(fechaLunesAnterior().getTime() + 6 * 86400000));

    const state = await entrarAEmpleados(page, {
      empleados: [empleadoSemilla({ valor_hora: 1000 })],
      db: {
        empleados_horas: [{ id: 'h1', negocio_id: TEST_NEGOCIO_ID, empleado_id: 'emp-e2e-1', fecha: lunes, horas: 5 }],
        // Semana anterior ya liquidada, con deuda pendiente de $2000 (la
        // mercadería/anticipos superaron el sueldo esa semana).
        empleados_semanas: [
          {
            id: 'sem-anterior',
            negocio_id: TEST_NEGOCIO_ID,
            empleado_id: 'emp-e2e-1',
            semana_inicio: lunesAnterior,
            semana_fin: domingoAnterior,
            pagado: true,
            deuda_pendiente: 2000,
          },
        ],
      },
    });
    await page.locator('.fiado-item').click();
    await page.waitForSelector('#emp-vista-detalle', { state: 'visible' });

    // montoNormal = 5*1000=5000 - deuda arrastrada 2000 = 3000.
    await expect(page.locator('#emp-sw-deuda-row')).toBeVisible();
    await expect(page.locator('#emp-sw-total')).toContainText('3.000', { timeout: 8000 });
  });
});

test.describe('Empleados: PIN vía RPC al abrir caja', () => {
  test('un empleado con PIN correcto puede abrir caja', async ({ page }) => {
    await entrarAEmpleados(page, { empleados: [empleadoSemilla({ pin_caja: '2222' })] });
    await irAModulo(page, 'dash');
    const btnCobrar = page.locator('[onclick*="abrirCobrar"]').first();
    await abrirMenuSiHaceFalta(page, btnCobrar);
    await btnCobrar.click();
    await page.waitForSelector('#modal-sesion-caja.on');

    await page.locator('#caja-cajero-sel').selectOption('emp-e2e-1');
    await page.locator('#caja-pin-inp').fill('2222');
    await page.locator('#modal-sesion-caja button:has-text("Abrir")').click();

    await page.waitForSelector('#modal-cobrar.on', { timeout: 8000 });
    await expect(page.locator('#caja-cajero-nombre')).toHaveText('Pedro Gómez');
  });

  test('un PIN incorrecto de empleado es rechazado por la verificación', async ({ page }) => {
    await entrarAEmpleados(page, { empleados: [empleadoSemilla({ pin_caja: '2222' })] });
    await irAModulo(page, 'dash');
    const btnCobrar = page.locator('[onclick*="abrirCobrar"]').first();
    await abrirMenuSiHaceFalta(page, btnCobrar);
    await btnCobrar.click();
    await page.waitForSelector('#modal-sesion-caja.on');

    await page.locator('#caja-cajero-sel').selectOption('emp-e2e-1');
    await page.locator('#caja-pin-inp').fill('9999');
    await page.locator('#modal-sesion-caja button:has-text("Abrir")').click();

    await expect(page.locator('#caja-pin-error')).toContainText(/PIN incorrecto/i, { timeout: 5000 });
    await expect(page.locator('#modal-cobrar')).not.toHaveClass(/\bon\b/);
  });
});
