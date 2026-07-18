"""每信道 ffmpeg 推流进程监督器（V2 M3a Task 3）。

StreamerManager 为每个信道拉起一个 ffmpeg 子进程：从本服务的
/stream.mjpeg + /stream.wav 拉流（HTTP 长连接），转码
（libx264 zerolatency + aac）后以 flv 推 RTMP 地址模板
``rtmp_url_template.format(ch=N)``。

命令行与计划的偏差（经验修正，见 test_command_shape_*）：
``-use_wallclock_as_timestamps 1`` 是**输入侧** demuxer 选项
（decoding param），计划把它放在两个 -i 之后——那是输出位置，ffmpeg
会以 "you are trying to apply an input option to an output file" 直接
报错退出；实现改为在每个 ``-i`` 之前各放一份（对两路输入都生效）。
输入半区的真实可用性由 demuxer E2E（真 ffmpeg 拉真服务 3 秒）背书。

启停顺序（review carry-forward，app.py lifespan 与此对称）：
- 启动：ffmpeg 要拉的 /stream.* 端点在 uvicorn 开始 serving 后才可达，
  而 lifespan startup 完成于 serving **之前**——所以 start_all 由
  lifespan 起后台任务执行，先 ``await ready_probe()``（run_local 注入
  轮询 localhost /status 到 200 的探针）再 spawn ffmpeg；
- 停机：ffmpeg puller 就是 /stream.* 的长连接 HTTP 客户端。若先走
  服务收尾再停 manager，uvicorn 优雅停机等这些连接 drain、puller 只会
  继续拉，互相僵持——app lifespan shutdown 必须**最先** await
  stop_all()（puller 死 → 流式生成器随断连取消 → 之后的管线/混音器/
  worker 收尾畅通）。

监督：每信道一个 supervisor 任务——spawn → 等退出 → 记录 exit code +
stderr 尾巴（环形 50 行；stderr 必须并发排空：ffmpeg 话多，管道缓冲写
满即阻塞，进程"僵而不死"、wait() 死锁）→ 指数退避重启（backoff_base
起倍增至 backoff_cap；一次运行存活 ≥ stable_reset_s 即视为曾经健康、
下次崩溃从基值重来；退避等待可被 stopping 即刻打断）。

看门狗（Task 4 ride-along）：两个 -i 前各带 -rw_timeout（默认 10s，µs
单位）——端点"僵而不断"（连接在、字节不来）时 ffmpeg 自行超时退出，
由监督器重启，避免推流进程围着死端点永远干等。

脱敏（Task 4 ride-along）：stderr 进环形缓冲前把推流 URL 的末段路径
（rtmp://host/app/KEY 的 KEY——公开平台串流码位）替换为 ***；/status
把 stderr_tail 吐给任意观测方，串流码绝不能跟着泄出。

stop_all：置 stopping（抑制一切后续 spawn/重启）→ terminate 全部存活
进程 → 宽限 grace_s 等 supervisor 收尾 → 超时 kill 补刀；幂等。
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections import deque
from typing import Awaitable, Callable, Iterable, Optional

__all__ = ["StreamerManager", "resolve_ffmpeg"]

log = logging.getLogger("engine.streamer")

_STDERR_RING = 50   # 每信道 stderr 环形缓冲行数
_TAIL_IN_STATUS = 5  # status() 里露出的尾行数


def resolve_ffmpeg(path: str | None = None) -> str:
    """ffmpeg 路径解析：显式参数 > ONELIVE_FFMPEG > PATH > winget 默认全路径。
    与 TTS 侧同一条解析链（translate.tts），复用其实现避免两份默认路径漂移。"""
    from translate.tts import _resolve_ffmpeg
    return _resolve_ffmpeg(path)


class _ChannelState:
    __slots__ = ("proc", "running", "pid", "restarts", "last_exit_code", "stderr_tail",
                 "backoff")

    def __init__(self, backoff_base: float) -> None:
        self.proc: Optional[asyncio.subprocess.Process] = None
        self.running = False
        self.pid: Optional[int] = None
        self.restarts = 0
        self.last_exit_code: Optional[int] = None
        self.stderr_tail: deque[str] = deque(maxlen=_STDERR_RING)
        # 下一次重启前要等的退避秒数（supervisor 每轮进等待前刷新；
        # 白盒观测点：稳定运行后归位 backoff_base，见 stable_reset_s）
        self.backoff = backoff_base


class StreamerManager:
    """每信道一个受监督的 ffmpeg 推流进程（事件循环内使用，无锁）。"""

    def __init__(self, ffmpeg_path: str, base_url: str, rtmp_url_template: str,
                 channels: Iterable[int], fps: int = 15,
                 ready_probe: Optional[Callable[[], Awaitable[None]]] = None,
                 backoff_base: float = 1.0, backoff_cap: float = 30.0,
                 grace_s: float = 3.0, stable_reset_s: float = 60.0,
                 rw_timeout_us: int = 10_000_000) -> None:
        self._ffmpeg = ffmpeg_path
        self._base = base_url.rstrip("/")
        self._template = rtmp_url_template
        self._channels = tuple(channels)
        self._fps = fps
        self._ready_probe = ready_probe
        self._backoff_base = backoff_base
        self._backoff_cap = backoff_cap
        self._grace_s = grace_s
        # 稳定运行阈值：一次 ffmpeg 存活 ≥ 此秒数即视为"曾经健康"，下次
        # 崩溃从 backoff_base 重新退避（长跑后的偶发断线不该吃 30s 冷宫）
        self._stable_reset_s = stable_reset_s
        # 输入侧读超时（µs）：/stream.* 端点僵死（连接在、字节不来）时
        # ffmpeg 自行退出 → 监督器重启，充当 stall watchdog
        self._rw_timeout_us = rw_timeout_us
        self._states: dict[int, _ChannelState] = {
            ch: _ChannelState(backoff_base) for ch in self._channels}
        self._supervisors: dict[int, asyncio.Task] = {}
        self._stopping = asyncio.Event()  # Event 而非 bool：退避等待可被即刻打断
        # stderr 脱敏：推流 URL 的末段路径当作串流码（公开平台正是
        # rtmp://host/app/KEY 形态），存入 stderr_tail 前统一打码——
        # /status 会把尾巴原样吐给任何观测方，密钥绝不能跟着出去。
        self._redactors: list[tuple[re.Pattern, str]] = []
        for ch in self._channels:
            url = self._template.format(ch=ch)
            head, sep, _key = url.rpartition("/")
            if sep and "://" in head and not head.endswith("//") and not head.endswith(":/"):
                self._redactors.append((re.compile(re.escape(url)), f"{head}/***"))

    # ------------------------------------------------------------- command

    def command(self, ch: int) -> list[str]:
        """信道 ch 的完整 ffmpeg 命令行（测试覆写此方法注入假 ffmpeg）。"""
        return [
            self._ffmpeg, "-hide_banner", "-loglevel", "warning",
            # 输入侧选项：必须在各自的 -i 之前。-rw_timeout = 单次网络读
            # 超时（µs）——端点僵死时 ffmpeg 退出、由监督器重启（watchdog）
            "-rw_timeout", str(self._rw_timeout_us),
            "-use_wallclock_as_timestamps", "1",
            "-i", f"{self._base}/stream.mjpeg?channel={ch}",
            "-rw_timeout", str(self._rw_timeout_us),
            "-use_wallclock_as_timestamps", "1",
            "-i", f"{self._base}/stream.wav?channel={ch}",
            "-map", "0:v", "-map", "1:a",
            "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
            "-pix_fmt", "yuv420p", "-r", str(self._fps), "-g", str(self._fps * 2),
            "-c:a", "aac", "-ar", "16000",
            "-f", "flv", self._template.format(ch=ch),
        ]

    # ------------------------------------------------------------- lifecycle

    async def start_all(self) -> None:
        """可选 ready_probe 就绪后，为每信道 spawn 一个 supervisor 任务。

        探针失败（超时等）只记日志、不 spawn——服务本体照常活着，推流
        缺席是可观测的降级而非启动失败。stopping 已置位则一律不 spawn
        （探针挂起期间 stop_all 先到的竞态）。
        """
        if self._ready_probe is not None:
            try:
                await self._ready_probe()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("streamer: ready probe failed, ffmpeg pullers NOT started")
                return
        if self._stopping.is_set():
            return
        for ch in self._channels:
            self._supervisors[ch] = asyncio.create_task(
                self._supervise(ch), name=f"streamer-ch{ch}")
        log.info("streamer: supervisors started for channels %s", list(self._channels))

    async def stop_all(self) -> None:
        """置 stopping → terminate → 宽限 grace_s → kill 补刀；幂等。"""
        self._stopping.set()
        self._terminate_live("terminate")
        sups = list(self._supervisors.values())
        if sups:
            _done, pending = await asyncio.wait(sups, timeout=self._grace_s)
            if pending:
                # 宽限内没收尾：kill 补刀（进程列表重取——terminate 之后
                # supervisor 可能已翻页到新 spawn 的进程）
                self._terminate_live("kill")
            results = await asyncio.gather(*sups, return_exceptions=True)
            for r in results:
                if isinstance(r, Exception):
                    log.error("streamer: supervisor exited with error: %r", r)
        self._supervisors = {}

    def _terminate_live(self, how: str) -> None:
        for ch, st in self._states.items():
            proc = st.proc
            if proc is None or proc.returncode is not None:
                continue
            try:
                proc.kill() if how == "kill" else proc.terminate()
            except ProcessLookupError:
                pass
            except Exception:
                log.exception("streamer ch%d: %s failed", ch, how)

    # ------------------------------------------------------------- status

    def status(self) -> dict:
        """/status 的 "streams" 块：每信道 running/pid/restarts/退出码/stderr 尾。"""
        return {str(ch): {
            "running": st.running,
            "pid": st.pid,
            "restarts": st.restarts,
            "last_exit_code": st.last_exit_code,
            "stderr_tail": list(st.stderr_tail)[-_TAIL_IN_STATUS:],
        } for ch, st in self._states.items()}

    # ------------------------------------------------------------- internal

    def _redact(self, line: str) -> str:
        """stderr 行脱敏：推流 URL 末段（串流码位）→ ***（模式见 __init__）。"""
        for pat, repl in self._redactors:
            line = pat.sub(repl, line)
        return line

    async def _drain_stderr(self, st: _ChannelState, stream: asyncio.StreamReader) -> None:
        """并发排空 stderr 进环形缓冲（入缓冲前先脱敏）。按块读 + 手工切行
        （readline 在超长行上 raise ValueError 丢数据）；不排空则 ffmpeg 写满
        管道缓冲即阻塞。"""
        buf = b""
        while True:
            chunk = await stream.read(4096)
            if not chunk:
                if buf:
                    st.stderr_tail.append(self._redact(buf.decode("utf-8", "replace")))
                return
            buf += chunk
            *lines, buf = buf.split(b"\n")
            for ln in lines:
                st.stderr_tail.append(
                    self._redact(ln.decode("utf-8", "replace").rstrip("\r")))

    async def _supervise(self, ch: int) -> None:
        """spawn → 排空 stderr + 等退出 → 记录 → 指数退避重启（除非 stopping）。"""
        st = self._states[ch]
        backoff = self._backoff_base
        while not self._stopping.is_set():
            spawned_at = time.monotonic()
            try:
                proc = await asyncio.create_subprocess_exec(
                    *self.command(ch),
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE)
            except OSError as e:
                st.restarts += 1
                st.stderr_tail.append(f"[launcher] spawn failed: {e}")
                log.error("streamer ch%d: spawn failed (retry #%d in %.1fs): %s",
                          ch, st.restarts, backoff, e)
            else:
                st.proc = proc
                st.pid = proc.pid
                st.running = True
                if self._stopping.is_set():
                    # spawn 期间 stop_all 已跑过 terminate（没赶上本进程）：亲手补杀
                    try:
                        proc.terminate()
                    except ProcessLookupError:
                        pass
                log.info("streamer ch%d: ffmpeg started (pid=%d)", ch, proc.pid)
                drain = asyncio.create_task(self._drain_stderr(st, proc.stderr))
                rc = await proc.wait()
                await drain  # 尾巴读净后再记账，status 的 stderr_tail 才完整
                st.running = False
                st.proc = None
                st.last_exit_code = rc
                if self._stopping.is_set():
                    return
                st.restarts += 1
                if time.monotonic() - spawned_at >= self._stable_reset_s:
                    # 稳定运行过（≥ stable_reset_s）：退避归位基值——长跑后的
                    # 偶发断线立刻重试，而不是继承此前累积的指数惩罚
                    backoff = self._backoff_base
                log.warning(
                    "streamer ch%d: ffmpeg exited rc=%s, restart #%d in %.1fs; stderr: %s",
                    ch, rc, st.restarts, backoff,
                    " | ".join(list(st.stderr_tail)[-_TAIL_IN_STATUS:]) or "<empty>")
            # 可打断退避：stopping 置位即刻醒来退出，不等满 backoff
            st.backoff = backoff  # 白盒观测点：本轮实际等待的退避值
            try:
                await asyncio.wait_for(self._stopping.wait(), timeout=backoff)
                return
            except asyncio.TimeoutError:
                pass
            backoff = min(backoff * 2, self._backoff_cap)
