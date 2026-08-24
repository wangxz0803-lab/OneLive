import { useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Icon } from '@/components/Icon';
import { DEMO_MEDIA } from '@/config/demoMedia';
import { MARKET_PROFILES } from '@/config/markets';
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
    <div className="mock-camera-signal" role="img" aria-label="稳定的模拟主播信号">
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
  const [sourceToolsOpen, setSourceToolsOpen] = useState(false);
  const [sourceMediaUnavailable, setSourceMediaUnavailable] = useState(false);
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
    selectedMarketId,
    activeRecording,
    setSource,
    setSourceMuted,
    setScriptIndex,
    setActiveRecording,
  } = useOneLiveStore();
  useDialogFocus(qrOpen, qrDialogRef, () => setQrOpen(false));
  const line = DEMO_LINES[scriptIndex % DEMO_LINES.length];
  const selectedMarket =
    MARKET_PROFILES.find((market) => market.id === selectedMarketId) ?? MARKET_PROFILES[0];
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
    const video = videoRef.current;
    if (!video || sourceKind !== 'mock' || sourceMediaUnavailable) return;
    if (activeRecording !== 'original') {
      video.pause();
      return;
    }
    const result = video.play();
    result?.catch(() => undefined);
  }, [activeRecording, sourceKind, sourceMediaUnavailable]);

  useEffect(() => {
    if (remoteReady && !remoteReadyRef.current) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setLocalStream(null);
      setSource('phone', true);
      setCameraMessage('手机摄像头已通过 WebRTC 实时会话连接。');
    } else if (!remoteReady && remoteReadyRef.current && sourceKind === 'phone') {
      setSource('mock', true);
      setLiveStats(null);
      setCameraMessage('手机信号已结束，稳定演示素材已接管。');
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
      setCameraMessage('本机摄像头已连接，媒体仅用于当前会话。');
    } catch {
      if (streamRef.current) {
        setSource('local-camera', true);
        setCameraMessage('摄像头刷新失败，当前本机画面继续使用。');
      } else {
        setLocalStream(null);
        setSource('mock', true);
        setCameraMessage('摄像头不可用，已切换到稳定演示素材。');
      }
    }
  };

  const useMock = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setLocalStream(null);
    setSource('mock', true);
    setCameraMessage('演示素材已启用，不需要摄像头或外部 API。');
  };

  const openPhoneSource = () => {
    if (remoteReady) {
      setSource('phone', true);
      setCameraMessage('已选择当前 WebRTC 会话中的手机摄像头。');
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
    await tts.speak(
      line.translations[selectedMarket.id],
      selectedMarket.locale,
      selectedMarket.ttsVoicePreference,
    );
    setSpeaking(false);
  };

  const sourceStatus =
    sourceKind === 'phone'
      ? remoteReady
        ? 'WEBRTC 已连接 · 实时 LIVE'
        : broadcasterPresent && realtime.joined
          ? '手机已加入 · 实时 LIVE'
          : '等待手机连接'
      : sourceKind === 'local-camera'
        ? liveInput
          ? '摄像头已连接 · 实时 LIVE'
          : '摄像头不可用'
        : broadcasterPresent && realtime.joined
          ? '演示素材 · 手机在线 LIVE'
          : '演示素材就绪';
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
      aria-label="真人主播主直播源"
    >
      <span className="visually-hidden" data-testid="source-mode" data-source={sourceKind}>
        {sourceKind} 输入源
      </span>
      <header className="panel-header source-panel__header">
        <div>
          <span className="section-kicker">真人直播源</span>
          <strong>真人主播 · 中文主直播</strong>
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
        ) : sourceKind === 'mock' && !sourceMediaUnavailable ? (
          <div className="source-recording-frame">
            <video
              ref={videoRef}
              data-testid="source-recording"
              src={DEMO_MEDIA.original.src}
              poster={DEMO_MEDIA.original.poster}
              preload="metadata"
              playsInline
              controls
              loop
              onPlay={() => setActiveRecording('original')}
              onEnded={() => setActiveRecording(null)}
              onError={() => {
                setSourceMediaUnavailable(true);
                setActiveRecording(null);
              }}
            />
          </div>
        ) : (
          <MockCameraSignal />
        )}
        <div className="source-preview__top">
          <span className={liveInput ? 'live-badge' : 'provenance-badge'}>
            {liveInput && <i />}{' '}
            {sourceKind === 'mock' ? '真人样例' : liveInput ? '实时 LIVE' : '连接中'}
          </span>
          <span className="provenance-badge">
            {liveInput ? '实时输入 LIVE' : DEMO_MEDIA.original.provenanceLabel}
          </span>
        </div>
        <div className="source-preview__bottom">
          <span>
            <Icon name="camera" size={13} />
            {sourceKind === 'mock'
              ? '15秒真人直播样例'
              : sourceKind === 'phone'
                ? '手机摄像头'
                : '摄像头 01'}
          </span>
          <span>
            <Icon name={sourceMuted ? 'mute' : 'mic'} size={13} />
            {sourceMuted ? '已静音' : liveInput ? '实时音频 LIVE' : '原始音频'}
          </span>
          <span>
            <Icon name="shield" size={13} />
            {sourceKind === 'mock' ? '真人主源' : '当前会话已授权'}
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
          aria-label={liveInput ? '实时输入音量' : '模拟演示音量'}
        >
          {Array.from({ length: 24 }, (_, index) => (
            <i key={index} style={{ '--wave-index': index } as React.CSSProperties} />
          ))}
        </div>
        <div className="source-caption" lang="zh-CN">
          <span>ZH-CN · {liveInput ? '实时输入 LIVE' : '主播中文原声'}</span>
          <p>{line.zh}</p>
        </div>
      </div>

      <div className="source-telemetry">
        <div>
          <span>上行</span>
          <strong>
            {liveBitrate == null
              ? `${(experience.profile.uplinkKbps / 1000).toFixed(1)} Mbps`
              : `${(liveBitrate / 1000).toFixed(2)} Mbps`}
          </strong>
          <small>{liveBitrate == null ? '网络配置' : '实时 LIVE'}</small>
        </div>
        <div>
          <span>采集</span>
          <strong>
            {captureResolution} · {captureFps}
          </strong>
          <small>{liveInput ? '实时 LIVE' : '演示采集'}</small>
        </div>
        <div>
          <span>媒体</span>
          <strong>{sourceKind === 'mock' ? '本地 MP4' : '当前会话'}</strong>
          <small>{liveInput ? '实时 LIVE' : '本地素材'}</small>
        </div>
      </div>

      <button
        className="source-tools-toggle"
        type="button"
        aria-expanded={sourceToolsOpen}
        aria-controls="source-tools"
        aria-label={sourceToolsOpen ? '收起输入源工具' : '打开输入源工具'}
        onClick={() => setSourceToolsOpen((open) => !open)}
      >
        <Icon name="settings" size={15} />
        输入源工具
        <Icon name="chevron" size={14} />
      </button>

      <div id="source-tools" className="source-tools" hidden={!sourceToolsOpen}>
        <div className="source-actions">
          <button type="button" onClick={openPhoneSource} data-testid="connect-qr">
            <Icon name="qr" size={15} />
            手机
          </button>
          <button type="button" onClick={useLocalCamera}>
            <Icon name="camera" size={15} />
            本机摄像头
          </button>
          <button type="button" onClick={useMock} data-testid="fallback-mock-source">
            <Icon name="spark" size={15} />
            演示素材
          </button>
          <button
            type="button"
            onClick={toggleSourceMuted}
            aria-pressed={sourceMuted}
            aria-label={sourceMuted ? '取消输入静音' : '静音输入'}
          >
            <Icon name={sourceMuted ? 'mute' : 'mic'} size={15} />
          </button>
        </div>

        <div className="script-control">
          <button
            type="button"
            onClick={() => setScriptIndex((scriptIndex + 1) % DEMO_LINES.length)}
          >
            <Icon name="chevron" size={14} />
            下一段文案
          </button>
          <button type="button" onClick={playLine} disabled={speaking}>
            <Icon name={speaking ? 'pause' : 'play'} size={14} />
            {speaking ? '播放中…' : `${selectedMarket.market}语音预览`}
          </button>
        </div>
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
              aria-label="关闭手机连接窗口"
              data-dialog-initial-focus
            >
              <Icon name="close" />
            </button>
            <span className="section-kicker">手机采集</span>
            <h2 id="qr-title">扫码连接主播手机</h2>
            <p>请用同一网络中的手机打开此安全会话。</p>
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
              摄像头和麦克风默认不会录制或持久化保存。
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
