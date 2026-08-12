// @ts-check
// MÓDULO INVENTARIO / PRODUCTOS
// Cubre: alta, edición, filtrado, eliminación y clasificación visual de
// stock (SIN STOCK / CRÍTICO / MÍNIMO / MÁXIMO / OK) — ver estadoProd() en
// app/index.html.
//
// Notas de infraestructura (evitan falsos negativos al escribir esta suite):
// 1) La app renderiza SIEMPRE ambos listados de productos — tabla
//    #tbl-prods (desktop) y cards #mc-prods (mobile) — y alterna cuál se ve
//    por CSS. Para CLICKS usamos el pseudo-selector ":visible" de Playwright
//    como sufijo directo (ej. "button:visible"), nunca encadenado con ">>"
//    (":visible >> .algo" NO filtra por ancestro oculto correctamente y
//    termina resolviendo también elementos dentro del dashboard oculto). Para
//    LEER contenido (no clickear) usamos siempre #mc-prods como fuente única
//    de verdad, ya que el texto es idéntico en ambos listados.
// 2) El dashboard tiene su propia lista de "Productos bajo mínimo"
//    (#dash-alertas) con los mismos badges .bdg — por eso nunca usamos un
//    selector ".bdg" desnudo sin acotarlo a #mc-prods o #tbl-prods.
const { test, expect } = require('../fixtures/mockBackend');
const { loginConSesionSemilla, irAApp, esperarDashboard, autoAceptarDialogos, irAModulo } = require('../fixtures/helpers');
const { createDb, TEST_NEGOCIO_ID } = require('../fixtures/mockBackend');

function productoSemilla(overrides = {}) {
  return {
    // Numérico a propósito: la app inserta el id sin comillas en atributos
    // onclick="abrirEditarProd(...)" / "eliminarProd(...)" (así lo genera
    // guardarProd() con Date.now()) — un id con guiones ahí rompería el JS.
    id: 1700000000001,
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

async function entrarAProductos(page, { productos = [] } = {}) {
  const db = createDb();
  db.productos_v2 = productos;
  const state = await loginConSesionSemilla(page, { db });
  autoAceptarDialogos(page);
  await irAApp(page);
  await esperarDashboard(page);
  await irAModulo(page, 'productos');
  return state;
}

test.describe('Inventario: alta de producto', () => {
  test('crear un producto nuevo lo agrega al listado con sus datos', async ({ page }) => {
    await entrarAProductos(page);
    await page.locator(':text-is("+ Nuevo")').click();
    await page.waitForSelector('#modal-prod.on');

    await page.locator('#p-nom').fill('Fideos Matarazzo 500g');
    await page.locator('#p-cod').fill('7791234000099');
    await page.locator('#p-stock').fill('30');
    await page.locator('#p-precio').fill('500');
    await page.locator('#p-pventa').fill('800');
    await page.locator('#p-min').fill('10');
    await page.locator('#p-max').fill('50');
    await page.locator('#modal-prod button:has-text("Guardar")').click();

    await expect(page.locator('#toast')).toContainText(/Producto guardado/i, { timeout: 5000 });
    await expect(page.locator('#mc-prods')).toContainText('Fideos Matarazzo 500g');
    await expect(page.locator('#prod-cnt')).toContainText('1 productos');
  });

  test('nombre vacío bloquea el guardado con error client-side', async ({ page }) => {
    await entrarAProductos(page);
    await page.locator(':text-is("+ Nuevo")').click();
    await page.waitForSelector('#modal-prod.on');
    await page.locator('#modal-prod button:has-text("Guardar")').click();
    await expect(page.locator('#toast')).toContainText(/nombre del producto/i, { timeout: 5000 });
  });

  test('código duplicado bloquea el guardado', async ({ page }) => {
    await entrarAProductos(page, { productos: [productoSemilla()] });
    await page.locator(':text-is("+ Nuevo")').click();
    await page.waitForSelector('#modal-prod.on');
    await page.locator('#p-nom').fill('Otro producto');
    await page.locator('#p-cod').fill(productoSemilla().cod);
    await page.locator('#modal-prod button:has-text("Guardar")').click();
    await expect(page.locator('#toast')).toContainText(/Ya existe un producto con ese código/i, { timeout: 5000 });
  });
});

test.describe('Inventario: edición', () => {
  test('editar un producto existente actualiza sus datos en el listado', async ({ page }) => {
    await entrarAProductos(page, { productos: [productoSemilla()] });
    await page.locator('button[onclick*="abrirEditarProd"]:visible').click();
    await page.waitForSelector('#modal-prod.on');
    await expect(page.locator('#p-nom')).toHaveValue('Coca-Cola 1.5L');

    await page.locator('#p-pventa').fill('1500');
    await page.locator('#modal-prod button:has-text("Guardar cambios")').click();

    await expect(page.locator('#toast')).toContainText(/Producto actualizado/i, { timeout: 5000 });
    await expect(page.locator('#mc-prods')).toContainText('Coca-Cola 1.5L');
  });
});

test.describe('Inventario: filtrado y búsqueda', () => {
  test('la búsqueda por texto filtra el listado por nombre o código', async ({ page }) => {
    await entrarAProductos(page, {
      productos: [
        productoSemilla({ id: 1700000000001, nom: 'Coca-Cola 1.5L', cod: '111' }),
        productoSemilla({ id: 1700000000002, nom: 'Sprite 1.5L', cod: '222' }),
      ],
    });
    await expect(page.locator('#prod-cnt')).toContainText('2 productos');
    await page.locator('#prod-srch').fill('sprite');
    await expect(page.locator('#prod-cnt')).toContainText('1 productos');
    await expect(page.locator('#mc-prods')).toContainText('Sprite 1.5L');
    await expect(page.locator('#mc-prods')).not.toContainText('Coca-Cola');
  });
});

test.describe('Inventario: eliminación', () => {
  test('eliminar un producto pide confirmación y lo saca del listado', async ({ page }) => {
    await entrarAProductos(page, { productos: [productoSemilla()] });
    await expect(page.locator('#prod-cnt')).toContainText('1 productos');
    await page.locator('button[onclick*="eliminarProd"]:visible').click();
    await expect(page.locator('#toast')).toContainText(/Eliminado/i, { timeout: 5000 });
    await expect(page.locator('#prod-cnt')).toContainText('0 productos');
  });
});

test.describe('Inventario: clasificación de stock en tiempo real', () => {
  test('un producto con stock 0 se marca SIN STOCK', async ({ page }) => {
    await entrarAProductos(page, { productos: [productoSemilla({ stock: 0 })] });
    await expect(page.locator('#mc-prods .bdg')).toContainText('SIN STOCK');
  });

  test('stock por debajo del mínimo se marca CRÍTICO', async ({ page }) => {
    await entrarAProductos(page, { productos: [productoSemilla({ stock: 3, min: 5, max: 100 })] });
    await expect(page.locator('#mc-prods .bdg')).toContainText('CRÍTICO');
  });

  test('stock apenas por encima del mínimo se marca MÍNIMO', async ({ page }) => {
    await entrarAProductos(page, { productos: [productoSemilla({ stock: 6, min: 5, max: 100 })] });
    await expect(page.locator('#mc-prods .bdg')).toContainText('MÍNIMO');
  });

  test('stock al tope del máximo se marca MÁXIMO', async ({ page }) => {
    await entrarAProductos(page, { productos: [productoSemilla({ stock: 100, min: 5, max: 100 })] });
    await expect(page.locator('#mc-prods .bdg')).toContainText('MÁXIMO');
  });

  test('editar el stock a un valor normal actualiza la clasificación al instante', async ({ page }) => {
    await entrarAProductos(page, { productos: [productoSemilla({ stock: 0, min: 5, max: 100 })] });
    await expect(page.locator('#mc-prods .bdg')).toContainText('SIN STOCK');

    await page.locator('button[onclick*="abrirEditarProd"]:visible').click();
    await page.waitForSelector('#modal-prod.on');
    await page.locator('#p-stock').fill('50');
    await page.locator('#modal-prod button:has-text("Guardar cambios")').click();

    await expect(page.locator('#toast')).toContainText(/Producto actualizado/i, { timeout: 5000 });
    await expect(page.locator('#mc-prods .bdg')).toContainText('OK');
  });
});
