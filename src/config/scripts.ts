import type { MarketId } from '@/core/types';

export interface DemoLine {
  id: string;
  zh: string;
  translations: Record<MarketId, string>;
}

export const DEMO_LINES: DemoLine[] = [
  {
    id: 'intro',
    zh: '梅特德菲多功能电气锅，插上电源即可轻松烹饪。手柄触控面板配备九种功能。',
    translations: {
      japan:
        'メテドフィの多機能電気鍋です。コンセントにつなぐだけで簡単に調理できます。ハンドルのタッチパネルには9つの機能を搭載。',
      latam:
        'Esta es la olla eléctrica multifunción Metedfi. Solo tienes que enchufarla para cocinar fácilmente. El panel táctil del mango incluye nueve funciones.',
      india:
        'This is Metedfi’s multifunction electric pot. Just plug it in and start cooking. The handle’s touch panel offers nine cooking modes.',
    },
  },
  {
    id: 'modes',
    zh: '炒、蒸、火锅、汤、粥、煮饭、预约和保温，选择想做的料理即可。',
    translations: {
      japan:
        '炒め物、蒸し料理、鍋、スープ、おかゆ、炊飯、予約、保温まで、作りたい料理を選ぶだけです。',
      latam:
        'Elige saltear, cocinar al vapor, olla caliente, sopa, avena, arroz, programación o conservación del calor.',
      india:
        'Choose stir-fry, steaming, hot pot, soup, porridge, rice, scheduling or keep-warm mode.',
    },
  },
  {
    id: 'close',
    zh: '一台锅覆盖日常多种料理，操作直观，也更适合轻松展示。',
    translations: {
      japan: '一台で毎日のさまざまな料理に対応。操作も直感的で、手軽に使えます。',
      latam:
        'Una sola olla cubre muchas comidas diarias, con controles sencillos y una presentación clara.',
      india:
        'One compact pot handles everyday meals with simple controls and an easy live demonstration.',
    },
  },
];
