import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 60000,
  expect: { timeout: 10000 },
  use: { baseURL: 'http://127.0.0.1:8011', browserName: 'chromium' },
  webServer: [
    { command: '.venv\\Scripts\\python.exe -m scripts.serve_tests', url: 'http://127.0.0.1:8011/api/health', reuseExistingServer: false },
  ],
});
