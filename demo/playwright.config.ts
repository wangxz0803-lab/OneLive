import { defineConfig } from '@playwright/test';

const isCI = Boolean(process.env.CI);

// 3D GLB 需要通过 HTTP 读取；这里使用与现场 start-demo.cmd 相同的零依赖静态服务器。
// file:// 仍会安全回退到环绕视频，但不作为完整3D验收路径。
export default defineConfig({
  testDir: './e2e',
  outputDir: '../artifacts/demo-playwright-results',
  fullyParallel: false,
  forbidOnly: isCI,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [['list']],
  webServer: {
    command: 'node serve-demo.mjs',
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: !isCI,
    env: { ONELIVE_DEMO_NO_OPEN: '1' },
  },
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
