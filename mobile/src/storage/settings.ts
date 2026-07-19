// 端点（PC 局域网 IP:port）持久化：AsyncStorage 单键存 JSON。
// host 为空字符串 = 从未设置（首屏进设置页）；port 默认 "8900"。
// 坏 JSON / 缺字段一律回落到默认，绝不因存储脏数据卡死开播流程。
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "onelive.endpoint";

// 注意：这里存的是「原始输入串」（host/port 都是 string），校验交给 parseEndpoint。
// 存串而非解析后的 Endpoint，是为了让设置页能原样回显用户上次输入。
export interface StoredEndpoint {
  host: string;
  port: string;
}

const DEFAULT: StoredEndpoint = { host: "", port: "8900" };

export async function loadEndpoint(): Promise<StoredEndpoint> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(KEY);
  } catch {
    return { ...DEFAULT };
  }
  if (raw == null) return { ...DEFAULT };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as StoredEndpoint).host === "string" &&
      typeof (parsed as StoredEndpoint).port === "string"
    ) {
      return {
        host: (parsed as StoredEndpoint).host,
        port: (parsed as StoredEndpoint).port,
      };
    }
    return { ...DEFAULT };
  } catch {
    // 坏 JSON → 默认，不抛
    return { ...DEFAULT };
  }
}

export async function saveEndpoint(e: StoredEndpoint): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify({ host: e.host, port: e.port }));
}
