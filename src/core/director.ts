import type { DirectorPreset } from '@/core/types';

export const DIRECTOR_PRESETS: DirectorPreset[] = [
  {
    step: 0,
    id: 'connect',
    label: 'Connect',
    eyebrow: '01 · ONE SOURCE',
    narrative: 'One host signal is localized into three synchronized live markets.',
    nextHint: 'Next: inject network congestion',
    profileId: 'premium',
    deployment: 'cloud',
    qod: false,
    view: 'control',
  },
  {
    step: 1,
    id: 'congestion',
    label: 'Congestion',
    eyebrow: '02 · CAPACITY PRESSURE',
    narrative: 'Competing traffic forces visible channel degradation and buffering.',
    nextHint: 'Next: isolate the latency problem',
    profileId: 'congested',
    deployment: 'cloud',
    qod: false,
    view: 'control',
  },
  {
    step: 2,
    id: 'latency',
    label: 'Latency',
    eyebrow: '03 · TIME MATTERS',
    narrative: 'Bandwidth remains available, yet avatar motion and localized voice drift apart.',
    nextHint: 'Next: move intelligence to the edge',
    profileId: 'latency',
    deployment: 'cloud',
    qod: false,
    view: 'control',
  },
  {
    step: 3,
    id: 'edge',
    label: 'Edge AI',
    eyebrow: '04 · SHORTER PATH',
    narrative: 'Edge inference collapses the processing path and restores responsiveness.',
    nextHint: 'Next: protect the live session with QoD',
    profileId: 'latency',
    deployment: 'edge',
    qod: false,
    view: 'control',
  },
  {
    step: 4,
    id: 'qod',
    label: 'QoD Recovery',
    eyebrow: '05 · ASSURED EXPERIENCE',
    narrative: 'Under congestion, QoD reallocates scarce bandwidth to keep every market on air.',
    nextHint: 'Next: reveal the business outcome',
    profileId: 'congested',
    deployment: 'edge',
    qod: true,
    view: 'control',
  },
  {
    step: 5,
    id: 'business',
    label: 'Business',
    eyebrow: '06 · MANY MARKETS',
    narrative: 'One production moment becomes three locally relevant live experiences.',
    nextHint: 'Press R to reset the demonstration',
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
