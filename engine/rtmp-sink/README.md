# rtmp-sink — 自建 RTMP 收流端（M3a）

[node-media-server](https://github.com/illuspas/Node-Media-Server) v2 最小配置：

- **RTMP 收流**：`rtmp://127.0.0.1:1935/live/chN`（engine 侧 `--rtmp rtmp://127.0.0.1:1935/live/ch{ch}` 推来）
- **HTTP-FLV 播出**：`http://127.0.0.1:8000/live/chN.flv`（ffprobe / ffmpeg / flv.js 均可拉）

## 启动

```
cd engine/rtmp-sink
npm install
node server.mjs
```

依赖锁在 `package-lock.json`（入库）；`node_modules/` 不入库。纯本地验证用，无鉴权、无落盘。

## 快速验证

```
ffmpeg -re -f lavfi -i testsrc=size=512x512:rate=15 -f lavfi -i sine=frequency=440:sample_rate=16000 \
       -c:v libx264 -preset veryfast -c:a aac -t 3 -f flv rtmp://127.0.0.1:1935/live/ch0
# 推流进行中另开终端：
ffprobe -v error -show_streams http://127.0.0.1:8000/live/ch0.flv
```

## 已知行为

- **ghost session**：publisher 进程被杀（非正常 RTMP 断开）时，NMS 的旧会话要等 TCP 超时才清掉，期间同路径 re-publish 被 `Already has a stream` 拒绝。engine 侧监督器的退避重试天然覆盖这个窗口；E2E（`engine/e2e/rtmp_e2e.py`）的恢复断言也按此留了 60s 重试窗口。
- 端口 1935/8000 写死在 `server.mjs`，与 `StreamerManager` 默认模板/E2E 保持一致；要改两边一起改。
