import { expect, test } from '@playwright/test';
import {
  captureRuntimeErrors,
  DEMO_URL,
  expectNoRuntimeErrors,
  MARKET_IDS,
  MOBILE_URL,
  openReadyDemo,
  startManualDirector,
} from './helpers';

test.describe('hardware and service independent fallbacks', () => {
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

  test('uses a complete 2D avatar stage when WebGL creation fails', async ({ page }) => {
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

    for (const marketId of MARKET_IDS) {
      const stage = page.getByTestId(`avatar-stage-${marketId}`);
      await expect(stage).toBeVisible();
      await expect(stage).toHaveAttribute('data-renderer', '2d');
      expect((await stage.boundingBox())?.height ?? 0).toBeGreaterThan(100);
    }
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
