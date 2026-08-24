import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { OneLiveLogo } from '@/components/OneLiveLogo';
import { DEMO_LINES } from '@/config/scripts';
import { useDialogFocus } from '@/hooks/useDialogFocus';
import {
  fetchRuntimeConfig,
  SENDER_CONSTRAINTS,
  useBroadcasterPeer,
  useSessionSocket,
  type BroadcasterSourceState,
  type RuntimeConfig,
  type SourceCommand,
} from '@/realtime';

type CaptureState = 'idle' | 'requesting' | 'live' | 'mock' | 'ended';

export function BroadcasterPage() {
  const { sessionId = 'local-demo' } = useParams();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [state, setState] = useState<CaptureState>('idle');
  const [muted, setMuted] = useState(false);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [scriptIndex, setScriptIndex] = useState(0);
  const [message, setMessage] = useState('相机和麦克风将在开始直播后启用。');
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  useDialogFocus(sheetOpen, sheetRef, () => setSheetOpen(false));
  const realtime = useSessionSocket({
    sessionId,
    role: 'broadcaster',
    path: runtimeConfig?.socketPath,
  });

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
    video.srcObject = stream;
    if (stream) void video.play().catch(() => undefined);
    return () => {
      if (video.srcObject === stream) video.srcObject = null;
    };
  }, [stream]);

  const openStream = async (nextFacing = facingMode) => {
    setState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: nextFacing },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      const previousStream = streamRef.current;
      streamRef.current = stream;
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
      setStream(stream);
      setFacingMode(nextFacing);
      previousStream?.getTracks().forEach((track) => track.stop());
      setState('live');
      setMessage('直播信号已接入。媒体不会被录制或保存。');
    } catch {
      if (streamRef.current) {
        setState('live');
        setMessage('暂时无法切换镜头，当前直播画面继续保持。');
      } else {
        setStream(null);
        setState('mock');
        setMessage('相机不可用，已切换至安全演示信号，可随时重试。');
      }
    }
  };

  const stop = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
    if (videoRef.current) videoRef.current.srcObject = null;
    setState('ended');
    setMessage('直播已结束，相机和麦克风已释放。');
  };

  const setCaptureMuted = (next: boolean) => {
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    setMuted(next);
  };

  const toggleMute = () => setCaptureMuted(!muted);

  const switchCamera = async () => {
    const next = facingMode === 'user' ? 'environment' : 'user';
    if (state === 'live') await openStream(next);
    else setFacingMode(next);
  };

  const sourceState = useMemo<BroadcasterSourceState>(() => {
    const audioEnabled =
      !muted &&
      Boolean(
        stream?.getAudioTracks().some((track) => track.enabled && track.readyState === 'live'),
      );
    const videoEnabled = Boolean(
      stream?.getVideoTracks().some((track) => track.enabled && track.readyState === 'live'),
    );
    const connection: BroadcasterSourceState['connection'] =
      state === 'requesting'
        ? 'requesting-media'
        : state === 'live'
          ? 'ready'
          : state === 'mock'
            ? 'failed'
            : 'idle';
    return {
      connection,
      audioEnabled,
      videoEnabled,
      facingMode,
      // The peer integration stamps the state at the actual Socket.IO emission boundary.
      updatedAt: 0,
    };
  }, [facingMode, muted, state, stream]);

  const handleSourceCommand = (command: SourceCommand): void => {
    if (command.type === 'set-muted') {
      setCaptureMuted(command.muted);
    } else if (command.type === 'switch-camera' && state === 'live') {
      void switchCamera();
    }
  };

  const controlPresent = Boolean(realtime.presence?.roles.control);
  const peer = useBroadcasterPeer({
    socket: realtime.socket,
    sessionId,
    joined: realtime.joined,
    epoch: realtime.epoch,
    controlPresent,
    stream,
    iceServers: runtimeConfig?.iceServers,
    initialConstraints: SENDER_CONSTRAINTS.premium,
    sourceState,
    onCommand: handleSourceCommand,
    onSenderParameters: (result) => {
      if (!result.applied && result.reason) {
        setMessage(`直播发送参数暂时无法调整：${result.reason}`);
      }
    },
  });

  const isActive = state === 'live' || state === 'mock';
  const captureLive = state === 'live' && Boolean(stream);
  const sessionLive = realtime.connected && realtime.joined;
  const peerLive = peer.connectionState === 'connected';
  const connectionLabel = !realtime.connected
    ? realtime.error
      ? '信号重连中'
      : '信号离线'
    : !realtime.joined
      ? '正在加入直播会话'
      : peerLive
        ? 'WebRTC 已连接 · LIVE'
        : controlPresent
          ? '控制台在线 · LIVE'
          : '会话已就绪 · LIVE';
  const statusMessage = peer.error || realtime.error || message;

  return (
    <main
      id="main-content"
      className="broadcaster"
      data-testid="broadcaster-shell"
      data-state={state}
    >
      <h1 className="visually-hidden">OneLive 移动直播端</h1>
      <header className="broadcaster-header">
        <OneLiveLogo compact />
        <div
          className={`mobile-connection ${sessionLive ? 'mobile-connection--live' : ''}`}
          data-testid="connection-state"
          data-peer-state={peer.connectionState}
          role="status"
        >
          {sessionLive && <i />}
          <span>{connectionLabel}</span>
        </div>
      </header>
      <section className="camera-frame" data-testid="camera-preview">
        <video ref={videoRef} muted playsInline className={state === 'live' ? 'visible' : ''} />
        {state !== 'live' && (
          <div className="mobile-camera-placeholder">
            <div className="mobile-silhouette">
              <i />
              <span />
            </div>
            <div className="camera-grid" />
          </div>
        )}
        <div className="camera-topline">
          <span className={captureLive ? 'mobile-live active' : 'mobile-live'}>
            {captureLive && <i />}
            {captureLive ? 'LIVE' : state === 'mock' ? '安全演示 · EMULATED' : '预览'}
          </span>
          <span>会话 {sessionId.slice(0, 10).toUpperCase()}</span>
        </div>
        <div className="camera-bottomline">
          <div>
            <Icon name="signal" size={15} />
            <span>
              上行信号
              <strong>
                {peerLive
                  ? 'WebRTC LIVE'
                  : captureLive
                    ? '媒体已就绪'
                    : state === 'mock'
                      ? '模拟信号'
                      : '待机'}
              </strong>
            </span>
          </div>
          <div>
            <Icon name="shield" size={15} />
            <span>
              AI 授权<strong>仅限本次会话</strong>
            </span>
          </div>
        </div>
        {state === 'mock' && (
          <div className="mobile-fallback-banner" data-testid="fallback-mock-source" role="status">
            <Icon name="spark" size={16} />
            <span>
              <strong>安全演示信号</strong>无需依赖相机硬件
            </span>
          </div>
        )}
      </section>
      <section className="mobile-status-copy" aria-live="polite">
        <p>{statusMessage}</p>
        <span>
          <Icon name="shield" size={13} />
          不录制 · 不保存 · 自动重连
        </span>
      </section>
      <section className="control-dock">
        {!isActive ? (
          <button
            className="broadcast-primary"
            type="button"
            onClick={() => openStream()}
            disabled={state === 'requesting'}
            data-testid="broadcast-start"
          >
            <Icon name={state === 'requesting' ? 'radio' : 'play'} />
            {state === 'requesting'
              ? '正在请求相机…'
              : state === 'ended'
                ? '重新开始直播'
                : '开始直播'}
          </button>
        ) : (
          <button
            className="broadcast-primary broadcast-primary--stop"
            type="button"
            onClick={stop}
            data-testid="broadcast-stop"
          >
            <Icon name="pause" />
            结束直播
          </button>
        )}
        <div className="mobile-secondary-actions">
          <button type="button" onClick={toggleMute} aria-pressed={muted} data-testid="mute-toggle">
            <Icon name={muted ? 'mute' : 'mic'} />
            <span>{muted ? '取消静音' : '静音'}</span>
          </button>
          <button type="button" onClick={switchCamera} data-testid="camera-switch">
            <Icon name="rotate" />
            <span>切换镜头</span>
          </button>
          <button type="button" onClick={() => setSheetOpen(true)}>
            <Icon name="spark" />
            <span>直播文案</span>
          </button>
        </div>
      </section>
      {sheetOpen && (
        <div
          className="mobile-sheet-layer"
          role="presentation"
          onMouseDown={() => setSheetOpen(false)}
        >
          <section
            ref={sheetRef}
            className="script-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="script-sheet-title"
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span>演示提词器</span>
                <h2 id="script-sheet-title">选择直播文案</h2>
              </div>
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                aria-label="关闭直播文案"
                data-dialog-initial-focus
              >
                <Icon name="close" />
              </button>
            </header>
            <div>
              {DEMO_LINES.map((line, index) => (
                <button
                  key={line.id}
                  type="button"
                  className={scriptIndex === index ? 'active' : ''}
                  onClick={() => {
                    setScriptIndex(index);
                    setSheetOpen(false);
                  }}
                >
                  <span>0{index + 1}</span>
                  <p lang="zh-CN">{line.zh}</p>
                  {scriptIndex === index && <Icon name="check" />}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
