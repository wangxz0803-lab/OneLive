// 直播页：隐藏 WebView 采集相机上行 + 诚实 HUD（fps/链路RTT(ws)/连接态）+ 「停播」。
// hud/state 由 CaptureWebView 从页面上桥；停播回设置页。
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Hud } from "../components/Hud";
import { CaptureWebView } from "../webview/CaptureWebView";
import { ingestUrl, type Endpoint } from "../net/endpoint";
import { type UplinkState } from "../net/uplinkClient";

export interface LiveScreenProps {
  endpoint: Endpoint;
  onStop: () => void;
}

// capture-native.html 的 readyState 词 → HUD 连接态。页面不发 "error" 词，
// 故 error 态由 HUD 保留但此路径不触发（诚实：断连统一显"已断开"）。
function wsWordToState(ws: string): UplinkState {
  switch (ws) {
    case "connecting":
      return "connecting";
    case "connected":
      return "connected";
    case "closing":
    case "closed":
    case "no ws":
    default:
      return "closed";
  }
}

export function LiveScreen({ endpoint, onStop }: LiveScreenProps) {
  const url = ingestUrl(endpoint, false);
  const [fps, setFps] = useState(0);
  const [rtt, setRtt] = useState<number | null>(null);
  const [state, setState] = useState<UplinkState>("idle");

  return (
    <View style={styles.container}>
      <CaptureWebView
        endpoint={endpoint}
        onHud={(h) => {
          setFps(h.fps);
          setRtt(h.rtt);
        }}
        onState={(ws) => setState(wsWordToState(ws))}
      />

      <Text style={styles.title}>直播中</Text>
      <Text style={styles.url}>{url}</Text>

      <Hud fpsSent={fps} rttMs={rtt} state={state} />

      <Pressable
        style={({ pressed }) => [styles.stop, pressed && styles.stopPressed]}
        onPress={onStop}
      >
        <Text style={styles.stopText}>停播</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 24,
    justifyContent: "center",
    gap: 20,
  },
  title: {
    color: "#fff",
    fontSize: 28,
    fontWeight: "700",
  },
  url: {
    color: "#8f8",
    fontSize: 14,
    fontFamily: "Courier",
  },
  stop: {
    backgroundColor: "#333",
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: "center",
    marginTop: 12,
  },
  stopPressed: {
    opacity: 0.7,
  },
  stopText: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "700",
  },
});
