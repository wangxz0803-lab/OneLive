"""ffmpeg 拉流端点：/stream.mjpeg + /stream.wav（V2 M3b Task 1，从 app.py 拆出）。

路由注册模式：工厂函数 register_stream_endpoints(app, workers, mixers) 在
create_app 内被调用，@app.get 装饰的处理器闭包捕获传入的 workers/mixers
（而非 app.state）——与拆分前 create_app 内联闭包语义一致，处理器仍与
app 同一事件循环，订阅生存期严格等于生成器生存期。行为零变化。
"""

import asyncio

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import StreamingResponse

from service.wire import wav_stream_header


def register_stream_endpoints(app: FastAPI, workers: dict, mixers: dict) -> None:
    @app.get("/stream.mjpeg")
    async def stream_mjpeg(channel: int = Query(0)) -> StreamingResponse:
        # ffmpeg 拉流用的视频源（M3a）：multipart/x-mixed-replace，每部分一张
        # 渲染 JPEG。裸 JPEG 不带协议头——协议头版走 /out WS，此端点专为
        # `ffmpeg -f mjpeg -i http://…` 这类标准 HTTP 消费方。
        worker = workers.get(channel)
        if worker is None:
            raise HTTPException(status_code=404, detail=f"unknown channel: {channel}")

        async def frames():
            # 订阅在生成器首次迭代时才建立（而非请求处理器里）：客户端在
            # 响应体开始前就断开时生成器根本不会启动，也就无需清理——
            # 订阅的生存期严格等于生成器的生存期。断开/服务停止由
            # StreamingResponse 取消本生成器：CancelledError 落在
            # queue.get()，finally 保证退订（/out 僵尸订阅者的教训）。
            loop = asyncio.get_running_loop()
            queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=4)

            def on_frame(seq: int, ts_ms: int, jpeg: bytes) -> None:  # worker 线程 → 事件循环
                def _put() -> None:
                    if queue.full():
                        queue.get_nowait()  # 订阅端 latest-wins 丢最旧，同 /out
                    queue.put_nowait(jpeg)

                loop.call_soon_threadsafe(_put)

            unsubscribe = worker.subscribe(on_frame)
            try:
                while True:
                    jpeg = await queue.get()
                    yield (b"--frame\r\n"
                           b"Content-Type: image/jpeg\r\n"
                           b"Content-Length: " + str(len(jpeg)).encode("ascii")
                           + b"\r\n\r\n" + jpeg + b"\r\n")
            finally:
                unsubscribe()

        return StreamingResponse(
            frames(), media_type="multipart/x-mixed-replace; boundary=frame")

    @app.get("/stream.wav")
    async def stream_wav(channel: int = Query(0)) -> StreamingResponse:
        # ffmpeg 拉流用的音频源（M3a）：44 字节无限流 WAV 头 + AudioMixer
        # 实时 pcm16 块流（静音打底 + TTS 语音，见 audio_mixer.py）。
        # None 哨兵 = mixer 已停（lifespan shutdown），正常终结响应。
        mixer = mixers.get(channel)
        if mixer is None:
            raise HTTPException(status_code=404, detail=f"unknown channel: {channel}")

        async def track():
            # 订阅同样只活在生成器内（动机见 stream_mjpeg）；mixer 与本
            # 生成器同一事件循环，subscribe/退订无需线程桥。
            queue, unsubscribe = mixer.subscribe()
            try:
                yield wav_stream_header(mixer.sr)
                while True:
                    chunk = await queue.get()
                    if chunk is None:
                        return  # mixer 停了：让响应正常收尾而非挂死
                    yield chunk
            finally:
                unsubscribe()

        return StreamingResponse(track(), media_type="audio/wav")
