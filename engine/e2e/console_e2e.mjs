// M3b Task 4 — 导播控制台 E2E（Playwright）
//
// 编排：本脚本自起 console-serving Python 启动器（tests/helpers/serve_console.py，
//   真 EchoPipeline + 假翻译发桩 subtitle/translation(ok)/tts_ready + 假 streams/uplink），
//   驱 chromium 打开 http://127.0.0.1:PORT/console @1440x900，逐项断言后必杀、还端口。
//
// Node 模块解析：本 worktree 位于主 checkout 目录内（OneLive\.worktrees\v2-m3b\engine\e2e），
//   Node ESM 从脚本目录逐级向上查 node_modules，天然命中主 checkout 的 OneLive\node_modules
//   （含 @playwright/test），故无需 npm install，从 repo 内跑 `node engine/e2e/console_e2e.mjs` 即可。
//
// 断言（全部真实链路，唯一桩是"数据源"）：
//   1. 频道 0 预览 canvas 帧在推进（采样中心像素两次、非黑且发生变化）；
//   2. 字幕面板含发出的真实字幕串（SUBTITLE_PROBE）；
//   3. casting：选底图 → 点"切换" → ack.ok 出现（ok 态、ok=true）；
//   4. HUD 链路RTT(ws) 有值且未 stale/置灰（启动器喂新鲜 uplink）；
//   5. 推流徽标：假 streams 块 → "推流中"（running）。
//
// 产物：engine/out/console_e2e/ 下截图 + summary.json。自断言：失败退出码 1、
//   前置不满足（启动器起不来）退出码 2。

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(here, "..");                 // engine/
const PORT = Number(process.env.E2E_PORT || 8920);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOT_DIR = process.env.E2E_SHOT_DIR || path.resolve(ENGINE, "out", "console_e2e");
const SUBTITLE_PROBE = "OneLive-E2E-字幕探针";           // 与 serve_console.py 唯一出处对齐
const PY = process.env.E2E_PY ||
  "C:/Users/76475/Documents/OneLive/.worktrees/v2-m0-spike/engine/.venv/Scripts/python.exe";

fs.mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.error(`[assert] ${pass ? "PASS" : "FAIL"} — ${name}${detail ? ` :: ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 起 Python 启动器 ----
console.error(`[e2e] spawning launcher: ${PY} tests/helpers/serve_console.py --port ${PORT}`);
const svc = spawn(PY, ["tests/helpers/serve_console.py", "--port", String(PORT)], {
  cwd: ENGINE,
  env: { ...process.env, PYTHONPATH: ENGINE },
  stdio: ["ignore", "pipe", "pipe"],
});
const svcLog = fs.createWriteStream(path.join(SHOT_DIR, "launcher.log"));
svc.stdout.pipe(svcLog);
svc.stderr.pipe(svcLog);
let svcExited = false;
svc.on("exit", (code) => { svcExited = true; console.error(`[e2e] launcher exited code=${code}`); });

async function killLauncher() {
  if (svcExited || svc.pid == null) return;
  try {
    // Windows：taskkill 整棵进程树（uvicorn reloader/子线程都收），确保端口归还
    spawn("taskkill", ["/F", "/T", "/PID", String(svc.pid)], { stdio: "ignore" });
  } catch (_) { /* 尽力而为 */ }
  await sleep(1500);
}

// ---- 等 /status 可达 ----
async function waitReady(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (svcExited) throw new Error("launcher exited before serving");
    try {
      const r = await fetch(`${BASE}/status`);
      if (r.ok) { const s = await r.json(); if (s.engine === "ok") return s; }
    } catch (_) { /* 未起 */ }
    await sleep(500);
  }
  throw new Error(`launcher not ready within ${timeoutMs}ms`);
}

let browser = null;
let exitCode = 0;
try {
  await waitReady(30000);
  console.error("[e2e] launcher serving; launching chromium @1440x900");

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.error(`[page-console] ${m.text()}`); });
  await page.goto(`${BASE}/console`, { waitUntil: "domcontentloaded" });

  // 首个 /status 后建卡：等频道 0 卡（含 canvas）出现
  await page.waitForSelector(".card canvas", { timeout: 10000 });
  // 让 /out 预览、/events、HUD 都跑几拍
  await sleep(4000);

  // ---- 断言 1：预览 canvas 帧推进 ----
  // 采样频道 0 卡的 canvas 中心像素两次（间隔 ~1.2s），非黑 + 两次不同 → 帧在推进。
  async function sampleCanvas() {
    return await page.evaluate(() => {
      const c = document.querySelector(".card canvas");
      if (!c || !c.width || !c.height) return null;
      const px = c.getContext("2d").getImageData(
        Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
      return { w: c.width, h: c.height, rgb: [px[0], px[1], px[2]] };
    });
  }
  const s1 = await sampleCanvas();
  await sleep(1200);
  const s2 = await sampleCanvas();
  {
    const ok = s1 && s2 && s1.w > 0 && s1.h > 0
      && (s1.rgb[0] + s1.rgb[1] + s1.rgb[2]) > 0            // 非黑
      && JSON.stringify(s1.rgb) !== JSON.stringify(s2.rgb); // 帧间像素变化
    record("1. 频道0预览 canvas 帧推进（非黑且逐帧变化）", ok,
      `size=${s1?.w}x${s1?.h} px1=${s1?.rgb} px2=${s2?.rgb}`);
  }

  // ---- 断言 2：字幕面板含真实字幕串 ----
  {
    const logText = await page.evaluate(() => document.getElementById("log").textContent);
    const ok = logText.includes(SUBTITLE_PROBE); // logText 回到 Node 作用域再比对
    record("2. 字幕面板含发出的真实字幕串", ok,
      `probe="${SUBTITLE_PROBE}" present=${ok}`);
  }

  // ---- 断言 3：casting 选底图 → 切换 → ack ok ----
  {
    // 下拉由 /avatars 填充：选第一个真实底图（value 非空），点"切换"，等 ack.ok
    const picked = await page.evaluate(() => {
      const sel = document.querySelector(".card select");
      const opt = Array.from(sel.options).find((o) => o.value);
      if (!opt) return null;
      sel.value = opt.value;
      sel.dispatchEvent(new Event("change"));
      return opt.value;
    });
    let ackText = "", ackCls = "";
    if (picked) {
      await page.click(".card .cast button");
      try {
        await page.waitForFunction(() => {
          const a = document.querySelector(".card .ack");
          return a && a.className.includes("ack ok");
        }, { timeout: 15000 });
      } catch (_) { /* 超时下方 record 会判 FAIL */ }
      const ack = await page.evaluate(() => {
        const a = document.querySelector(".card .ack");
        return { text: a.textContent, cls: a.className };
      });
      ackText = ack.text; ackCls = ack.cls;
    }
    const ok = !!picked && ackCls.includes("ack ok") && ackText.includes("✓");
    record("3. casting 选底图→切换→ack ok=true", ok,
      `source=${picked} ack="${ackText}" cls="${ackCls}"`);
  }

  // ---- 断言 4：HUD 链路RTT(ws) 有值且未 stale/置灰 ----
  {
    const rtt = await page.evaluate(() => {
      // 频道 0 的 HUD 块：找含"频道 0"的 .hblk（非 unconf 占位）
      const blk = Array.from(document.querySelectorAll("#hud .hblk"))
        .find((b) => !b.className.includes("unconf")
          && /频道\s*0\b/.test(b.querySelector(".cid")?.textContent || ""));
      if (!blk) return { found: false };
      const stale = blk.className.includes("staleblk");
      const staleBadge = blk.querySelector(".htop .stale")?.textContent?.trim();
      // 链路RTT(ws) 行：.m.wide 的 .k 文本匹配
      let rttVal = null, rttDim = false;
      for (const m of blk.querySelectorAll(".m.wide")) {
        if ((m.querySelector(".k")?.textContent || "").includes("链路RTT(ws)")) {
          const v = m.querySelector(".v");
          rttVal = v?.textContent?.trim();
          rttDim = (v?.className || "").includes("dim");
        }
      }
      return { found: true, stale, staleBadge, rttVal, rttDim };
    });
    const ok = rtt.found && rtt.rttVal && rtt.rttVal.includes("ms")
      && rtt.rttVal !== "-" && !rtt.stale && !rtt.rttDim && rtt.staleBadge === "FRESH";
    record("4. HUD 链路RTT(ws) 有值且未 stale/置灰", ok,
      `rtt="${rtt.rttVal}" stale=${rtt.stale} badge=${rtt.staleBadge} dim=${rtt.rttDim}`);
  }

  // ---- 断言 5：推流徽标 running（假 streams 块）----
  {
    const badge = await page.evaluate(() => {
      const b = document.querySelector(".card .badge.stream");
      return { text: b?.textContent?.trim(), cls: b?.className };
    });
    const ok = badge.text?.includes("推流中") && (badge.cls || "").includes("live");
    record("5. 推流徽标 running（假 streams → 推流中）", ok,
      `badge="${badge.text}" cls="${badge.cls}"`);
  }

  // ---- 证据截图 ----
  const shotFull = path.join(SHOT_DIR, "console_full.png");
  const shotCard = path.join(SHOT_DIR, "channel_card.png");
  const shotHud = path.join(SHOT_DIR, "hud_uplink.png");
  await page.screenshot({ path: shotFull, fullPage: false });
  await page.locator(".card").first().screenshot({ path: shotCard });
  await page.locator("#hud").screenshot({ path: shotHud });
  console.error(`[e2e] screenshots → ${SHOT_DIR}`);

  const finalStatus = await (await fetch(`${BASE}/status`)).json();
  const passed = results.filter((r) => r.pass).length;
  const summary = {
    base: BASE, viewport: "1440x900", ts: new Date().toISOString(),
    subtitle_probe: SUBTITLE_PROBE,
    assertions: results, passed, total: results.length,
    result: passed === results.length ? "PASS" : "FAIL",
    screenshots: { full: shotFull, card: shotCard, hud: shotHud },
    final_status: finalStatus,
  };
  fs.writeFileSync(path.join(SHOT_DIR, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  exitCode = summary.result === "PASS" ? 0 : 1;
  console.error(`[e2e] ${summary.result} — ${passed}/${results.length} assertions`);
} catch (e) {
  console.error(`[e2e] ERROR: ${e?.stack ?? e}`);
  exitCode = exitCode || 2;
} finally {
  if (browser) await browser.close().catch(() => {});
  await killLauncher();
}
process.exit(exitCode);
