import { Component, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useReducedMotion } from 'framer-motion';
import * as THREE from 'three';
import type { ChannelExperience, MarketProfile, NetworkProfileId } from '@/core/types';
import { Icon } from '@/components/Icon';

const THEME = {
  cobalt: { accent: '#55dce7', secondary: '#4b7dff', cloth: '#15273b', skin: '#ceb7aa' },
  violet: { accent: '#a78cff', secondary: '#e1d9ff', cloth: '#26213b', skin: '#d8bba8' },
  amber: { accent: '#e7b66a', secondary: '#ff7f72', cloth: '#38261f', skin: '#cba58d' },
  teal: { accent: '#54dce7', secondary: '#72f0c1', cloth: '#143033', skin: '#c7a58e' },
} as const;

class CanvasBoundary extends Component<
  { fallback: ReactNode; children: ReactNode; onError: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // A stable visual fallback is intentional; never surface WebGL internals in presenter mode.
    this.props.onError();
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

let cachedWebGlSupport: boolean | undefined;

function supportsWebGL(): boolean {
  if (cachedWebGlSupport !== undefined) return cachedWebGlSupport;
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2') || canvas.getContext('webgl');
    cachedWebGlSupport = Boolean(context);
    context?.getExtension('WEBGL_lose_context')?.loseContext();
    return cachedWebGlSupport;
  } catch {
    cachedWebGlSupport = false;
    return false;
  }
}

function AvatarModel({
  market,
  profileId,
  qod,
  channel,
}: {
  market: MarketProfile;
  profileId: NetworkProfileId;
  qod: boolean;
  channel: ChannelExperience;
}) {
  const root = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const mouth = useRef<THREE.Mesh>(null);
  const leftArm = useRef<THREE.Group>(null);
  const rightArm = useRef<THREE.Group>(null);
  const palette = THEME[market.visualTheme];
  const lastUpdate = useRef(0);

  useFrame(({ clock }) => {
    const elapsed = clock.getElapsedTime();
    const interval = qod
      ? 1 / 28
      : profileId === 'congested'
        ? 0.17
        : profileId === 'weak'
          ? 0.42
          : 1 / 30;
    if (elapsed - lastUpdate.current < interval) return;
    lastUpdate.current = elapsed;
    const lag =
      profileId === 'latency' && !qod ? 0.78 : profileId === 'congested' && !qod ? 0.24 : 0.06;
    const t = Math.max(0, elapsed - lag);
    if (root.current) {
      root.current.position.y = -0.1 + Math.sin(t * 1.45) * 0.018;
      root.current.rotation.z = Math.sin(t * 0.62) * 0.025;
    }
    if (head.current) {
      head.current.rotation.y = Math.sin(t * 0.72) * 0.13;
      head.current.rotation.x = Math.sin(t * 0.48 + 1.2) * 0.045;
    }
    if (leftArm.current) leftArm.current.rotation.z = 0.2 + Math.sin(t * 0.52) * 0.12;
    if (rightArm.current) rightArm.current.rotation.z = -0.2 - Math.sin(t * 0.66 + 0.8) * 0.15;
    if (mouth.current) mouth.current.scale.y = 0.025 + Math.max(0, Math.sin(t * 7.2)) * 0.035;
  });

  return (
    <group ref={root} position={[0, -0.05, 0]}>
      <mesh position={[0, -1.48, -0.02]} scale={[1.04, 0.78, 0.48]}>
        <sphereGeometry args={[1, 40, 24, 0, Math.PI * 2, 0, Math.PI * 0.62]} />
        <meshPhysicalMaterial
          color={palette.cloth}
          roughness={0.31}
          metalness={0.16}
          clearcoat={0.42}
        />
      </mesh>
      <mesh position={[0, -0.7, 0]} scale={[0.25, 0.34, 0.25]}>
        <cylinderGeometry args={[0.55, 0.72, 1.1, 24]} />
        <meshStandardMaterial color={palette.skin} roughness={0.5} />
      </mesh>
      <group ref={head} position={[0, 0.15, 0]}>
        <mesh scale={[0.59, 0.75, 0.57]}>
          <sphereGeometry args={[1, 48, 32]} />
          <meshPhysicalMaterial color={palette.skin} roughness={0.42} clearcoat={0.22} />
        </mesh>
        <mesh position={[0, 0.38, -0.08]} scale={[0.62, 0.47, 0.58]}>
          <sphereGeometry args={[1, 32, 20, 0, Math.PI * 2, 0, Math.PI * 0.55]} />
          <meshStandardMaterial
            color={market.visualTheme === 'violet' ? '#171522' : '#111922'}
            roughness={0.55}
          />
        </mesh>
        <mesh position={[-0.2, 0.08, 0.535]} scale={[0.08, 0.025, 0.02]}>
          <sphereGeometry args={[1, 18, 8]} />
          <meshBasicMaterial color="#eafcff" />
        </mesh>
        <mesh position={[0.2, 0.08, 0.535]} scale={[0.08, 0.025, 0.02]}>
          <sphereGeometry args={[1, 18, 8]} />
          <meshBasicMaterial color="#eafcff" />
        </mesh>
        <mesh ref={mouth} position={[0, -0.22, 0.55]} scale={[0.115, 0.032, 0.02]}>
          <sphereGeometry args={[1, 20, 10]} />
          <meshStandardMaterial color="#481f2a" roughness={0.65} />
        </mesh>
        <mesh position={[0, 0.03, -0.25]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.72, 0.018, 8, 64]} />
          <meshBasicMaterial color={palette.accent} transparent opacity={0.62} />
        </mesh>
      </group>
      <group ref={leftArm} position={[-0.83, -1.02, 0]} rotation={[0, 0, 0.2]}>
        <mesh position={[0, -0.45, 0]} scale={[0.23, 0.58, 0.26]}>
          <capsuleGeometry args={[0.55, 1.05, 8, 20]} />
          <meshPhysicalMaterial
            color={palette.cloth}
            roughness={0.34}
            metalness={0.1}
            clearcoat={0.32}
          />
        </mesh>
      </group>
      <group ref={rightArm} position={[0.83, -1.02, 0]} rotation={[0, 0, -0.2]}>
        <mesh position={[0, -0.45, 0]} scale={[0.23, 0.58, 0.26]}>
          <capsuleGeometry args={[0.55, 1.05, 8, 20]} />
          <meshPhysicalMaterial
            color={palette.cloth}
            roughness={0.34}
            metalness={0.1}
            clearcoat={0.32}
          />
        </mesh>
      </group>
      <mesh position={[0, -1.55, -0.32]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.06, 0.02, 8, 80]} />
        <meshBasicMaterial color={palette.secondary} transparent opacity={0.52} />
      </mesh>
      {channel.status !== 'paused' && (
        <points position={[0, -0.6, -0.8]}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[
                new Float32Array([
                  -1.2, 0, 0, 1.1, 0.5, 0, -0.7, 1.1, 0, 0.9, -0.7, 0, 1.35, 1.3, 0,
                ]),
                3,
              ]}
            />
          </bufferGeometry>
          <pointsMaterial color={palette.accent} size={0.035} transparent opacity={0.65} />
        </points>
      )}
    </group>
  );
}

function AvatarFallback({ market }: { market: MarketProfile }) {
  const palette = THEME[market.visualTheme];
  return (
    <div className="avatar-fallback" data-testid={`avatar-fallback-${market.id}`}>
      <svg
        viewBox="0 0 220 280"
        role="img"
        aria-label={`${market.language} authorized digital avatar`}
      >
        <defs>
          <linearGradient id={`cloth-${market.id}`} x1="0" y1="0" x2="1" y2="1">
            <stop stopColor={palette.cloth} />
            <stop offset="1" stopColor={palette.secondary} stopOpacity=".42" />
          </linearGradient>
        </defs>
        <ellipse cx="110" cy="260" rx="82" ry="12" fill={palette.accent} opacity=".12" />
        <path
          d="M39 269c4-76 29-112 71-112s67 36 71 112"
          fill={`url(#cloth-${market.id})`}
          stroke={palette.accent}
          strokeOpacity=".5"
        />
        <path
          d="M76 187c-27 9-37 33-42 73M144 187c27 9 37 33 42 73"
          fill="none"
          stroke={palette.secondary}
          strokeWidth="18"
          strokeLinecap="round"
          opacity=".72"
        />
        <rect x="98" y="142" width="24" height="34" rx="10" fill={palette.skin} />
        <ellipse cx="110" cy="102" rx="44" ry="56" fill={palette.skin} />
        <path
          d="M68 97c0-45 21-62 44-62 29 0 43 22 42 58-14-12-26-26-31-39-10 20-29 31-55 43Z"
          fill="#151923"
        />
        <path d="M91 102h10M119 102h10" stroke="#17212b" strokeWidth="3" strokeLinecap="round" />
        <path
          d="M103 126q7 5 14 0"
          fill="none"
          stroke="#6e3441"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <ellipse
          cx="110"
          cy="108"
          rx="58"
          ry="73"
          fill="none"
          stroke={palette.accent}
          strokeWidth="1"
          opacity=".4"
        />
      </svg>
      <span className="renderer-badge">2D 安全渲染</span>
    </div>
  );
}

export function AvatarStage({
  market,
  profileId,
  qod,
  channel,
  compact = false,
}: {
  market: MarketProfile;
  profileId: NetworkProfileId;
  qod: boolean;
  channel: ChannelExperience;
  compact?: boolean;
}) {
  const [webgl, setWebgl] = useState(supportsWebGL);
  const reduceMotion = useReducedMotion();
  const palette = THEME[market.visualTheme];
  const fallback = <AvatarFallback market={market} />;
  const showSignalOnly = channel.status === 'audio-only' || channel.status === 'paused';
  const stageStyle = useMemo(
    () =>
      ({
        '--market-accent': palette.accent,
        '--market-secondary': palette.secondary,
      }) as React.CSSProperties,
    [palette],
  );

  return (
    <div
      className={`avatar-stage avatar-stage--${market.visualTheme} ${compact ? 'avatar-stage--compact' : ''}`}
      style={stageStyle}
      data-testid={`avatar-stage-${market.id}`}
      data-renderer={webgl ? 'webgl' : '2d'}
      role="img"
      aria-label={`${market.language} avatar stage, ${channel.status}`}
    >
      <div className="stage-frame" />
      <div className="stage-horizon" />
      {profileId === 'latency' && !qod && <div className="pose-ghost" aria-hidden="true" />}
      {showSignalOnly ? (
        <div
          className="channel-interruption"
          role={channel.status === 'paused' ? 'alert' : 'status'}
        >
          <Icon name={channel.status === 'paused' ? 'alert' : 'signal'} size={28} />
          <strong>{channel.status === 'paused' ? '信号已暂停' : '仅保留音频'}</strong>
          <span>{channel.status === 'paused' ? '等待上行链路恢复' : '语音通道继续受到保障'}</span>
          <div className="audio-bars" aria-hidden="true">
            {Array.from({ length: 14 }, (_, i) => (
              <i key={i} />
            ))}
          </div>
        </div>
      ) : webgl ? (
        <CanvasBoundary fallback={fallback} onError={() => setWebgl(false)}>
          <Canvas
            frameloop={reduceMotion ? 'demand' : 'always'}
            dpr={[1, 1.25]}
            camera={{ position: [0, -0.25, 6.2], fov: 29 }}
            gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
            onCreated={({ gl }) => {
              gl.domElement.addEventListener(
                'webglcontextlost',
                (event) => {
                  event.preventDefault();
                  setWebgl(false);
                },
                { once: true },
              );
            }}
          >
            <ambientLight intensity={1.35} />
            <directionalLight position={[3, 4, 5]} intensity={2.2} color="#e7f7ff" />
            <pointLight position={[-3, 1, 2]} intensity={4.2} color={palette.accent} />
            <pointLight position={[3, -1, 1]} intensity={3} color={palette.secondary} />
            <AvatarModel market={market} profileId={profileId} qod={qod} channel={channel} />
          </Canvas>
        </CanvasBoundary>
      ) : (
        fallback
      )}
      <div className="avatar-watermark">
        <Icon name="shield" size={12} />
        <span>数字人模拟 · EMULATED</span>
      </div>
      {channel.status === 'buffering' && (
        <div className="buffering-indicator">
          <span />
          <strong>缓冲中</strong>
        </div>
      )}
      {channel.quality === 'low' && <div className="low-res-grid" aria-hidden="true" />}
    </div>
  );
}
