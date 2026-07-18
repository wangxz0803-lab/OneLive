"""订阅端点共享的 WebSocket 竞速循环（V2 M3b Task 1，从 app.py 拆出）。

/out /events /speech 三处订阅端点同一模式：queue.get() 与 ws.receive()
二选一竞速。放在独立模块而非 wire.py，因为这是 WS 控制流辅助（含取消
安全的 finally），与无状态 wire 格式函数职责不同。app.py（/out）与
endpoints_translate.py（/events /speech）都从这里导入。
"""

import asyncio
import logging
from typing import Callable

from fastapi import WebSocket, WebSocketDisconnect

log = logging.getLogger("engine.service")


async def ws_subscriber_loop(ws: WebSocket, queue: asyncio.Queue,
                             send, unsubscribe: Callable[[], None],
                             tag: str) -> None:
    """订阅端点共享的竞速循环（/out /events /speech 同一模式，第三处出现时
    按三振规则抽取）。queue.get() 与 ws.receive() 二选一竞速：只 await queue
    永远感知不到无数据流动时的客户端断开（M1a E2E 僵尸订阅者 bug），哪边先
    完成处理哪边，各自完成后各自重新武装——任意时刻每种任务最多一个。

    send: async callable，把一个队列项发给客户端（send_bytes / send_text+json）。
    unsubscribe: 同步零 await 的清理回调，finally 里最先执行。清理必须全同步：
    外部取消（TestClient 退出时 portal cancel）会在 finally 的任意 await 点
    重投 CancelledError，之前版本在此 await gather 偶发（~2%）拦腰打断 finally。
    两个竞速任务只 cancel 不 await（绑在本循环上，取消后由循环回收），
    done_callback 兜底取回可能已挂上的异常，避免 never-retrieved 告警。"""
    queue_task: asyncio.Task = asyncio.ensure_future(queue.get())
    recv_task: asyncio.Task = asyncio.ensure_future(ws.receive())
    try:
        while True:
            done, _ = await asyncio.wait({queue_task, recv_task},
                                         return_when=asyncio.FIRST_COMPLETED)
            if recv_task in done:
                msg = recv_task.result()  # ws.receive() 把断开作为消息返回
                if msg["type"] == "websocket.disconnect":
                    # 若此刻 queue_task 恰好也完成了，那一项随取消丢弃——
                    # 客户端都断开了，为它保数据毫无意义，明确接受这个取舍。
                    break
                log.warning("%s: unexpected client message ignored: %r", tag, msg)
                recv_task = asyncio.ensure_future(ws.receive())
            if queue_task in done:
                await send(queue_task.result())
                queue_task = asyncio.ensure_future(queue.get())
    except WebSocketDisconnect:
        pass
    finally:
        unsubscribe()
        for task in (queue_task, recv_task):
            task.cancel()
            task.add_done_callback(
                lambda t: None if t.cancelled() else t.exception())
