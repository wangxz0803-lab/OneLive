// 直播页（Task 8 版）：显示端点 + HUD + 「停播」。
// Task 9 会在此挂载隐藏 WebView 采集相机并把真实 hud/state 喂进来。
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Hud } from "../components/Hud";
import { ingestUrl, type Endpoint } from "../net/endpoint";

export interface LiveScreenProps {
  endpoint: Endpoint;
  onStop: () => void;
}

export function LiveScreen({ endpoint, onStop }: LiveScreenProps) {
  const url = ingestUrl(endpoint, false);
  return (
    <View style={styles.container}>
      <Text style={styles.title}>直播中</Text>
      <Text style={styles.url}>{url}</Text>

      <Hud fpsSent={0} rttMs={null} state="idle" />

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
