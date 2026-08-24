import type { MarketId } from '@/core/types';

export interface OriginalDemoMedia {
  id: 'original';
  src: string;
  poster: string;
  locale: 'zh-CN';
  label: string;
  provenanceLabel: '真人直播样例 · 本地素材';
}

export interface LocalizedDemoMedia {
  marketId: MarketId;
  src: string;
  poster: string;
  locale: 'ja-JP' | 'es-MX' | 'en-IN';
  label: string;
}

export const DEMO_MEDIA: {
  original: OriginalDemoMedia;
  localized: Record<MarketId, LocalizedDemoMedia>;
} = {
  original: {
    id: 'original',
    src: '/demo-media/original-zh.mp4',
    poster: '/demo-media/original-zh.jpg',
    locale: 'zh-CN',
    label: '真人直播样例 · 中文主播',
    provenanceLabel: '真人直播样例 · 本地素材',
  },
  localized: {
    japan: {
      marketId: 'japan',
      src: '/demo-media/japan-ja.mp4',
      poster: '/demo-media/japan-ja.jpg',
      locale: 'ja-JP',
      label: '日本 · 日语',
    },
    latam: {
      marketId: 'latam',
      src: '/demo-media/latam-es.mp4',
      poster: '/demo-media/latam-es.jpg',
      locale: 'es-MX',
      label: '拉美 · 西班牙语',
    },
    india: {
      marketId: 'india',
      src: '/demo-media/india-en.mp4',
      poster: '/demo-media/india-en.jpg',
      locale: 'en-IN',
      label: '印度 · 英语',
    },
  },
};
