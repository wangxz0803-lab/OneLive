// uplink_stats 控制帧构造，镜像 engine/service/capture.html 的 reportUplinkStats。
// 服务端（app.py /ingest）落 fps_sent/skipped/rtt_ms 到 UplinkStore，/status 汇总。
// channel 必须是真 int：服务端对非 int/bool 的 channel 会拒收（见 app.py 守卫）。
// rtt_ms 是 WS 链路 RTT（ping/pong 测），不是蜂窝上行 RTT——如实标注。

export interface UplinkStatsFrame {
  type: "uplink_stats";
  channel: number;
  fps_sent: number;
  skipped: number;
  rtt_ms: number | null;
}

export interface BuildUplinkStatsInput {
  channel: number;
  sent: number;
  skipped: number;
  winBaseSent: number;
  winBaseSkipped: number;
  intervalS: number;
  lastRtt: number | null;
}

export interface UplinkStatsResult {
  frame: UplinkStatsFrame;
  fpsSent: number;
  winBaseSent: number;
  winBaseSkipped: number;
}

export function buildUplinkStats(input: BuildUplinkStatsInput): UplinkStatsResult {
  const { channel, sent, skipped, winBaseSent, winBaseSkipped, intervalS, lastRtt } =
    input;
  const fpsSent = (sent - winBaseSent) / intervalS;
  const winSkipped = skipped - winBaseSkipped;
  return {
    frame: {
      type: "uplink_stats",
      channel,
      fps_sent: fpsSent,
      skipped: winSkipped,
      rtt_ms: lastRtt,
    },
    fpsSent,
    winBaseSent: sent, // 推进基线到当前累计值，下一窗口从此起算
    winBaseSkipped: skipped,
  };
}
