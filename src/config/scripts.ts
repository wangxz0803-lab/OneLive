import type { MarketId } from '@/core/types';

export interface DemoLine {
  id: string;
  zh: string;
  translations: Record<MarketId, string>;
}

export const DEMO_LINES: DemoLine[] = [
  {
    id: 'intro',
    zh: '大家好，今天给大家介绍这款轻量降噪耳机。它支持全天佩戴，并拥有低延迟模式。',
    translations: {
      'north-america': 'Meet our lightweight noise-cancelling earbuds, built for all-day comfort with a dedicated low-latency mode.',
      japan: '一日中快適に使える、軽量ノイズキャンセリングイヤホンをご紹介します。低遅延モードにも対応しています。',
      spanish: 'Conoce nuestros auriculares ligeros con cancelación de ruido, comodidad durante todo el día y modo de baja latencia.',
    },
  },
  {
    id: 'comfort',
    zh: '单只仅重四点二克，长时间直播和通勤佩戴都很轻松。',
    translations: {
      'north-america': 'At only 4.2 grams per earbud, they stay comfortable through long streams and daily commutes.',
      japan: '片耳わずか4.2グラム。長時間の配信や通勤でも快適です。',
      spanish: 'Con solo 4,2 gramos por auricular, son cómodos para directos largos y para el día a día.',
    },
  },
  {
    id: 'battery',
    zh: '充电盒可提供三十小时续航，十分钟快充即可使用两小时。',
    translations: {
      'north-america': 'The charging case delivers 30 hours of battery life, with two hours of listening from a ten-minute charge.',
      japan: '充電ケース込みで30時間再生。10分の急速充電で2時間使用できます。',
      spanish: 'El estuche ofrece 30 horas de autonomía y una carga de diez minutos permite dos horas de uso.',
    },
  },
  {
    id: 'latency',
    zh: '开启低延迟模式后，游戏、视频和直播互动都能保持更好的音画同步。',
    translations: {
      'north-america': 'Low-latency mode keeps games, video, and live interactions closely synchronized.',
      japan: '低遅延モードなら、ゲームや動画、ライブ配信でも音と映像がしっかり同期します。',
      spanish: 'El modo de baja latencia mantiene sincronizados juegos, vídeo e interacciones en directo.',
    },
  },
];
