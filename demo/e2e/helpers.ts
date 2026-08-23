import type { Page } from '@playwright/test';

// 相对本文件定位，与 cwd 无关：仓库根或 demo/ 目录下运行都指向同一个文件。
export const DEMO_URL = new URL('../index.html', import.meta.url).href;

export interface DemoState {
  topo: 'edge' | 'cloud';
  qod: boolean;
  qodAvailable: boolean;
  live: boolean;
  quality: string;
  cap: number;
  uplinkNeed: number;
  uplinkReal: number;
  gap: number;
  head: number;
  e2e: number;
  av: number;
}

export async function openDemo(page: Page): Promise<void> {
  await page.goto(DEMO_URL);
  // state() 真正依赖的是 window.__demo，四个监看窗只是页面就绪的表象，两者都等。
  await page.waitForFunction(
    () => document.querySelectorAll('#mv .tile').length === 4 && !!(window as unknown as { __demo?: unknown }).__demo,
  );
}

export async function state(page: Page): Promise<DemoState> {
  return page.evaluate(() => (window as unknown as { __demo: { state(): DemoState } }).__demo.state());
}
