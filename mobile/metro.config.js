// Metro 配置：把 .html 当作静态资源打包（capture-native.html 作为 WebView source）。
// 默认 Expo 配置 + assetExts 追加 "html"，其余保持默认。
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push("html");

module.exports = config;
