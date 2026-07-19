// Node 环回 E2E：用与手机端相同的纯 TS 传输（UplinkClient）在 Node 连本地真引擎，
// 以 ~10fps 发合法 20 字节头 + 占位 JPEG（FF D8 FF D9）约 6.5s（跨 ≥2 上报窗口），
// 停后拉 GET /status 自断言 uplink 频道出现、非 stale、fps_sent>0、rtt_ms 为数值。
// 无真机的可验证闭环：证明传输层能把帧/uplink_stats/ping-pong 真正打进引擎并被记录。
//
// 运行（`ws`/`tsx` 从仓库根 node_modules 解析，同 capture-e2e）：
//   终端1（engine/）：<m0-venv-python> -m service.run_local --port 8930
//   终端2（worktree 根）：E2E_PORT=8930 npx tsx mobile/e2e/loopback.ts
// 退出码：PASS=0 / FAIL=1 / 引擎不可达=2。
import WebSocket from "ws";
import { UplinkClient } from "../src/net/uplinkClient";
import type { Deps, WebSocketLike } from "../src/net/uplinkClient";

const PORT = process.env.E2E_PORT || "8930";
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ingest`;
const CHANNEL = 0;
const FPS = 10;
const DURATION_MS = 6500; // 覆盖 ≥3 个 2s 上报窗口（t≈2/4/6s）
// 占位 JPEG：最小合法 SOI+EOI 标记（引擎只需能收帧计数即可）。
const PLACEHOLDER_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<number> {
  // 引擎可达性预检（同 capture-e2e）：不可达则退 2 并提示启动命令。
  try {
    const r = await fetch(`${BASE}/status`);
    if (!r.ok) throw new Error(`GET /status -> HTTP ${r.status}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[e2e] engine service unreachable at ${BASE} (${msg})`);
    console.error(
      `[e2e] start it first: <m0-venv-python> -m service.run_local --port ${PORT}`
    );
    return 2;
  }

  const deps: Deps = {
    wsFactory: (url: string) => new WebSocket(url) as unknown as WebSocketLike,
    now: () => performance.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };

  const client = new UplinkClient(WS_URL, CHANNEL, deps);
  client.start();

  // ~10fps 发帧循环，持续 DURATION_MS。
  const frameTimer = setInterval(() => {
    client.sendFrame(PLACEHOLDER_JPEG);
  }, 1000 / FPS);
  await sleep(DURATION_MS);
  clearInterval(frameTimer);

  const hud = client.hud();
  client.stop();
  await sleep(300); // 让 close 落定，再取快照

  const status = (await (await fetch(`${BASE}/status`)).json()) as {
    uplink?: Record<string, { fps_sent?: unknown; rtt_ms?: unknown; stale?: unknown }>;
  };
  const up = status.uplink?.[String(CHANNEL)];

  const checks: Record<string, boolean> = {
    "uplink[0] present": !!up,
    "stale === false": up?.stale === false,
    "fps_sent > 0": typeof up?.fps_sent === "number" && up.fps_sent > 0,
    "rtt_ms is a number": typeof up?.rtt_ms === "number",
  };
  const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  const result = failed.length === 0 ? "PASS" : "FAIL";

  console.log(
    JSON.stringify(
      {
        base: BASE,
        ws_url: WS_URL,
        channel: CHANNEL,
        duration_ms: DURATION_MS,
        client_hud: hud,
        uplink: up,
        checks,
        result,
      },
      null,
      2
    )
  );

  if (failed.length) {
    console.error(`[e2e] FAIL — ${failed.join("; ")}`);
    return 1;
  }
  console.error(
    `[e2e] PASS — fps_sent=${up?.fps_sent}, rtt_ms=${up?.rtt_ms}, stale=${up?.stale}`
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[e2e] unexpected error:", err);
    process.exit(1);
  }
);
