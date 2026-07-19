// uplink_stats 上报体构造，镜像 capture.html 的 reportUplinkStats：
// 用累计计数与上一窗口基线的差值算窗口 fps_sent/skipped，返回帧 + 推进后的基线。
import { buildUplinkStats } from "./uplinkStats";

describe("buildUplinkStats window math (mirrors capture.html)", () => {
  it("computes window fps/skipped from cumulative counters minus baselines", () => {
    const r = buildUplinkStats({
      channel: 0,
      sent: 25,
      skipped: 3,
      winBaseSent: 5,
      winBaseSkipped: 1,
      intervalS: 2,
      lastRtt: 12.5,
    });
    expect(r.frame.type).toBe("uplink_stats");
    expect(r.frame.channel).toBe(0);
    expect(r.frame.fps_sent).toBe(10); // (25-5)/2
    expect(r.frame.skipped).toBe(2); // 3-1
    expect(r.frame.rtt_ms).toBe(12.5);
    expect(r.fpsSent).toBe(10);
    // 基线推进到当前累计值
    expect(r.winBaseSent).toBe(25);
    expect(r.winBaseSkipped).toBe(3);
  });

  it("passes lastRtt null through and preserves a non-zero channel", () => {
    const r = buildUplinkStats({
      channel: 7,
      sent: 10,
      skipped: 0,
      winBaseSent: 0,
      winBaseSkipped: 0,
      intervalS: 2,
      lastRtt: null,
    });
    expect(r.frame.channel).toBe(7);
    expect(r.frame.rtt_ms).toBeNull();
    expect(r.frame.fps_sent).toBe(5);
    expect(r.frame.skipped).toBe(0);
  });
});
