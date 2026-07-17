// M1c Task 6 — Playwright 假摄像头全链路 E2E
//
// 链路：chromium 假摄像头（--use-file-for-fake-video-capture=d14.y4m，含真人脸）
//   → page A /capture?fps=10（getUserMedia → canvas → JPEG → ws /ingest）
//   → engine 真实 pipeline（LivePortrait）
//   → page B /?channel=0（viewer，ws /out → canvas 绘制 + frames 计数）
//
// 运行方式（Node 模块解析说明）：本 worktree 位于主 checkout 目录内
//   （OneLive\.worktrees\v2-m1c\engine\e2e），Node ESM 解析从脚本所在目录逐级向上
//   查找 node_modules，天然命中主 checkout 的 OneLive\node_modules（含 @playwright/test），
//   因此无需 NODE_PATH / npm install，直接 `node engine/e2e/capture-e2e.mjs` 即可。
//
// 前置：engine 服务已在 E2E_PORT（默认 8910）监听；y4m 已生成（默认 engine/out/d14.y4m）。
// 输出：stderr 打人类可读进度，stdout 最后打一份 JSON 汇总（便于重定向收集）。
// 判定：结束时拉 GET /status 自断言（errors==0 && processed>0 && viewer 帧数递增），
//   PASS 退出码 0；FAIL 退出码 1；前置不满足（y4m 缺失/服务不可达）退出码 2。

import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.E2E_PORT || "8910";
const BASE = `http://127.0.0.1:${PORT}`;
const Y4M = process.env.E2E_Y4M || path.resolve(here, "..", "out", "d14.y4m");
const DURATION_S = Number(process.env.E2E_DURATION_S || 60);
const SAMPLE_EVERY_S = 10;
const SHOT_DIR = process.env.E2E_SHOT_DIR || path.resolve(here, "..", "out", "e2e_m1c");

if (!fs.existsSync(Y4M)) {
  console.error(`y4m not found: ${Y4M}`);
  process.exit(2);
}
fs.mkdirSync(SHOT_DIR, { recursive: true });

// 服务可达性预检：起浏览器（~秒级开销）之前先确认 engine 在监听
try {
  const r = await fetch(`${BASE}/status`);
  if (!r.ok) throw new Error(`GET /status -> HTTP ${r.status}`);
} catch (e) {
  console.error(`[e2e] engine service unreachable at ${BASE} (${e.message ?? e})`);
  console.error(`[e2e] start it first: <m0-venv-python> -m service.run_local --port ${PORT}`);
  process.exit(2);
}

const browser = await chromium.launch({
  headless: true, // 假摄像头 headless 下可用
  args: [
    "--use-fake-ui-for-media-stream",     // 自动允许摄像头权限，免弹窗
    "--use-fake-device-for-media-stream", // 用假设备替代真实摄像头
    `--use-file-for-fake-video-capture=${Y4M}`, // 假设备循环播放该 y4m
  ],
});
const context = await browser.newContext();

// 先开 viewer（page B），确保 /out 订阅在采集开始前就绪，不漏最早的产出帧
const pageB = await context.newPage();
await pageB.goto(`${BASE}/?channel=0`, { waitUntil: "domcontentloaded" });

const pageA = await context.newPage();
await pageA.goto(`${BASE}/capture?fps=10`, { waitUntil: "domcontentloaded" });
await pageA.click("#start");
const startedAt = new Date().toISOString();
console.error(`[e2e] started capture at ${startedAt}, sampling every ${SAMPLE_EVERY_S}s for ${DURATION_S}s`);

async function sample(tS) {
  const a = await pageA.evaluate(() => {
    const v = document.getElementById("v");
    return {
      status: document.getElementById("status").textContent,
      conn: document.getElementById("conn").textContent,
      video: `${v.videoWidth}x${v.videoHeight}`,
    };
  });
  const b = await pageB.evaluate(() => ({
    stats: document.getElementById("stats").textContent,
    conn: document.getElementById("conn").textContent,
  }));
  const s = { t_s: tS, ts: new Date().toISOString(), pageA: a, pageB: b };
  console.error(`[e2e ${tS}s] A: ${a.status} (${a.video}) | B: ${b.stats} (${b.conn})`);
  return s;
}

const samples = [];
for (let t = SAMPLE_EVERY_S; t <= DURATION_S; t += SAMPLE_EVERY_S) {
  await new Promise((r) => setTimeout(r, SAMPLE_EVERY_S * 1000));
  samples.push(await sample(t));
}

// 证据截图：page A 的本地预览（假摄像头画面）与 page B 的渲染结果
await pageA.screenshot({ path: path.join(SHOT_DIR, "pageA_capture.png") });
await pageB.screenshot({ path: path.join(SHOT_DIR, "pageB_viewer.png") });
await browser.close();

// 自断言：/status 的频道统计 + viewer 帧计数进展（无需人工读日志判 PASS/FAIL）
const status = await (await fetch(`${BASE}/status`)).json();
const chStats = status.channels?.["0"] ?? status.channel ?? {};
const framesOf = (s) => Number(/frames:\s*(\d+)/.exec(s.pageB.stats)?.[1] ?? NaN);
const firstFrames = framesOf(samples[0]);
const lastFrames = framesOf(samples[samples.length - 1]);

const checks = {
  "status.errors == 0": chStats.errors === 0,
  "status.processed > 0": chStats.processed > 0,
  "viewer frames progressed (last > first)":
    Number.isFinite(firstFrames) && Number.isFinite(lastFrames) && lastFrames > firstFrames,
};
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);

console.log(JSON.stringify({
  base: BASE, y4m: Y4M, duration_s: DURATION_S, started_at: startedAt,
  finished_at: new Date().toISOString(), samples, status, checks,
  result: failed.length === 0 ? "PASS" : "FAIL",
}, null, 2));

if (failed.length === 0) {
  console.error(`[e2e] PASS — processed=${chStats.processed}, errors=${chStats.errors}, viewer frames ${firstFrames} -> ${lastFrames}`);
} else {
  console.error(`[e2e] FAIL — ${failed.join("; ")} (processed=${chStats.processed}, errors=${chStats.errors}, viewer frames ${firstFrames} -> ${lastFrames})`);
  process.exit(1);
}
