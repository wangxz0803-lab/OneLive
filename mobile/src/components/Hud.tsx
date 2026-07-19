// 诚实上行 HUD：fps_sent + 链路RTT(ws) + 连接态色标。
// RTT 明确标注为 WS 传输层往返（链路RTT(ws)），不是蜂窝/RAN 上行 RTT——
// loopback 下 ~0ms，语义与 capture.html 完全一致。
import { StyleSheet, Text, View } from "react-native";
import type { UplinkState } from "../net/uplinkClient";

export interface HudProps {
  fpsSent: number;
  rttMs: number | null;
  state: UplinkState;
}

// 连接态 → 中文标签 + 颜色。idle/closed 灰、connecting 黄、connected 绿、error 红。
const STATE_META: Record<UplinkState, { label: string; color: string }> = {
  idle: { label: "空闲", color: "#888" },
  connecting: { label: "连接中", color: "#e6b800" },
  connected: { label: "已连接", color: "#4caf50" },
  error: { label: "错误", color: "#ef5350" },
  closed: { label: "已断开", color: "#888" },
};

export function Hud({ fpsSent, rttMs, state }: HudProps) {
  const meta = STATE_META[state];
  const rttText = rttMs == null ? "-" : String(Math.round(rttMs));
  return (
    <View style={styles.container}>
      <Text style={styles.metrics}>
        上行 {fpsSent.toFixed(1)} fps · 链路RTT(ws) {rttText} ms
      </Text>
      <Text style={[styles.state, { color: meta.color }]}>● {meta.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: "#1c1c1e",
  },
  metrics: {
    color: "#6cf",
    fontSize: 13,
    fontFamily: "Courier",
  },
  state: {
    fontSize: 13,
    fontWeight: "600",
    marginLeft: 12,
  },
});
