// @ts-check
const { defineConfig, devices } = require('@playwright/test');

const MODE = process.env.GESTOPRO_E2E_MODE || 'mock'; // 'mock' | 'real'

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false, // el mock de backend es por-página, pero evitamos condiciones de carrera entre specs
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'report', open: 'never' }],
  ],
  outputDir: 'test-results',
  use: {
    baseURL: 'http://localhost:4173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
    // La app registra un Service Worker (PWA). En un reload, el SW intercepta
    // los fetch (incluidos los que mockeamos con page.route) y puede servir
    // contenido cacheado/fallback en vez de dejarlos pasar, rompiendo los mocks.
    // Lo bloqueamos para que todo pase siempre por nuestras rutas mockeadas.
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'node static-server.js',
    port: 4173,
    reuseExistingServer: true,
    timeout: 10_000,
  },
  projects: [
    {
      name: 'desktop-mock',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 900 } },
    },
    {
      name: 'mobile-mock',
      // iPhone estándar pedido explícitamente: 390x844
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
  metadata: { mode: MODE },
});
