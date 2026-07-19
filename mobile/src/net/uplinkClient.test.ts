// 参考传输单测：假 WebSocket + 注入时钟/定时器，验证发帧/ping-pong RTT/
// uplink_stats/退避重连/停，全程不碰真实网络与真实时钟。
import { UplinkClient } from "./uplinkClient";
import type { Deps, WebSocketLike } from "./uplinkClient";

const OPEN = 1;
const CLOSED = 3;

class FakeWS implements WebSocketLike {
  readyState = 0; // CONNECTING
  bufferedAmount = 0;
  binaryType = "";
  sent: Array<string | ArrayBuffer> = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = CLOSED;
    this.onclose?.();
  }
  strings(): string[] {
    return this.sent.filter((d): d is string => typeof d === "string");
  }
  binaries(): ArrayBuffer[] {
    return this.sent.filter((d): d is ArrayBuffer => typeof d !== "string");
  }
}

function makeHarness(channel = 0) {
  const wsList: FakeWS[] = [];
  let clock = 1000;
  const timeouts: Array<{ fn: () => void; ms: number }> = [];
  let intervalFn: (() => void) | null = null;
  const states: string[] = [];
  const deps: Deps = {
    wsFactory: () => {
      const ws = new FakeWS();
      wsList.push(ws);
      return ws;
    },
    now: () => clock,
    setTimeout: (fn: () => void, ms: number) => {
      timeouts.push({ fn, ms });
      return timeouts.length - 1;
    },
    clearTimeout: () => {},
    setInterval: (fn: () => void) => {
      intervalFn = fn;
      return 1;
    },
    clearInterval: () => {
      intervalFn = null;
    },
    rng: () => 1,
    onState: (s) => states.push(s),
  };
  const client = new UplinkClient("ws://pc/ingest", channel, deps);
  return {
    client,
    wsList,
    timeouts,
    states,
    lastWs: () => wsList[wsList.length - 1],
    getInterval: () => intervalFn,
    setClock: (v: number) => {
      clock = v;
    },
  };
}

// 起连并打开：模拟 wsFactory 建连后 onopen 触发。
function startAndOpen(h: ReturnType<typeof makeHarness>) {
  h.client.start();
  const ws = h.lastWs();
  ws.readyState = OPEN;
  ws.onopen?.();
  return ws;
}

describe("UplinkClient lifecycle", () => {
  it("transitions idle -> connecting -> connected on open", () => {
    const h = makeHarness();
    startAndOpen(h);
    expect(h.states).toEqual(["connecting", "connected"]);
    expect(h.client.hud().state).toBe("connected");
  });
});

describe("UplinkClient.sendFrame", () => {
  it("emits a 20-byte header + payload binary frame when open", () => {
    const h = makeHarness(7);
    const ws = startAndOpen(h);
    ws.bufferedAmount = 0;
    h.client.sendFrame(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    const bins = ws.binaries();
    expect(bins.length).toBe(1);
    const u8 = new Uint8Array(bins[0]);
    expect(u8[0]).toBe(0x4c); // magic low byte
    expect(u8[3]).toBe(7); // channel
    expect(u8.length).toBe(20 + 4); // header + payload
  });

  it("skips (no send) when the socket is not OPEN", () => {
    const h = makeHarness();
    h.client.start(); // still CONNECTING
    h.client.sendFrame(new Uint8Array([0xff, 0xd8]));
    expect(h.lastWs().binaries().length).toBe(0);
  });

  it("skips when bufferedAmount exceeds 1MB (exit congestion)", () => {
    const h = makeHarness();
    const ws = startAndOpen(h);
    ws.bufferedAmount = 2 * 1024 * 1024;
    h.client.sendFrame(new Uint8Array([0xff, 0xd8]));
    expect(ws.binaries().length).toBe(0);
  });
});

describe("UplinkClient.reportStats", () => {
  it("sends a ping and an uplink_stats frame with the window fps", () => {
    const h = makeHarness(0);
    const ws = startAndOpen(h);
    for (let i = 0; i < 20; i++) {
      h.client.sendFrame(new Uint8Array([0xff, 0xd8]));
    }
    h.client.reportStats();
    const msgs = ws.strings().map((s) => JSON.parse(s));
    const ping = msgs.find((m) => m.type === "ping");
    const stats = msgs.find((m) => m.type === "uplink_stats");
    expect(ping).toBeTruthy();
    expect(typeof ping.t).toBe("number");
    expect(stats).toBeTruthy();
    expect(stats.channel).toBe(0);
    expect(stats.fps_sent).toBe(10); // 20 frames over a 2s window
  });

  it("counts skipped beats into the next uplink_stats report", () => {
    const h = makeHarness();
    h.client.start(); // not open -> every sendFrame skips
    h.client.sendFrame(new Uint8Array([0xff, 0xd8]));
    h.client.sendFrame(new Uint8Array([0xff, 0xd8]));
    h.client.markSkipped();
    const ws = h.lastWs();
    ws.readyState = OPEN;
    ws.onopen?.();
    h.client.reportStats();
    const stats = ws.strings().map((s) => JSON.parse(s)).find((m) => m.type === "uplink_stats");
    expect(stats.skipped).toBe(3);
  });
});

describe("UplinkClient ping/pong RTT", () => {
  it("computes lastRtt from the echoed pong timestamp (WS link RTT)", () => {
    const h = makeHarness();
    const ws = startAndOpen(h);
    h.setClock(1000);
    h.client.reportStats(); // ping t = 1000
    const ping = ws.strings().map((s) => JSON.parse(s)).find((m) => m.type === "ping");
    h.setClock(1030);
    ws.onmessage?.({ data: JSON.stringify({ type: "pong", t: ping.t }) });
    expect(h.client.hud().rttMs).toBe(30);
  });
});

describe("UplinkClient backoff reconnect", () => {
  it("schedules a backoff reconnect on close while running", () => {
    const h = makeHarness();
    startAndOpen(h);
    expect(h.wsList.length).toBe(1);
    h.lastWs().close(); // onclose while running
    expect(h.timeouts.length).toBe(1);
    expect(h.timeouts[0].ms).toBe(500); // rng=1, attempt 0 -> base 500
    h.timeouts[0].fn(); // fire the reconnect
    expect(h.wsList.length).toBe(2); // a fresh socket was created
  });

  it("stop() detaches onclose (no reconnect) and closes", () => {
    const h = makeHarness();
    const ws = startAndOpen(h);
    h.client.stop();
    expect(ws.onclose).toBeNull();
    expect(h.client.hud().state).toBe("closed");
    expect(h.getInterval()).toBeNull(); // stats interval cleared
    expect(h.timeouts.length).toBe(0); // no reconnect scheduled
  });
});
