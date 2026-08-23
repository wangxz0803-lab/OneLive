import { defineConfig } from '@playwright/test';

const isCI = Boolean(process.env.CI);

// 演示台是纯静态单文件，测试直接以 file:// 打开——与现场"双击即开"完全同一条路径。
// 刻意不设 webServer，也不复用根配置（根配置会拉起 React 应用的 mock server）。
export default defineConfig({
  testDir: './e2e',
  outputDir: '../artifacts/demo-playwright-results',
  fullyParallel: false,
  forbidOnly: isCI,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [['list']],
  use: {
    colorScheme: 'dark',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // 用捆绑 chromium，避开 chrome/msedge 渠道差异；放开自动播放以便无手势起播。
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  },
});
