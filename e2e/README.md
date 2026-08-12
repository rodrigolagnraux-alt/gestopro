# GestoPro — Suite E2E (Playwright)

Suite End-to-End que cubre autenticación/onboarding, caja/ventas, inventario,
fiado, lectura de facturas con IA, empleados, reportes financieros y
rutas/UI/responsive.

## Modo mock (default — sin costo, sin tocar datos reales)

Por default la suite intercepta **toda** la red (Supabase Auth/REST/RPC/Storage,
Edge Functions, y los CDNs de `@supabase/supabase-js` y `xlsx`) y la reemplaza
por un mock en memoria (`fixtures/mockBackend.js`). No sale a internet, no usa
la cuenta real de nadie, no gasta invocaciones de IA (Anthropic) ni emails
(Resend), y no persiste nada entre corridas — cada test arranca con una base
en memoria vacía que se descarta al terminar.

```bash
npm install
npx playwright test              # todo, ambos proyectos (desktop + mobile)
npx playwright test --project=desktop-mock
npx playwright test --project=mobile-mock   # viewport 390x844
npx playwright show-report report
```

### Por qué el mock carga el SDK real de Supabase desde `node_modules`

La app carga `@supabase/supabase-js` y `xlsx` desde CDNs públicos
(jsdelivr/cdnjs). `installVendorCdnMocks()` intercepta esas URLs exactas y
responde con el bundle UMD real instalado localmente vía npm — la app corre
con el SDK real, solo que servido desde disco en vez de la red. Así los
mocks de Auth/REST/RPC de abajo se ejercitan de verdad (si el SDK nunca
cargara, la app caería a su modo 100% offline y ningún mock se usaría).

### Gotchas de infraestructura ya resueltas (documentadas en el código)

- **Modales (`.ov`) siempre `display:flex`**: la clase `.on` solo cambia
  opacity/pointer-events. `expect(locator).toBeVisible()` sobre un modal NO
  sirve — usar `waitForSelector('#id.on')`.
- **Service Worker**: la app registra uno; en un `page.reload()` puede
  interceptar los fetches mockeados. La config ya lo bloquea
  (`use.serviceWorkers: 'block'`).
- **Sidebar en mobile**: fuera de pantalla (`left:-210px`) hasta tocar ☰
  (`toggleSB()`). Usar el helper `abrirMenuSiHaceFalta()` / `irAModulo()`.
- **No declarar el fixture `mockState` en tests que ya usan
  `loginConSesionSemilla`**: instalaría un segundo backend mockeado en la
  misma page y, por el orden LIFO de `page.route()`, el tráfico real iría al
  mock de `loginConSesionSemilla` mientras el test leería el otro (vacío).
  Usar el `state` que devuelve `loginConSesionSemilla`.

## Modo real (backend real de Supabase — fuera de este sandbox)

Este sandbox no tiene salida de red hacia `*.supabase.co`, así que el modo
real nunca se probó acá — está preparado para correrlo en un entorno con
acceso real. Para correrlo:

1. Creá un negocio de test **aislado** (no la cuenta real) en el proyecto de
   Supabase real — un email dedicado tipo `e2e-test+algo@tudominio.com`.
2. No hay todavía un modo `GESTOPRO_E2E_MODE=real` implementado que salte el
   mock — hay que:
   - No importar `installMockBackend` en los specs (o envolverlo en un `if`).
   - Loguear con las credenciales reales del negocio de test en vez de
     `loginConSesionSemilla`.
   - Para "Lectura de Facturas con IA" y cualquier envío de email (Resend):
     seguir mockeando esos dos puntos específicos aunque el resto sea real
     (tienen costo por invocación) — interceptar solo
     `**/functions/v1/leer-factura*` y `**/functions/v1/notificar-*` con
     `page.route()`, dejando pasar todo lo demás.
3. Al terminar, borrar todos los datos de prueba generados (productos,
   ventas, clientes fiado, empleados, facturas) de ese negocio — igual que se
   hizo con la limpieza del preapproval.

## Qué NO valida el modo mock

- Auth real de Supabase (creación de usuario, confirmación de email real,
  RLS/políticas de la base real).
- Calidad de lectura de la IA real sobre una foto de factura de verdad
  (el mock devuelve el JSON que el test le pide, no interpreta una imagen).
- Entrega real de emails (Resend) ni de notificaciones.
- Webhooks de Mercado Pago.

## Estructura

- `fixtures/mockBackend.js` — mock de Auth/REST/RPC/Storage/Edge Functions.
- `fixtures/helpers.js` — login con sesión semilla, navegación a módulos,
  apertura de menú mobile, espera de dashboard.
- `tests/*.spec.js` — un archivo por módulo.
- `static-server.js` — sirve el repo (para tener 404 reales en rutas
  inexistentes, a diferencia del dev server por defecto de algunos frameworks).
