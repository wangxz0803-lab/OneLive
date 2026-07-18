// OneLive M3a 自建 RTMP 收流端（node-media-server v2）。
//
// 职责：收 engine 侧每信道 ffmpeg 推来的 RTMP（rtmp://127.0.0.1:1935/live/chN），
// 同时以 HTTP-FLV 播出（http://127.0.0.1:8000/live/chN.flv）供 ffprobe/拉流
// 验证与浏览器播放器（flv.js 等）消费。纯本地验证用，无鉴权。
//
// 已知行为（E2E 需知）：publisher 非正常断开（进程被杀）时 NMS 的会话要等
// TCP 超时才清掉——期间同路径 re-publish 会被 "Already has a stream" 拒绝
// （ghost session）。E2E 的恢复断言按此留了重试窗口。
import NodeMediaServer from "node-media-server";

const config = {
  logType: 2, // 0=none 1=error 2=normal 3=debug —— 事件走 console，E2E 全程留档
  rtmp: {
    port: 1935,
    chunk_size: 60000,
    gop_cache: true, // 新拉流端立即拿到上一个 GOP，ffprobe 探测不用干等关键帧
    ping: 30,
    ping_timeout: 60,
  },
  http: {
    port: 8000,
    allow_origin: "*",
    mediaroot: "./media", // v2 必填字段；本 sink 不落盘（无 trans/record 任务）
  },
};

const nms = new NodeMediaServer(config);

// 关键会话事件全部打点到 console（时间戳 + 事件 + 流路径），E2E 拿 sink 日志作证
for (const ev of [
  "preConnect", "postConnect", "doneConnect",
  "prePublish", "postPublish", "donePublish",
  "prePlay", "postPlay", "donePlay",
]) {
  nms.on(ev, (id, streamPath, args) => {
    console.log(`[sink ${new Date().toISOString()}] ${ev} id=${id} path=${streamPath ?? ""} args=${JSON.stringify(args ?? {})}`);
  });
}

nms.run();
console.log(`[sink ${new Date().toISOString()}] node-media-server up: rtmp://127.0.0.1:1935/live/chN  <->  http://127.0.0.1:8000/live/chN.flv`);
