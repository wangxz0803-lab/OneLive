import type { Page } from '@playwright/test';

export const DEMO_URL = process.env.ONELIVE_DEMO_URL ?? 'http://127.0.0.1:4173/';

export interface DemoState {
  topo: 'edge' | 'cloud';
  qod: boolean;
  qodAvailable: boolean;
  live: boolean;
  quality: string;
  channelQualities: string[];
  priorityChannel: number;
  deliveryFps: number;
  deliveryMode: 'local' | 'smooth' | 'limited' | 'stalled';
  cap: number;
  uplinkNeed: number;
  uplinkReal: number;
  gap: number;
  head: number;
  sourceLag: number;
  actualMediaLag: number;
  e2e: number;
  av: number;
  futureOpen: boolean;
  futureMode: 'production' | 'viewer';
  futureNetwork: 'good' | 'latency' | 'congested' | 'weak';
  futureQod: boolean;
  futureAngle: number;
  futureRequestedAngle: number;
  futurePitch: number;
  future3dReady: boolean;
  futureOrbitDuration: number;
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
