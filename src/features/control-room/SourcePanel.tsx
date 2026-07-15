import { useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Icon } from '@/components/Icon';
import { DEMO_LINES } from '@/config/scripts';
import type { ExperienceSnapshot } from '@/core/types';
import { useDialogFocus } from '@/hooks/useDialogFocus';
import { BrowserTTSProvider } from '@/providers/demoProviders';
import {
  fetchRuntimeConfig,
  SENDER_CONSTRAINTS,
  useSessionSocket,
  useViewerPeer,
  type BroadcasterSourceState,
  type RuntimeConfig,
  type WebRtcLiveStats,
} from '@/realtime';
import { useOneLiveStore } from '@/store/useOneLiveStore';

function MockCameraSignal() {
  return (
    <div className="mock-camera-signal" role="img" aria-label="Deterministic mock presenter signal">
      <div className="source-room-light source-room-light--one" />
      <div className="source-room-light source-room-light--two" />
      <div className="source-person">
        <div className="source-person__head" />
        <div className="source-person__neck" />
        <div className="source-person__body" />
        <div className="source-person__arm source-person__arm--left" />
        <div className="source-person__arm source-person__arm--right" />
      </div>
      <svg className="tracking-overlay" viewBox="0 0 300 430" aria-hidden="true">
        <g fill="none" stroke="currentColor" strokeWidth="1">
          <rect x="103" y="69" width="94" height="116" rx="40" />
          <path d="M150 184v42M95 232l55-16 57 16M95 232l-42 95M207 232l39 94" />
          <path d="M112 115h24M164 115h24M142 152h16" />
        </g>
        {[
          [103, 104],
          [197, 104],
          [112, 148],
          [188, 148],
          [95, 232],
          [207, 232],
          [53, 327],
          [246, 326],
        ].map(([cx, cy], index) => (
          <circle key={index} cx={cx} cy={cy} r="3" fill="currentColor" />
        ))}
      </svg>
      <div className="source-scanline" />
    </div>
  );
}

export function SourcePanel({ experience }: { experience: ExperienceSnapshot }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const qrDialogRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const remoteReadyRef = useRef(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [cameraMessage, setCameraMessage] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [remoteSourceState, setRemoteSourceState] = useState<BroadcasterSourceState | null>(null);
  const [liveStats, setLiveStats] = useState<WebRtcLiveStats | null>(null);
  const {
    sessionId,
    sourceKind,
    sourceConnected,
    sourceMuted,
    scriptIndex,
    setSource,
    setSourceMuted,
    setScriptIndex,
  } = useOneLiveStore();
  useDialogFocus(qrOpen, qrDialogRef, () => setQrOpen(false));
  const line = DEMO_LINES[scriptIndex % DEMO_LINES.length];
  const tts = useMemo(() => new BrowserTTSProvider(), []);
  const phoneUrl = `${window.location.origin}/broadcast/${sessionId}`;
  const realtime = useSessionSocket({
    sessionId,
    role: 'control',
    path: runtimeConfig?.socketPath,
  });
  const broadcasterPresent = Boolean(realtime.presence?.roles.broadcaster);
  const viewer = useViewerPeer({
    socket: realtime.socket,
    sessionId,
    joined: realtime.joined,
    broadcasterPresent,
    iceServers: runtimeConfig?.iceServers,
    onStats: setLiveStats,
    onSourceState: setRemoteSourceState,
  });
  const remoteVideoTrack = viewer.remoteStream?.getVideoTracks()[0];
  const localVideoTrack = localStream?.getVideoTracks()[0];
  const remoteReady =
    broadcasterPresent &&
    viewer.connectionState === 'connected' &&
    Boolean(remoteVideoTrack && remoteVideoTrack.readyState === 'live');
  const liveInput =
    (sourceKind === 'phone' && remoteReady) ||
    (sourceKind === 'local-camera' &&
      sourceConnected &&
      Boolean(localVideoTrack && localVideoTrack.readyState === 'live'));
  const selectedStream =
    sourceKind === 'phone'
      ? viewer.remoteStream
      : sourceKind === 'local-camera'
        ? localStream
        : null;

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('mock') === '1') return;
    const controller = new AbortController();
    void fetchRuntimeConfig(controller.signal)
      .then(setRuntimeConfig)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = selectedStream;
    if (selectedStream) void video.play().catch(() => undefined);
    return () => {
      if (video.srcObject === selectedStream) video.srcObject = null;
    };
  }, [selectedStream]);

  useEffect(() => {
    if (remoteReady && !remoteReadyRef.current) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setLocalStream(null);
      setSource('phone', true);
      setCameraMessage('Phone camera connected over the live WebRTC session.');
    } else if (!remoteReady && remoteReadyRef.current && sourceKind === 'phone') {
      setSource('mock', true);
      setLiveStats(null);
      setCameraMessage('Phone signal ended — deterministic Mock Source is active.');
    }
    remoteReadyRef.current = remoteReady;
  }, [remoteReady, setSource, sourceKind]);

  useEffect(() => {
    if (sourceKind === 'phone' && remoteSourceState) {
      setSourceMuted(!remoteSourceState.audioEnabled);
    }
  }, [remoteSourceState, setSourceMuted, sourceKind]);

  useEffect(() => {
    if (!realtime.joined || !broadcasterPresent) return;
    const sendConstraints = (): void => {
      realtime.socket.emit('source:command', {
        sessionId,
        command: {
          type: 'set-sender-constraints',
          constraints: SENDER_CONSTRAINTS[experience.profile.id],
        },
      });
    };
    sendConstraints();
    const retry = window.setTimeout(sendConstraints, 600);
    return () => window.clearTimeout(retry);
  }, [broadcasterPresent, experience.profile.id, realtime.joined, realtime.socket, sessionId]);

  const useLocalCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 720 }, height: { ideal: 1080 }, facingMode: 'user' },
        audio: true,
      });
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = stream;
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !sourceMuted;
      });
      setLocalStream(stream);
      setSource('local-camera', true);
      setCameraMessage('Local camera connected. Media stays in this live session.');
    } catch {
      if (streamRef.current) {
        setSource('local-camera', true);
        setCameraMessage('Camera refresh unavailable. The current local camera remains active.');
      } else {
        setLocalStream(null);
        setSource('mock', true);
        setCameraMessage('Camera unavailable — deterministic Mock Source is active.');
      }
    }
  };

  const useMock = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setLocalStream(null);
    setSource('mock', true);
    setCameraMessage('Mock Source active. No camera or external API required.');
  };

  const openPhoneSource = () => {
    if (remoteReady) {
      setSource('phone', true);
      setCameraMessage('Phone camera selected from the live WebRTC session.');
      return;
    }
    setQrOpen(true);
  };

  const toggleSourceMuted = () => {
    const nextMuted = !sourceMuted;
    setSourceMuted(nextMuted);
    if (sourceKind === 'phone' && realtime.joined && broadcasterPresent) {
      realtime.socket.emit('source:command', {
        sessionId,
        command: { type: 'set-muted', muted: nextMuted },
      });
    } else if (sourceKind === 'local-camera') {
      localStream?.getAudioTracks().forEach((track) => {
        track.enabled = !nextMuted;
      });
    }
  };

  const playLine = async () => {
    setSpeaking(true);
    await tts.speak(line.translations['north-america'], 'en-US', ['Samantha', 'Ava', 'English']);
    setSpeaking(false);
  };

  const sourceStatus =
    sourceKind === 'phone'
      ? remoteReady
        ? 'WEBRTC LOCKED · LIVE'
        : broadcasterPresent && realtime.joined
          ? 'PHONE PRESENT · LIVE'
          : 'WAITING FOR PHONE'
      : sourceKind === 'local-camera'
        ? liveInput
          ? 'CAMERA LOCKED · LIVE'
          : 'CAMERA UNAVAILABLE'
        : broadcasterPresent && realtime.joined
          ? 'MOCK · PHONE PRESENT LIVE'
          : 'MOCK READY · EMULATED';
  const remoteSettings = remoteVideoTrack?.getSettings();
  const localSettings = localVideoTrack?.getSettings();
  const liveBitrate = sourceKind === 'phone' && remoteReady ? liveStats?.bitrateKbps : null;
  const captureResolution =
    sourceKind === 'phone' && remoteSettings?.height
      ? `${remoteSettings.height}p`
      : sourceKind === 'local-camera' && localSettings?.height
        ? `${localSettings.height}p`
        : experience.profile.id === 'weak'
          ? '480p'
          : '1080p';
  const captureFps =
    sourceKind === 'phone' && remoteReady
      ? (liveStats?.fps ?? remoteSettings?.frameRate ?? '—')
      : sourceKind === 'local-camera'
        ? (localSettings?.frameRate ?? '—')
        : experience.profile.id === 'weak'
          ? 12
          : 30;
  const recoverableMessage = viewer.error || realtime.error || cameraMessage;

  return (
    <section
      className="source-panel panel"
      data-testid="source-panel"
      data-peer-state={viewer.connectionState}
      data-phone-present={broadcasterPresent}
      aria-label="Human source signal"
    >
      <span className="visually-hidden" data-testid="source-mode" data-source={sourceKind}>
        {sourceKind} source
      </span>
      <header className="panel-header source-panel__header">
        <div>
          <span className="section-kicker">PRIMARY INPUT</span>
          <strong>Human signal source</strong>
        </div>
        <div
          className={`source-live-state ${liveInput || (broadcasterPresent && realtime.joined) ? 'source-live-state--connected' : ''}`}
          role="status"
        >
          {(liveInput || (broadcasterPresent && realtime.joined)) && <i />} {sourceStatus}
        </div>
      </header>

      <div className="source-preview" data-testid="source-preview">
        {sourceKind === 'local-camera' || (sourceKind === 'phone' && viewer.remoteStream) ? (
          <video ref={videoRef} autoPlay muted playsInline />
        ) : (
          <MockCameraSignal />
        )}
        <div className="source-preview__top">
          <span className={liveInput ? 'live-badge' : 'provenance-badge'}>
            {liveInput && <i />}{' '}
            {sourceKind === 'mock' ? 'SAFE DEMO' : liveInput ? 'LIVE' : 'CONNECTING'}
          </span>
          <span className="provenance-badge">{liveInput ? 'LIVE INPUT' : 'EMULATED'}</span>
        </div>
        <div className="source-preview__bottom">
          <span>
            <Icon name="camera" size={13} />
            {sourceKind === 'mock' ? 'POSE SIM' : sourceKind === 'phone' ? 'PHONE CAM' : 'CAM 01'}
          </span>
          <span>
            <Icon name={sourceMuted ? 'mute' : 'mic'} size={13} />
            {sourceMuted ? 'MUTED' : liveInput ? 'AUDIO LIVE' : 'DEMO AUDIO'}
          </span>
          <span>
            <Icon name="shield" size={13} />
            AI AUTHORIZED
          </span>
        </div>
        <div className="source-corners" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>

      <div className="audio-and-caption">
        <div
          className="audio-wave"
          role="img"
          aria-label={liveInput ? 'Live input audio level' : 'Emulated demo audio level'}
        >
          {Array.from({ length: 24 }, (_, index) => (
            <i key={index} style={{ '--wave-index': index } as React.CSSProperties} />
          ))}
        </div>
        <div className="source-caption" lang="zh-CN">
          <span>ZH-CN · {liveInput ? 'LIVE INPUT' : 'DEMO SCRIPT'}</span>
          <p>{line.zh}</p>
        </div>
      </div>

      <div className="source-telemetry">
        <div>
          <span>UPLINK</span>
          <strong>
            {liveBitrate == null
              ? `${(experience.profile.uplinkKbps / 1000).toFixed(1)} Mbps`
              : `${(liveBitrate / 1000).toFixed(2)} Mbps`}
          </strong>
          <small>{liveBitrate == null ? 'EMULATED' : 'LIVE'}</small>
        </div>
        <div>
          <span>CAPTURE</span>
          <strong>
            {captureResolution} · {captureFps}
          </strong>
          <small>{liveInput ? 'LIVE' : 'EMULATED'}</small>
        </div>
        <div>
          <span>POSE</span>
          <strong>SEEDED</strong>
          <small>EMULATED</small>
        </div>
      </div>

      <div className="source-actions">
        <button type="button" onClick={openPhoneSource} data-testid="connect-qr">
          <Icon name="qr" size={15} />
          Phone
        </button>
        <button type="button" onClick={useLocalCamera}>
          <Icon name="camera" size={15} />
          This camera
        </button>
        <button type="button" onClick={useMock} data-testid="fallback-mock-source">
          <Icon name="spark" size={15} />
          Mock
        </button>
        <button
          type="button"
          onClick={toggleSourceMuted}
          aria-pressed={sourceMuted}
          aria-label={sourceMuted ? 'Unmute source' : 'Mute source'}
        >
          <Icon name={sourceMuted ? 'mute' : 'mic'} size={15} />
        </button>
      </div>

      <div className="script-control">
        <button type="button" onClick={() => setScriptIndex((scriptIndex + 1) % DEMO_LINES.length)}>
          <Icon name="chevron" size={14} />
          Next script
        </button>
        <button type="button" onClick={playLine} disabled={speaking}>
          <Icon name={speaking ? 'pause' : 'play'} size={14} />
          {speaking ? 'Speaking…' : 'Voice preview'}
        </button>
      </div>
      {recoverableMessage && (
        <p className="source-message" role="status">
          {recoverableMessage}
        </p>
      )}

      {qrOpen && (
        <div className="modal-layer" role="presentation" onMouseDown={() => setQrOpen(false)}>
          <div
            ref={qrDialogRef}
            className="qr-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="qr-title"
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              className="modal-close"
              type="button"
              onClick={() => setQrOpen(false)}
              aria-label="Close phone connection dialog"
              data-dialog-initial-focus
            >
              <Icon name="close" />
            </button>
            <span className="section-kicker">MOBILE CONTRIBUTION</span>
            <h2 id="qr-title">Scan to connect the host camera</h2>
            <p>Open this secure session on a phone connected to the same network.</p>
            <div className="qr-code-wrap">
              <QRCodeSVG
                value={phoneUrl}
                size={196}
                bgColor="#ffffff"
                fgColor="#061017"
                level="M"
                marginSize={2}
              />
            </div>
            <code>{phoneUrl}</code>
            <div className="privacy-line">
              <Icon name="shield" size={15} />
              Camera and microphone are never recorded or persisted.
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
