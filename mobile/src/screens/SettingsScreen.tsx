// 首屏设置：输入 PC 局域网 IP + 端口 → 一个大「开播」按钮。
// 输入非法时 onGoLive（内部走 parseEndpoint）抛错，本屏捕获后显红字。
import { useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

export interface SettingsScreenProps {
  host: string;
  port: string;
  setHost: (v: string) => void;
  setPort: (v: string) => void;
  // 可能同步抛（parseEndpoint 非法输入）或异步 reject（保存失败）；本屏统一捕获显红。
  onGoLive: () => void | Promise<void>;
}

export function SettingsScreen({
  host,
  port,
  setHost,
  setPort,
  onGoLive,
}: SettingsScreenProps) {
  const [error, setError] = useState<string | null>(null);

  async function handleGoLive() {
    setError(null);
    try {
      await onGoLive();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>OneLive</Text>
      <Text style={styles.subtitle}>输入电脑（PC）局域网地址，开始上行直播画面</Text>

      <Text style={styles.label}>PC IP 地址</Text>
      <TextInput
        style={styles.input}
        value={host}
        onChangeText={setHost}
        placeholder="192.168.1.42"
        placeholderTextColor="#666"
        keyboardType="numbers-and-punctuation"
        autoCapitalize="none"
        autoCorrect={false}
        inputMode="decimal"
      />

      <Text style={styles.label}>端口</Text>
      <TextInput
        style={styles.input}
        value={port}
        onChangeText={setPort}
        placeholder="8900"
        placeholderTextColor="#666"
        keyboardType="number-pad"
        inputMode="numeric"
      />

      {error != null && <Text style={styles.error}>{error}</Text>}

      <Pressable
        style={({ pressed }) => [styles.goLive, pressed && styles.goLivePressed]}
        onPress={handleGoLive}
      >
        <Text style={styles.goLiveText}>开播</Text>
      </Pressable>

      {/* 诚实占位：扫码填 IP 尚未实现，本里程碑仍需手动输入。 */}
      <Text style={styles.todo}>TODO：扫码填 IP 未实现，暂请手动输入</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 24,
    justifyContent: "center",
  },
  title: {
    color: "#fff",
    fontSize: 34,
    fontWeight: "700",
    marginBottom: 4,
  },
  subtitle: {
    color: "#aaa",
    fontSize: 14,
    marginBottom: 32,
  },
  label: {
    color: "#ccc",
    fontSize: 13,
    marginBottom: 6,
    marginTop: 16,
  },
  input: {
    backgroundColor: "#1c1c1e",
    borderWidth: 1,
    borderColor: "#333",
    borderRadius: 10,
    color: "#fff",
    fontSize: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  error: {
    color: "#ef5350",
    fontSize: 14,
    marginTop: 16,
  },
  goLive: {
    backgroundColor: "#e5322d",
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: "center",
    marginTop: 32,
  },
  goLivePressed: {
    opacity: 0.7,
  },
  goLiveText: {
    color: "#fff",
    fontSize: 22,
    fontWeight: "700",
  },
  todo: {
    color: "#777",
    fontSize: 12,
    marginTop: 20,
    textAlign: "center",
  },
});
