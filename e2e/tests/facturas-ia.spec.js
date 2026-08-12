// @ts-check
// MÓDULO LECTURA DE FACTURAS CON IA (Ingreso de Mercadería)
// Cubre: subida de foto → invocación de la edge function `leer-factura`
// (mockeada — NUNCA se llama a la IA real, tiene costo por ejecución),
// prellenado de la pantalla de revisión (proveedor/número/fecha/líneas),
// validación antes de guardar, y el caso límite de una línea sin producto
// vinculado en el inventario: cargarDatosFacturaIA() la agrega con
// prodId='' y confirmarIngresoFactura() la descarta SILENCIOSAMENTE
// (lineasIngreso.filter(l => l.prodId && l.cant>0)) — sin avisar cuál se
// perdió, más allá de que el conteo final del toast sea menor al detectado.
const { test, expect } = require('../fixtures/mockBackend');
const { loginConSesionSemilla, irAApp, esperarDashboard, autoAceptarDialogos, irAModulo } = require('../fixtures/helpers');
const { createDb, TEST_NEGOCIO_ID } = require('../fixtures/mockBackend');

function productoSemilla(overrides = {}) {
  return {
    id: 1700000000010,
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

/** Respuesta con la MISMA forma que devuelve la Anthropic Messages API real. */
function respuestaIA(facturaJson) {
  return { status: 200, body: { content: [{ text: JSON.stringify(facturaJson) }] } };
}

async function entrarAIngresoFactura(page, { productos = [], edgeFunctionHandlers = {} } = {}) {
  const db = createDb();
  db.productos_v2 = productos;
  const state = await loginConSesionSemilla(page, { db, edgeFunctionHandlers });
  autoAceptarDialogos(page);
  await irAApp(page);
  await esperarDashboard(page);
  await irAModulo(page, 'dash');
  await page.locator('.action-btn.ingreso').click();
  await page.waitForSelector('#modal-ingreso.on');
  return state;
}

/** El input de foto queda oculto (label con display:none) — setInputFiles funciona igual, dispara el onchange real. */
async function subirFotoFactura(page) {
  await page.locator('#factura-foto').setInputFiles({
    name: 'factura.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]),
  });
}

test.describe('Facturas IA: lectura exitosa', () => {
  test('sube una foto y la IA prellena proveedor, número, fecha y productos', async ({ page }) => {
    await entrarAIngresoFactura(page, {
      productos: [productoSemilla()],
      edgeFunctionHandlers: {
        'leer-factura': async () =>
          respuestaIA({
            proveedor: 'Distribuidora del Sur',
            numero: '0001-00045678',
            fecha: '2026-08-10',
            productos: [{ nombre: 'Coca-Cola 1.5L', cantidad: 10, precio_unitario: 850, subtotal: 8500 }],
            total: 8500,
          }),
      },
    });

    await subirFotoFactura(page);

    await expect(page.locator('#toast')).toContainText(/IA detecto.*Distribuidora del Sur/i, { timeout: 8000 });
    await expect(page.locator('#ing-prov')).toHaveValue('Distribuidora del Sur');
    await expect(page.locator('#ing-num')).toHaveValue('0001-00045678');
    await expect(page.locator('#ing-fecha')).toHaveValue('2026-08-10');
    await expect(page.locator('#ing-lineas select')).toHaveValue(String(productoSemilla().id));
  });

  test('confirmar el ingreso actualiza el stock y crea la factura', async ({ page }) => {
    const state = await entrarAIngresoFactura(page, {
      productos: [productoSemilla({ stock: 20 })],
      edgeFunctionHandlers: {
        // precio_unitario igual al costo ya cargado (800) a propósito: si
        // difiere, confirmarIngresoFactura() toma la rama de "cambio de
        // precios" (mostrarResumenPrecios) en vez de mostrar el toast de
        // éxito simple — ese flujo alternativo se cubre aparte.
        'leer-factura': async () =>
          respuestaIA({
            proveedor: 'Distribuidora del Sur',
            numero: '0001-1',
            fecha: '2026-08-10',
            productos: [{ nombre: 'Coca-Cola 1.5L', cantidad: 10, precio_unitario: 800, subtotal: 8000 }],
            total: 8000,
          }),
      },
    });
    await subirFotoFactura(page);
    await expect(page.locator('#toast')).toContainText(/IA detecto/i, { timeout: 8000 });

    await page.locator('#modal-ingreso button:has-text("Confirmar ingreso")').click();

    await expect(page.locator('#toast')).toContainText(/1 producto\(s\) ingresados/i, { timeout: 5000 });
    await expect.poll(() => state.db.productos_v2[0]?.stock, { timeout: 5000 }).toBe(30);
    await expect.poll(() => state.db.facturas_v2.length, { timeout: 5000 }).toBe(1);
    expect(state.db.facturas_v2[0].prov).toBe('Distribuidora del Sur');
  });

  test('una línea sin producto vinculado en el inventario se descarta silenciosamente al guardar', async ({ page }) => {
    const state = await entrarAIngresoFactura(page, {
      productos: [productoSemilla({ stock: 20 })],
      edgeFunctionHandlers: {
        'leer-factura': async () =>
          respuestaIA({
            proveedor: 'Distribuidora del Sur',
            numero: '0001-2',
            fecha: '2026-08-10',
            productos: [
              { nombre: 'Coca-Cola 1.5L', cantidad: 10, precio_unitario: 800, subtotal: 8000 },
              { nombre: 'Producto Nuevo Que No Existe', cantidad: 5, precio_unitario: 300, subtotal: 1500 },
            ],
            total: 9500,
          }),
      },
    });
    await subirFotoFactura(page);
    // La IA detectó 2 líneas — el toast lo confirma con el conteo bruto.
    await expect(page.locator('#toast')).toContainText(/2 productos/i, { timeout: 8000 });
    // La 2da línea no tiene ningún producto de inventario que coincida con el
    // nombre detectado, así que su <select> queda en el placeholder vacío.
    await expect(page.locator('#ing-lineas select').nth(1)).toHaveValue('');

    await page.locator('#modal-ingreso button:has-text("Confirmar ingreso")').click();

    // Solo 1 de las 2 líneas detectadas se guarda — la otra se pierde sin
    // ningún aviso puntual de cuál fue ("descartada silenciosamente").
    await expect(page.locator('#toast')).toContainText(/1 producto\(s\) ingresados/i, { timeout: 5000 });
    expect(state.db.productos_v2.length).toBe(1); // no se creó ningún producto nuevo
    await expect.poll(() => state.db.productos_v2[0]?.stock, { timeout: 5000 }).toBe(30);
  });
});

test.describe('Facturas IA: manejo de errores', () => {
  test('respuesta de la IA no interpretable como JSON: pide completar a mano', async ({ page }) => {
    await entrarAIngresoFactura(page, {
      edgeFunctionHandlers: {
        'leer-factura': async () => ({ status: 200, body: { content: [{ text: 'no puedo leer esta imagen, está borrosa' }] } }),
      },
    });
    await subirFotoFactura(page);
    await expect(page.locator('#toast')).toContainText(/No pude leer la factura/i, { timeout: 8000 });
  });

  test('falla de red o de la edge function: muestra error y no rompe la pantalla', async ({ page }) => {
    await entrarAIngresoFactura(page);
    // Un 500 con body JSON válido no alcanza para probar esta rama: fetch no
    // rechaza la promesa por status HTTP, solo por falla real de red/conexión
    // — por eso la simulamos con route.abort() en vez de edgeFunctionHandlers.
    await page.route('**/functions/v1/leer-factura*', (route) => route.abort('failed'));
    await subirFotoFactura(page);
    await expect(page.locator('#toast')).toContainText(/Error al procesar la imagen/i, { timeout: 8000 });
    // La pantalla de ingreso sigue operable después del error.
    await expect(page.locator('#modal-ingreso.on')).toBeVisible();
    await page.locator('#ing-prov').fill('Proveedor manual');
    await expect(page.locator('#ing-prov')).toHaveValue('Proveedor manual');
  });
});

test.describe('Facturas IA: validaciones antes de guardar', () => {
  test('sin proveedor no se puede confirmar el ingreso', async ({ page }) => {
    await entrarAIngresoFactura(page, { productos: [productoSemilla()] });
    await page.locator('select[onchange^="selLinProd"]').first().selectOption(String(productoSemilla().id));
    await page.locator('input[data-field="cant"]').first().fill('3');
    await page.locator('#modal-ingreso button:has-text("Confirmar ingreso")').click();
    await expect(page.locator('#toast')).toContainText(/Ingresá el proveedor/i, { timeout: 5000 });
  });

  test('sin ninguna línea con producto y cantidad no se puede confirmar', async ({ page }) => {
    await entrarAIngresoFactura(page, { productos: [productoSemilla()] });
    await page.locator('#ing-prov').fill('Proveedor X');
    await page.locator('#modal-ingreso button:has-text("Confirmar ingreso")').click();
    await expect(page.locator('#toast')).toContainText(/Agregá al menos un producto/i, { timeout: 5000 });
  });
});
