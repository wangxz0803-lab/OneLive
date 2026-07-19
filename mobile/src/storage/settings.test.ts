// 端点持久化：默认值 / 往返 / 坏 JSON 回落。mock AsyncStorage 为内存实现。
import { loadEndpoint, saveEndpoint } from "./settings";
import AsyncStorage from "@react-native-async-storage/async-storage";

jest.mock("@react-native-async-storage/async-storage", () => {
  let store: Record<string, string> = {};
  return {
    getItem: jest.fn(async (k: string) => (k in store ? store[k] : null)),
    setItem: jest.fn(async (k: string, v: string) => {
      store[k] = v;
    }),
    // 测试专用：直接塞脏值
    __seed: (k: string, v: string) => {
      store[k] = v;
    },
    __reset: () => {
      store = {};
    },
  };
});

const mockStorage = AsyncStorage as unknown as {
  __seed: (k: string, v: string) => void;
  __reset: () => void;
};

beforeEach(() => {
  mockStorage.__reset();
  jest.clearAllMocks();
});

describe("loadEndpoint", () => {
  it("returns default when storage is empty", async () => {
    expect(await loadEndpoint()).toEqual({ host: "", port: "8900" });
  });

  it("round-trips a saved endpoint", async () => {
    await saveEndpoint({ host: "192.168.1.42", port: "8930" });
    expect(await loadEndpoint()).toEqual({ host: "192.168.1.42", port: "8930" });
  });

  it("falls back to default on corrupt JSON", async () => {
    mockStorage.__seed("onelive.endpoint", "{not valid json");
    expect(await loadEndpoint()).toEqual({ host: "", port: "8900" });
  });

  it("falls back to default on wrong-shape JSON", async () => {
    mockStorage.__seed("onelive.endpoint", JSON.stringify({ host: 5, port: null }));
    expect(await loadEndpoint()).toEqual({ host: "", port: "8900" });
  });
});
