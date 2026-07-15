export function OneLiveMark({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" role="img" aria-label="OneLive signal mark">
      <defs>
        <linearGradient id="one-live-gradient" x1="5" y1="5" x2="35" y2="35">
          <stop stopColor="#6cf2ea" />
          <stop offset=".55" stopColor="#63b8ff" />
          <stop offset="1" stopColor="#a28cff" />
        </linearGradient>
      </defs>
      <path d="M20 5v8M20 27v8M5 20h8M27 20h8" stroke="url(#one-live-gradient)" strokeWidth="1.5" opacity=".45" />
      <circle cx="20" cy="20" r="5.2" fill="#0a1119" stroke="url(#one-live-gradient)" strokeWidth="2" />
      <circle cx="20" cy="20" r="1.8" fill="#70e9e3" />
      <path d="M24.3 17.1 34 11.3M24.9 20h11M24.3 22.9 34 28.7" stroke="url(#one-live-gradient)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="34.1" cy="11.2" r="2.1" fill="#62dce6" />
      <circle cx="36" cy="20" r="2.1" fill="#7aafff" />
      <circle cx="34.1" cy="28.8" r="2.1" fill="#9d82ff" />
    </svg>
  );
}

export function OneLiveLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand-lockup" aria-label="OneLive">
      <OneLiveMark size={compact ? 30 : 36} />
      <div className="brand-wordmark">
        <strong>ONE<span>LIVE</span></strong>
        {!compact && <small>GLOBAL BROADCAST INTELLIGENCE</small>}
      </div>
    </div>
  );
}
