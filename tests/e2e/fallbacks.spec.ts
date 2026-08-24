import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  captureRuntimeErrors,
  DEMO_URL,
  expectNoRuntimeErrors,
  MOBILE_URL,
  openReadyDemo,
  startManualDirector,
} from './helpers';

test.describe('hardware and service independent fallbacks', () => {
  test('does not reload the demo when Playwright writes an artifact', async ({ page }) => {
    await openReadyDemo(page);
    const probePath = path.resolve(process.cwd(), 'artifacts', 'vite-watch-probe.html');
    let reloaded = false;
    page.once('load', () => {
      reloaded = true;
    });

    try {
      await writeFile(probePath, '<p>playwright artifact probe</p>', 'utf8');
      await page.waitForTimeout(800);
      expect(reloaded).toBe(false);
    } finally {
      await rm(probePath, { force: true });
    }
  });

  test('uses Chinese-first copy during startup', async ({ page }) => {
    await page.goto('/?mock=1&session=E2E-ONELIVE', { waitUntil: 'commit' });

    await expect(page.getByText('正在初始化全球直播链路')).toBeVisible();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('heading', { name: 'OneLive 全球直播控制台' })).toBeAttached();
  });

  test('finishes the mock story when every AI request is unavailable', async ({ page }) => {
    const runtimeErrors = captureRuntimeErrors(page);
    await page.route('**/api/**', (route) => route.abort('failed'));
    await openReadyDemo(page, DEMO_URL);
    await expect(page.locator('[data-provenance="EMULATED"]').first()).toBeVisible();

    await startManualDirector(page);
    for (let index = 0; index < 5; index += 1) await page.keyboard.press('Space');

    await expect(page.getByTestId('business-summary')).toBeVisible();
    await expectNoRuntimeErrors(runtimeErrors);
  });

  test('keeps the four-video demo stable when WebGL creation fails', async ({ page }) => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        contextId: string,
        ...args: unknown[]
      ): RenderingContext | null {
        if (contextId.toLowerCase().includes('webgl')) return null;
        return Reflect.apply(original, this, [contextId, ...args]) as RenderingContext | null;
      } as typeof HTMLCanvasElement.prototype.getContext;
    });
    const runtimeErrors = captureRuntimeErrors(page);
    await openReadyDemo(page);

    await expect(page.getByTestId('source-recording')).toBeVisible();
    await expect(page.getByTestId('localized-video')).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(0);
    await page.keyboard.press('c');
    await expect(page.getByTestId('comparison-view')).toBeVisible();
    await expect(page.getByTestId('comparison-video')).toHaveCount(2);
    await expect(page.locator('canvas')).toHaveCount(0);
    await expectNoRuntimeErrors(runtimeErrors);
  });

  test('offers Mock Source when camera access is denied on the broadcaster', async ({ page }) => {
    await page.addInitScript(() => {
      const denied = () =>
        Promise.reject(new DOMException('Camera permission denied for E2E', 'NotAllowedError'));
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: denied, enumerateDevices: async () => [] },
      });
    });
    const runtimeErrors = captureRuntimeErrors(page);
    await openReadyDemo(page, MOBILE_URL);

    await page.getByTestId('broadcast-start').click();
    await expect(page.getByTestId('broadcaster-shell')).toHaveAttribute('data-state', 'mock');
    await expect(page.getByTestId('fallback-mock-source')).toBeVisible();
    await expectNoRuntimeErrors(runtimeErrors);
  });
});
