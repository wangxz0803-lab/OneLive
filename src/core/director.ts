import type { DirectorPreset } from '@/core/types';

export const DIRECTOR_PRESETS: DirectorPreset[] = [
  {
    step: 0,
    id: 'connect',
    label: '真人接入',
    eyebrow: '01 · 一位真人主播',
    narrative: '真人中文主直播源，通过AI能力面向日本、拉美和印度三个市场。',
    nextHint: '下一步：观察多市场直播对网络的压力',
    profileId: 'premium',
    deployment: 'cloud',
    qod: false,
    view: 'control',
  },
  {
    step: 1,
    id: 'congestion',
    label: '网络拥塞',
    eyebrow: '02 · 多路直播竞争资源',
    narrative: '三地直播同时交付时竞争有限带宽，画质下降、缓冲和频道差异肉眼可见。',
    nextHint: '下一步：观察云端互动的高时延问题',
    profileId: 'congested',
    deployment: 'cloud',
    qod: false,
    view: 'control',
  },
  {
    step: 2,
    id: 'latency',
    label: '互动延迟',
    eyebrow: '03 · 音色与口型必须同步',
    narrative: '带宽仍然充足，但云端处理路径让本地化声音与主播口型开始失去同步。',
    nextHint: '下一步：把AI生成下沉到直播终端',
    profileId: 'latency',
    deployment: 'cloud',
    qod: false,
    view: 'control',
  },
  {
    step: 3,
    id: 'edge',
    label: '端侧AI终端',
    eyebrow: '04 · 先生成三路，再进入上行',
    narrative: '翻译、音色和口型生成下沉到AI直播终端，互动延迟收敛，同时形成三路并发上行。',
    nextHint: '下一步：用QoD保障三路实时直播',
    profileId: 'latency',
    deployment: 'edge',
    qod: false,
    view: 'control',
  },
  {
    step: 4,
    id: 'qod',
    label: 'QoD保障',
    eyebrow: '05 · 有限上行资源按需分配',
    narrative: '三路本地化直播共享上行资源，QoD优先保障核心频道，而不是把所有指标调成完美。',
    nextHint: '下一步：总结商家、观众与运营商价值',
    profileId: 'congested',
    deployment: 'edge',
    qod: true,
    view: 'control',
  },
  {
    step: 5,
    id: 'business',
    label: '商业价值',
    eyebrow: '06 · 一个真人进入三个市场',
    narrative: '商家减少重复直播，观众获得当地语言体验，运营商获得AI终端、5G上行与QoD的新产品空间。',
    nextHint: '按 R 重置演示',
    profileId: 'congested',
    deployment: 'edge',
    qod: true,
    view: 'business',
  },
];

export function clampDirectorStep(step: number): number {
  return Math.max(0, Math.min(DIRECTOR_PRESETS.length - 1, step));
}

export function directorPreset(step: number): DirectorPreset {
  return DIRECTOR_PRESETS[clampDirectorStep(step)];
}
