// @ts-check
// MÓDULO REPORTES FINANCIEROS: Resumen, Flujo Financiero, Cierre Mensual
// Cubre: que los KPIs/tablas se calculan y renderizan correctamente a partir
// de datos mockeados client-side (renderResumen/renderFinanzas/renderCierreMensual
// en app/index.html, todas leen movimientos_v2/facturas_v2/empleados_semanas
// filtrados por mes vía gte/lte de fecha).
//
// IMPORTANTE para la lectura del reporte final: estos 3 módulos NO tienen
// ningún gráfico/canvas ni exportación real a Excel/PDF — son tarjetas KPI y
// listas de texto calculadas 100% client-side. Eso es el diseño actual de la
// app, no algo que esta suite encontró "roto". El test de este archivo lo
// deja verificado explícitamente (cuenta de <canvas> === 0) para que un
// futuro corredor de la suite no lo reporte por error como una regresión.
const { test, expect } = require('../fixtures/mockBackend');
const { loginConSesionSemilla, irAApp, esperarDashboard, irAModulo } = require('../fixtures/helpers');
const { createDb, TEST_NEGOCIO_ID } = require('../fixtures/mockBackend');

function fechaLocalStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dia}`;
}
const HOY = fechaLocalStr(new Date());

function movimiento(overrides) {
  return { id: 'mov-' + Math.random(), negocio_id: TEST_NEGOCIO_ID, fecha: HOY, created_at: new Date().toISOString(), ...overrides };
}

async function entrarAReporte(page, modulo, { movimientos = [], facturas = [] } = {}) {
  const db = createDb();
  db.movimientos_v2 = movimientos;
  db.facturas_v2 = facturas;
  const state = await loginConSesionSemilla(page, { db });
  await irAApp(page);
  await esperarDashboard(page);
  await irAModulo(page, modulo);
  return state;
}

test.describe('Resumen Financiero', () => {
  test('suma correctamente ingresos por método de pago, egresos y el balance del mes', async ({ page }) => {
    await entrarAReporte(page, 'resumen', {
      movimientos: [
        movimiento({ tipo: 'cobro', metodo: 'efectivo', monto: 1000 }),
        movimiento({ tipo: 'cobro', metodo: 'cuentadni', monto: 500 }),
        movimiento({ tipo: 'egreso', cat: 'GastoFijo', monto: 300 }),
      ],
    });

    await expect(page.locator('#res-ingresos')).toContainText('1.000');
    await expect(page.locator('#res-ingresos')).toContainText('500');
    await expect(page.locator('#res-ingresos')).toContainText('1.500'); // total cobrado
    await expect(page.locator('#res-egresos')).toContainText('300');
    // Balance = 1500 cobrado - 300 gastos = 1200.
    await expect(page.locator('#res-balance')).toContainText('1.200');
    await expect(page.locator('#res-balance')).toContainText(/período positivo/i);
  });

  test('un mes sin movimientos muestra el período en $0 sin romperse', async ({ page }) => {
    await entrarAReporte(page, 'resumen');
    await expect(page.locator('#res-balance')).toContainText('$0');
  });
});

test.describe('Flujo Financiero', () => {
  test('calcula la ganancia real descontando gastos fijos del total vendido', async ({ page }) => {
    await entrarAReporte(page, 'finanzas', {
      movimientos: [
        movimiento({ tipo: 'cobro', metodo: 'efectivo', monto: 5000 }),
        movimiento({ tipo: 'egreso', cat: 'GastoFijo', monto: 1000 }),
      ],
    });

    await expect(page.locator('#fin-kpis')).toContainText('5.000'); // ventas
    await expect(page.locator('#fin-resultado')).toContainText(/Ganancia/i);
    await expect(page.locator('#fin-resultado')).toContainText('4.000'); // 5000 - 1000
  });

  test('no tiene ningún gráfico/canvas — son KPIs y listas de texto (no es un bug, es el diseño actual)', async ({ page }) => {
    await entrarAReporte(page, 'finanzas');
    expect(await page.locator('#pg-finanzas canvas').count()).toBe(0);
  });
});

test.describe('Cierre Mensual', () => {
  test('desglosa ventas, compras y gastos fijos pagados del mes', async ({ page }) => {
    await entrarAReporte(page, 'cierremensual', {
      movimientos: [
        movimiento({ tipo: 'cobro', metodo: 'efectivo', monto: 8000 }),
        movimiento({ tipo: 'egreso', cat: 'GastoFijo', monto: 2000, origen: null }),
      ],
    });

    await expect(page.locator('#cierre-desglose')).toContainText('8.000');
    await expect(page.locator('#cierre-desglose')).toContainText('2.000');
    await expect(page.locator('#cierre-desglose')).toContainText(/Ganancia neta/i);
    await expect(page.locator('#cierre-desglose')).toContainText('6.000'); // 8000 - 2000
  });

  test('el consumo propio (origen cierre_mensual) se desglosa aparte de los gastos fijos reales', async ({ page }) => {
    await entrarAReporte(page, 'cierremensual', {
      movimientos: [
        movimiento({ tipo: 'cobro', metodo: 'efectivo', monto: 10000 }),
        movimiento({ tipo: 'egreso', cat: 'GastoFijo', monto: 1500, origen: null }),
        movimiento({ tipo: 'egreso', cat: 'GastoFijo', monto: 800, origen: 'cierre_mensual' }),
      ],
    });

    await expect(page.locator('#cierre-desglose')).toContainText(/Gastos fijos pagados.*1\.500/is);
    await expect(page.locator('#cierre-desglose')).toContainText(/Consumo propio.*800/is);
  });
});
