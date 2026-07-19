// 参考上行传输：连接 /ingest、按 20 字节协议发 JPEG 帧、ping/pong 测 WS 链路 RTT、
// 每 2s 上报 uplink_stats、断线指数退避重连。逻辑独立复刻 engine/service/capture.html
// 的传输段（设备热路径走 WebView 里的 capture.html；本类是可单测/可 Node 环回的等价实现）。
//
// 依赖全注入（wsFactory/时钟/定时器/rng/回调）→ 假 WebSocket + 假时钟即可全覆盖单测，
// Node 环回时注入真 ws/真定时器/performance.now 连本地真引擎。RN 与 Node 都有全局
// WebSocket/ArrayBuffer/BigInt/DataView.setBigUint64，故编码零 polyfill。
import { encodeFrame } from "../protocol/frame";
import { backoffDelay } from "./backoff";
import { buildUplinkStats } from "./uplinkStats";

const OPEN = 1; // WebSocket.OPEN
const MAX_BUFFERED = 1024 * 1024; // bufferedAmount 超 1MB 跳帧，避免无界堆积
const STATS_INTERVAL_S = 2; // 每 2s 上报一次窗口 uplink_stats（同 capture.html）

export type UplinkState =
  | "idle"
  | "connecting"
  | "connected"
  | "error"
  | "closed";

export interface Hud {
  fpsSent: number;
  rttMs: number | null;
  state: UplinkState;
}

// 假/真 WebSocket 的最小共同面（浏览器/RN/Node ws 都满足）。
export interface WebSocketLike {
  readyState: number;
  bufferedAmount: number;
  binaryType: string;
  send(data: string | ArrayBuffer): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

export interface Deps {
  wsFactory: (url: string) => WebSocketLike;
  now: () => number; // 单调钟（performance.now 等价），用于 RTT
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  rng?: () => number;
  onState?: (state: UplinkState) => void;
  onHud?: (hud: Hud) => void;
}

export class UplinkClient {
  private ws: WebSocketLike | null = null;
  private running = false;
  private state: UplinkState = "idle";

  private seq = 0; // u64 序号，跨重连不重置
  private sent = 0; // 累计成功发出的帧数
  private skipped = 0; // 未连/拥塞跳过的节拍数
  private winBaseSent = 0;
  private winBaseSkipped = 0;
  private lastFps = 0; // 最近一窗上报的 fps_sent（供 HUD）
  private lastRtt: number | null = null; // 最近一次 pong 测得的 WS 链路 RTT(ms)
  private attempt = 0; // 退避重连尝试计数

  private statsTimer: unknown = null;
  private reconnectTimer: unknown = null;

  constructor(
    private readonly url: string,
    private readonly channel: number,
    private readonly deps: Deps
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    // 每 2s 上报窗口 uplink_stats（+ ping 探 RTT）。
    this.statsTimer = this.deps.setInterval(
      () => this.reportStats(),
      STATS_INTERVAL_S * 1000
    );
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.ws) {
      this.ws.onclose = null; // 摘 onclose，防退避重连
      this.ws.onmessage = null;
      this.ws.onopen = null;
      this.ws.onerror = null;
      this.ws.close();
    }
    this.ws = null;
    if (this.statsTimer !== null) {
      this.deps.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    if (this.reconnectTimer !== null) {
      this.deps.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setState("closed");
  }

  hud(): Hud {
    return { fpsSent: this.lastFps, rttMs: this.lastRtt, state: this.state };
  }

  markSkipped(): void {
    this.skipped += 1;
  }

  sendFrame(jpeg: Uint8Array): void {
    // 未连或出口拥塞（bufferedAmount>1MB）→ 跳帧计数，损伤在出口可观测。
    if (!this.ws || this.ws.readyState !== OPEN || this.ws.bufferedAmount > MAX_BUFFERED) {
      this.skipped += 1;
      return;
    }
    // ts_ms 用 Date.now()（墙钟毫秒，对齐 capture.html / protocol.py）。
    const frame = encodeFrame(this.channel, this.seq, Date.now(), jpeg);
    // 发 ArrayBuffer（拷出对应视图片段，避免底层 buffer 冗余尾巴）。
    const buf = frame.buffer.slice(
      frame.byteOffset,
      frame.byteOffset + frame.byteLength
    ) as ArrayBuffer;
    this.ws.send(buf);
    this.seq += 1;
    this.sent += 1;
  }

  reportStats(): void {
    // 先算窗口值并推进基线 + 更新 HUD fps（即便断连也让 HUD 归零/更新）。
    const built = buildUplinkStats({
      channel: this.channel,
      sent: this.sent,
      skipped: this.skipped,
      winBaseSent: this.winBaseSent,
      winBaseSkipped: this.winBaseSkipped,
      intervalS: STATS_INTERVAL_S,
      lastRtt: this.lastRtt,
    });
    this.winBaseSent = built.winBaseSent;
    this.winBaseSkipped = built.winBaseSkipped;
    this.lastFps = built.fpsSent;
    if (this.ws && this.ws.readyState === OPEN) {
      // ping t 用注入单调钟；服务端原样回显（pong），rtt = now - t = WS 链路 RTT。
      this.ws.send(JSON.stringify({ type: "ping", t: this.deps.now() }));
      this.ws.send(JSON.stringify(built.frame));
    }
    this.emitHud();
  }

  private connect(): void {
    if (!this.running) return;
    this.setState("connecting");
    const ws = this.deps.wsFactory(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0; // 连上即重置退避尝试
      this.setState("connected");
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let m: unknown;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      // pong 回显 t → RTT。用单调钟（now），不用 Date.now（NTP 跳变会污染）。
      if (
        m &&
        typeof m === "object" &&
        (m as { type?: unknown }).type === "pong" &&
        typeof (m as { t?: unknown }).t === "number"
      ) {
        this.lastRtt = this.deps.now() - (m as { t: number }).t;
        this.emitHud();
      }
    };
    ws.onerror = () => {
      this.setState("error");
      if (this.ws) this.ws.close();
    };
    ws.onclose = () => {
      this.ws = null;
      if (!this.running) return;
      // 指数退避 + full jitter 重连；seq 继续递增，不重置。
      const delay = backoffDelay(this.attempt++, this.deps.rng);
      this.reconnectTimer = this.deps.setTimeout(() => this.connect(), delay);
    };
  }

  private setState(state: UplinkState): void {
    this.state = state;
    this.deps.onState?.(state);
  }

  private emitHud(): void {
    this.deps.onHud?.(this.hud());
  }
}
