import { describe, expect, it } from 'vitest';
import { DEMO_MEDIA } from '@/config/demoMedia';
import { MARKET_PROFILES } from '@/config/markets';

describe('market profile configuration', () => {
  it('contains the three approved localized markets in priority order', () => {
    expect(MARKET_PROFILES.map((market) => market.id)).toEqual(['japan', 'latam', 'india']);
    expect(MARKET_PROFILES.map((market) => market.locale)).toEqual(['ja-JP', 'es-MX', 'en-IN']);
    expect(MARKET_PROFILES.map((market) => market.priority)).toEqual([1, 2, 3]);
    expect(MARKET_PROFILES.map((market) => [market.market, market.language])).toEqual([
      ['日本', '日语'],
      ['拉美', '西班牙语'],
      ['印度', '英语'],
    ]);
  });

  it('maps the original and every localized market to a stable local video path', () => {
    expect(DEMO_MEDIA.original).toMatchObject({
      src: '/demo-media/original-zh.mp4',
      poster: '/demo-media/original-zh.jpg',
      locale: 'zh-CN',
      provenanceLabel: '真人直播样例 · 本地素材',
    });

    for (const market of MARKET_PROFILES) {
      expect(DEMO_MEDIA.localized[market.id]).toMatchObject({
        marketId: market.id,
        locale: market.locale,
      });
      expect(DEMO_MEDIA.localized[market.id]).not.toHaveProperty('provenanceLabel');
      expect(DEMO_MEDIA.localized[market.id].src).toMatch(/^\/demo-media\/.+\.mp4$/);
      expect(DEMO_MEDIA.localized[market.id].poster).toMatch(/^\/demo-media\/.+\.jpg$/);
    }
  });

  it('uses unique stable identifiers, locales, platform names and visual themes', () => {
    for (const field of ['id', 'locale', 'platformName', 'visualTheme'] as const) {
      const values = MARKET_PROFILES.map((market) => market[field]);
      expect(new Set(values).size).toBe(MARKET_PROFILES.length);
    }
  });

  it('provides every field needed to render a channel without UI hard-coding', () => {
    for (const market of MARKET_PROFILES) {
      expect(market.market.trim()).not.toBe('');
      expect(market.language.trim()).not.toBe('');
      expect(market.avatarTheme.trim()).not.toBe('');
      expect(market.stageTheme.trim()).not.toBe('');
      expect(market.platformName.trim()).not.toBe('');
      expect(market.subtitleStyle.trim()).not.toBe('');
      expect(market.ttsVoicePreference.length).toBeGreaterThan(0);
      expect(market.targetKbps).toBeGreaterThan(market.minimumStableKbps);
      expect(market.minimumStableKbps).toBeGreaterThan(0);
      expect(market.viewers).toBeGreaterThan(0);
    }
  });

  it('keeps primary-market resource requirements above lower priorities', () => {
    const byPriority = [...MARKET_PROFILES].sort((a, b) => a.priority - b.priority);

    expect(byPriority[0].targetKbps).toBeGreaterThan(byPriority[1].targetKbps);
    expect(byPriority[1].targetKbps).toBeGreaterThan(byPriority[2].targetKbps);
    expect(byPriority[0].minimumStableKbps).toBeGreaterThan(byPriority[1].minimumStableKbps);
    expect(byPriority[1].minimumStableKbps).toBeGreaterThan(byPriority[2].minimumStableKbps);
  });
});
