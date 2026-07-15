import { defineConfig, devices } from '@playwright/test';

const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './artifacts/playwright-results',
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 6_000,
    toHaveScreenshot: {
      animations: 'disabled',
      maxDiffPixelRatio: 0.025,
    },
  },
  reporter: [
    ['list'],
    ['html', { outputFolder: './artifacts/playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    colorScheme: 'dark',
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Keep the suite independent from Playwright's separately downloaded FFmpeg binary.
    video: 'off',
  },
  projects: [
    {
      name: 'system-chrome',
      use: {
        ...devices['Desktop Chrome'],
        // Deliberately target the locally installed stable Chrome channel.
        channel: 'chrome',
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  webServer: {
    command: 'npm run demo:mock',
    url: 'http://127.0.0.1:5173/api/health',
    timeout: 120_000,
    reuseExistingServer: !isCI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
