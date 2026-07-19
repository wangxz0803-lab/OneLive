// PC 局域网 IP:port 校验与 /ingest WebSocket URL 构造。
// 只接受 IPv4（本里程碑手机直连局域网 PC，域名/IPv6 记为未来项）。

export interface Endpoint {
  host: string;
  port: number;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export const DEFAULT_PORT = 8900;

export function parseEndpoint(host: string, port: string): Endpoint {
  const m = IPV4_RE.exec(host);
  if (!m || m.slice(1).some((oct) => Number(oct) > 255)) {
    throw new Error(`invalid IPv4 address: ${host}`);
  }
  let portNum: number;
  if (port === "") {
    portNum = DEFAULT_PORT;
  } else {
    // 整数且 1..65535；非数字（NaN）/小数/越界都拒
    portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      throw new Error(`invalid port: ${port}`);
    }
  }
  return { host, port: portNum };
}

export function ingestUrl(endpoint: Endpoint, tls: boolean): string {
  const scheme = tls ? "wss" : "ws";
  return `${scheme}://${endpoint.host}:${endpoint.port}/ingest`;
}
