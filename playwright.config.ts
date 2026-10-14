import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: 'web.spec.ts', fullyParallel: false, workers: 1,
  timeout: 45_000, use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true } },
  ],
});
