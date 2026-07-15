import { expect, type Page } from '@playwright/test';

export const DEMO_URL = '/?mock=1&skipIntro=1&session=E2E-ONELIVE';
export const MOBILE_URL = '/broadcast/E2E-ONELIVE?mock=1&skipIntro=1';
export const MARKET_IDS = ['north-america', 'japan', 'spanish'] as const;

type MarketId = (typeof MARKET_IDS)[number];
type ChannelStatus = 'live' | 'low-res' | 'buffering' | 'audio-only' | 'paused';
type PathState = 'stable' | 'stressed' | 'critical' | 'protected';

export interface DirectorFlowState {
  step: number;
  network: 'premium' | 'congested' | 'weak' | 'latency';
  edge: boolean;
  qod: boolean;
  path?: PathState;
  view: 'control' | 'business';
}

export const DIRECTOR_FLOW: readonly DirectorFlowState[] = [
  { step: 1, network: 'premium', edge: false, qod: false, path: 'stable', view: 'control' },
  {
    step: 2,
    network: 'congested',
    edge: false,
    qod: false,
    path: 'stressed',
    view: 'control',
  },
  { step: 3, network: 'latency', edge: false, qod: false, path: 'stressed', view: 'control' },
  { step: 4, network: 'latency', edge: true, qod: false, path: 'stressed', view: 'control' },
  {
    step: 5,
    network: 'congested',
    edge: true,
    qod: true,
    path: 'protected',
    view: 'control',
  },
  { step: 6, network: 'congested', edge: true, qod: true, view: 'business' },
] as const;

export function captureRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

export async function openReadyDemo(page: Page, url = DEMO_URL): Promise<void> {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const pathname = new URL(url, 'http://onelive.test').pathname;
  const isBroadcaster = pathname.startsWith('/broadcast/');
  const shell = page.getByTestId(isBroadcaster ? 'broadcaster-shell' : 'app-shell');
  await expect(shell).toBeVisible();
  if (!isBroadcaster) await expect(shell).toHaveAttribute('data-ready', 'true');
  await page.evaluate(async () => document.fonts.ready);
}

export async function expectChannelStatuses(
  page: Page,
  statuses: Record<MarketId, ChannelStatus>,
): Promise<void> {
  for (const marketId of MARKET_IDS) {
    await expect(page.getByTestId(`channel-card-${marketId}`)).toHaveAttribute(
      'data-status',
      statuses[marketId],
    );
  }
}

export async function expectDirectorState(
  page: Page,
  expected: DirectorFlowState,
): Promise<void> {
  const shell = page.getByTestId('app-shell');
  await expect(page.getByTestId('director-step')).toHaveAttribute(
    'data-step',
    String(expected.step),
  );
  await expect(shell).toHaveAttribute('data-network', expected.network);
  await expect(shell).toHaveAttribute('data-edge', String(expected.edge));
  await expect(shell).toHaveAttribute('data-qod', String(expected.qod));

  if (expected.view === 'business') {
    await expect(page.getByTestId('business-summary')).toBeVisible();
    await expect(page.getByTestId('channel-grid')).toHaveCount(0);
    await expect(page.getByTestId('network-path')).toHaveCount(0);
    return;
  }

  await expect(page.getByTestId('channel-grid')).toBeVisible();
  await expect(page.getByTestId('business-summary')).toHaveCount(0);
  await expect(page.getByTestId('network-path')).toHaveAttribute('data-state', expected.path!);
}

export async function startManualDirector(page: Page): Promise<void> {
  const directorControl = page.getByTestId('director-start');
  await directorControl.click();
  await expectDirectorState(page, DIRECTOR_FLOW[0]);
  await expect(directorControl).toHaveAccessibleName('Pause automatic demo director');

  // Pause the 5.2 s timer so the test, rather than wall-clock speed, advances every step.
  await directorControl.click();
  await expect(directorControl).toHaveAccessibleName('Start automatic demo director');
}

export async function numericDataValue(page: Page, testId: string): Promise<number> {
  const raw = await page.getByTestId(testId).getAttribute('data-value');
  expect(raw, `${testId} must expose a stable data-value`).not.toBeNull();
  const value = Number(raw);
  expect(Number.isFinite(value), `${testId} data-value must be numeric`).toBe(true);
  return value;
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

export async function expectDesktopFirstScreenFits(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    innerHeight: window.innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.innerHeight + 1);
  await expectNoHorizontalOverflow(page);
}

export async function expectNoRuntimeErrors(errors: string[]): Promise<void> {
  expect(errors, errors.join('\n')).toEqual([]);
}
