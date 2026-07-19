// IPv4:port 校验 + /ingest URL 构造。
import { parseEndpoint, ingestUrl } from "./endpoint";

describe("parseEndpoint", () => {
  it("accepts a valid IPv4 and explicit port", () => {
    expect(parseEndpoint("192.168.1.42", "8930")).toEqual({
      host: "192.168.1.42",
      port: 8930,
    });
  });

  it("defaults empty port to 8900", () => {
    expect(parseEndpoint("10.0.0.1", "")).toEqual({ host: "10.0.0.1", port: 8900 });
  });

  it("rejects an out-of-range octet", () => {
    expect(() => parseEndpoint("999.1.1.1", "8900")).toThrow(
      "invalid IPv4 address: 999.1.1.1"
    );
  });

  it("rejects a too-short address", () => {
    expect(() => parseEndpoint("192.168.1", "8900")).toThrow(
      "invalid IPv4 address: 192.168.1"
    );
  });

  it("rejects an out-of-range port", () => {
    expect(() => parseEndpoint("127.0.0.1", "70000")).toThrow("invalid port: 70000");
  });

  it("rejects a non-numeric / zero port", () => {
    expect(() => parseEndpoint("127.0.0.1", "abc")).toThrow("invalid port: abc");
    expect(() => parseEndpoint("127.0.0.1", "0")).toThrow("invalid port: 0");
  });
});

describe("ingestUrl", () => {
  it("builds a ws:// url when tls is false", () => {
    expect(ingestUrl({ host: "127.0.0.1", port: 8900 }, false)).toBe(
      "ws://127.0.0.1:8900/ingest"
    );
  });

  it("builds a wss:// url when tls is true", () => {
    expect(ingestUrl({ host: "10.0.0.5", port: 443 }, true)).toBe(
      "wss://10.0.0.5:443/ingest"
    );
  });
});
