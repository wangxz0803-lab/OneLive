// 应用外壳：两屏切换。endpoint === null → SettingsScreen（输入 IP:port），
// 否则 LiveScreen（开播上行）。深色底 + SafeAreaView + 状态栏浅色文字。
import { useEffect, useState } from "react";
import { SafeAreaView, StyleSheet } from "react-native";
import { StatusBar } from "expo-status-bar";
import { parseEndpoint, type Endpoint } from "./src/net/endpoint";
import { loadEndpoint, saveEndpoint } from "./src/storage/settings";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { LiveScreen } from "./src/screens/LiveScreen";

export default function App() {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("8900");
  // null = 未开播（显示设置页）；非 null = 已解析端点（显示直播页）。
  const [endpoint, setEndpoint] = useState<Endpoint | null>(null);

  // 启动时回填上次输入（仅回填输入框，保持在设置页等用户点开播）。
  useEffect(() => {
    let alive = true;
    loadEndpoint().then((e) => {
      if (!alive) return;
      setHost(e.host);
      setPort(e.port);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 校验（非法抛错，交 SettingsScreen 显红）→ 持久化 → 进入直播页。
  async function goLive() {
    const parsed = parseEndpoint(host, port);
    await saveEndpoint({ host, port });
    setEndpoint(parsed);
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      {endpoint === null ? (
        <SettingsScreen
          host={host}
          port={port}
          setHost={setHost}
          setPort={setPort}
          onGoLive={goLive}
        />
      ) : (
        <LiveScreen endpoint={endpoint} onStop={() => setEndpoint(null)} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
});
