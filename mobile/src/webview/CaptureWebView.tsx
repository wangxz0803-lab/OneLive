// 隐藏 WebView 承载 capture-native.html：设备热路径复用已验证的 byte-exact 上行管线。
// 原生只做粘合：注入 __ONELIVE 配置、申请相机权限、AppState 生命周期驱动 start/stop、
// 把 WebView 上桥的 hud/state 消息回调给父屏。相机取帧本身在 WKWebView 内（需真机验证）。
import { useEffect, useRef } from "react";
import { AppState, Image, StyleSheet, View } from "react-native";
import WebView, { type WebViewMessageEvent } from "react-native-webview";
import { Camera } from "expo-camera";
import { type Endpoint } from "../net/endpoint";

// capture-native.html 作为 metro 资源（metro.config.js 已把 .html 加入 assetExts）。
// require 经 @types/node 返回 any，无需额外模块声明；用核心 RN 解析出可加载的 uri。
const CAPTURE_HTML = require("../../assets/capture-native.html");

// WebView 上桥的消息形状（见 capture-native.html 的三处编辑）。
export interface HudMessage {
  fps: number;
  rtt: number | null;
  running: boolean;
}

export interface CaptureWebViewProps {
  endpoint: Endpoint;
  channel?: number;
  fps?: number;
  onHud?: (hud: HudMessage) => void;
  onState?: (ws: string) => void;
}

export function CaptureWebView({
  endpoint,
  channel = 0,
  fps = 10,
  onHud,
  onState,
}: CaptureWebViewProps) {
  const ref = useRef<WebView>(null);

  // 挂载即申请相机权限（WKWebView getUserMedia 依赖系统授权 + NSCameraUsageDescription）。
  useEffect(() => {
    Camera.requestCameraPermissionsAsync().catch(() => {
      /* 用户拒绝/无相机：页面内 getUserMedia 会报 camera error，HUD 停在 idle */
    });
  }, []);

  // AppState 生命周期：切后台停采集（省电/合规），回前台恢复。
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      const js =
        state === "active"
          ? "window.__start && window.__start(); true;"
          : "window.__stop && window.__stop(); true;";
      ref.current?.injectJavaScript(js);
    });
    return () => sub.remove();
  }, []);

  // 注入配置：host 为 "ip:port"，scheme 固定 ws（局域网明文），load 时 autostart。
  const cfg = {
    host: `${endpoint.host}:${endpoint.port}`,
    scheme: "ws",
    channel,
    fps,
    autostart: true,
  };
  const beforeLoad = `window.__ONELIVE = ${JSON.stringify(cfg)}; true;`;

  function handleMessage(ev: WebViewMessageEvent) {
    let m: unknown;
    try {
      m = JSON.parse(ev.nativeEvent.data);
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    const msg = m as { type?: string; fps?: number; rtt?: number | null; running?: boolean; ws?: string };
    if (msg.type === "hud") {
      onHud?.({
        fps: typeof msg.fps === "number" ? msg.fps : 0,
        rtt: typeof msg.rtt === "number" ? msg.rtt : null,
        running: msg.running === true,
      });
    } else if (msg.type === "state" && typeof msg.ws === "string") {
      onState?.(msg.ws);
    }
  }

  return (
    // 隐藏承载：1x1 + opacity 0，不上屏（画面本就不需要在手机端预览）。
    <View style={styles.hidden} pointerEvents="none">
      <WebView
        ref={ref}
        source={{ uri: Image.resolveAssetSource(CAPTURE_HTML).uri }}
        originWhitelist={["*"]}
        injectedJavaScriptBeforeContentLoaded={beforeLoad}
        onMessage={handleMessage}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        mediaCapturePermissionGrantType="grant"
        javaScriptEnabled
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: {
    width: 1,
    height: 1,
    opacity: 0,
    position: "absolute",
  },
});
