import type { SVGProps } from 'react';

export type IconName =
  | 'alert'
  | 'arrow'
  | 'camera'
  | 'check'
  | 'chevron'
  | 'close'
  | 'cloud'
  | 'cpu'
  | 'fullscreen'
  | 'globe'
  | 'menu'
  | 'mic'
  | 'mute'
  | 'pause'
  | 'phone'
  | 'play'
  | 'qr'
  | 'radio'
  | 'reset'
  | 'rotate'
  | 'server'
  | 'settings'
  | 'shield'
  | 'signal'
  | 'spark'
  | 'users'
  | 'wifi';

const paths: Record<IconName, React.ReactNode> = {
  alert: <><path d="M12 3 2.8 19h18.4L12 3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></>,
  arrow: <><path d="M5 12h14"/><path d="m15 8 4 4-4 4"/></>,
  camera: <><path d="M14.5 6 16 8h3v10H5V8h3l1.5-2h5Z"/><circle cx="12" cy="13" r="3"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  chevron: <path d="m9 18 6-6-6-6"/>,
  close: <><path d="m6 6 12 12"/><path d="m18 6-12 12"/></>,
  cloud: <path d="M7 18h10a4 4 0 0 0 .4-8 5.7 5.7 0 0 0-10.8-1.5A4.8 4.8 0 0 0 7 18Z"/>,
  cpu: <><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/><rect x="10" y="10" width="4" height="4" rx="1"/></>,
  fullscreen: <><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></>,
  globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h16"/></>,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></>,
  mute: <><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="m17 9 4 6M21 9l-4 6"/></>,
  pause: <><path d="M9 7v10M15 7v10"/></>,
  phone: <><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></>,
  play: <path d="m8 5 11 7-11 7V5Z"/>,
  qr: <><rect x="3" y="3" width="6" height="6"/><rect x="15" y="3" width="6" height="6"/><rect x="3" y="15" width="6" height="6"/><path d="M15 15h2v2h-2zM19 15h2v6h-2M15 19h2v2h-2"/></>,
  radio: <><circle cx="12" cy="12" r="2"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.5 5.5a9 9 0 0 0 0 13M18.5 5.5a9 9 0 0 1 0 13"/></>,
  reset: <><path d="M4 4v6h6"/><path d="M5.3 15a8 8 0 1 0 1.6-8.2L4 10"/></>,
  rotate: <><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.1 8a7 7 0 0 1 11.5-1L20 9M4 15l2.4 2a7 7 0 0 0 11.5-1"/></>,
  server: <><rect x="4" y="4" width="16" height="6" rx="2"/><rect x="4" y="14" width="16" height="6" rx="2"/><path d="M8 7h.01M8 17h.01M12 7h4M12 17h4"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
  shield: <><path d="M12 3 5 6v5c0 4.4 2.8 8.2 7 10 4.2-1.8 7-5.6 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-5"/></>,
  signal: <><path d="M5 18v-2M9 18v-5M13 18v-8M17 18V7M21 18V4"/></>,
  spark: <><path d="m12 3 1.2 4.1L17 9l-3.8 1.9L12 15l-1.2-4.1L7 9l3.8-1.9L12 3Z"/><path d="m5 15 .7 2.3L8 18l-2.3.7L5 21l-.7-2.3L2 18l2.3-.7L5 15Z"/></>,
  users: <><circle cx="9" cy="9" r="3"/><path d="M3 20c.6-3.4 2.6-5 6-5s5.4 1.6 6 5"/><circle cx="17" cy="8" r="2"/><path d="M16 14c2.8-.3 4.5 1 5 4"/></>,
  wifi: <><path d="M3 9a14 14 0 0 1 18 0M6 12.5a9 9 0 0 1 12 0M9.5 16a4 4 0 0 1 5 0"/><circle cx="12" cy="19" r=".5"/></>,
};

export function Icon({ name, size = 18, ...props }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
