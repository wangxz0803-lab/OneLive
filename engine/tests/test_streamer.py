"""StreamerManager 测试（V2 M3a Task 3）。

fake-ffmpeg 用例：用 python 脚本（helpers/fake_ffmpeg.py）顶替 ffmpeg，
经子类覆写 command() 注入——.py 在 Windows 上不能直接当可执行文件
spawn，覆写比造 .bat 垫片干净；监督/stderr 排空/退避/停机路径全走真实现，
生产命令行形状由 test_command_* 专测锁定。

真 ffmpeg 用例：编码器面（libx264 + aac 必须在）+ demuxer 拉流 E2E
（真 uvicorn 起 EchoPipeline 服务，真 ffmpeg 用生产命令的输入半区拉
/stream.mjpeg + /stream.wav 各 3 秒 → 退出码 0 = 两路 demuxer 都消化
我们的流）。E2E 打 ffmpeg_e2e 标记（~10s）但保留在默认套件。
"""

import asyncio
import re
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

from service.streamer import StreamerManager, resolve_ffmpeg

ENGINE_ROOT = Path(__file__).resolve().parents[1]
FAKE_FFMPEG = ENGINE_ROOT / "tests" / "helpers" / "fake_ffmpeg.py"
SERVE_ECHO = ENGINE_ROOT / "tests" / "helpers" / "serve_echo.py"


class ScriptedManager(StreamerManager):
    """command() 换成假 ffmpeg 脚本；其余（监督/排空/退避/停机）走真实现。"""

    def __init__(self, mode: str, *extra_args: str, **kw):
        kw.setdefault("ffmpeg_path", "ffmpeg-not-used")
        kw.setdefault("base_url", "http://127.0.0.1:1")
        kw.setdefault("rtmp_url_template", "rtmp://unused/{ch}")
        kw.setdefault("channels", (0,))
        kw.setdefault("backoff_base", 0.05)
        kw.setdefault("backoff_cap", 0.2)
        super().__init__(**kw)
        self._mode = mode
        self._extra_args = extra_args

    def command(self, ch: int) -> list[str]:
        return [sys.executable, "-u", str(FAKE_FFMPEG), self._mode, *self._extra_args]


async def _poll(cond, timeout: float = 10.0, interval: float = 0.02) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return True
        await asyncio.sleep(interval)
    return cond()


# ---------------------------------------------------------------- 命令行形状


def test_command_shape_input_options_before_each_input():
    """生产命令契约。与计划的偏差：-use_wallclock_as_timestamps 是输入侧
    demuxer 选项（decoding param），计划把它放在两个 -i 之后（输出位置）
    ——ffmpeg 会以 "input option applied to output file" 报错退出；实现
    改为在每个 -i 之前各放一份。-rw_timeout（Task 4 ride-along）同为输入
    侧协议选项：端点僵而不断时 10s 读超时让 ffmpeg 退出、监督器重启
    （stall watchdog）。输入半区的真实性由 demuxer E2E 背书。"""
    m = StreamerManager(ffmpeg_path="F:/ffmpeg.exe",
                        base_url="http://127.0.0.1:8900",
                        rtmp_url_template="rtmp://127.0.0.1:1935/live/ch{ch}",
                        channels=(0, 3))
    assert m.command(3) == [
        "F:/ffmpeg.exe", "-hide_banner", "-loglevel", "warning",
        "-rw_timeout", "10000000",
        "-use_wallclock_as_timestamps", "1",
        "-i", "http://127.0.0.1:8900/stream.mjpeg?channel=3",
        "-rw_timeout", "10000000",
        "-use_wallclock_as_timestamps", "1",
        "-i", "http://127.0.0.1:8900/stream.wav?channel=3",
        "-map", "0:v", "-map", "1:a",
        "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
        "-pix_fmt", "yuv420p", "-r", "15", "-g", "30",
        "-c:a", "aac", "-ar", "16000",
        "-f", "flv", "rtmp://127.0.0.1:1935/live/ch3",
    ]


def test_command_respects_fps_and_gop():
    m = StreamerManager(ffmpeg_path="f", base_url="http://h:1",
                        rtmp_url_template="rtmp://x/{ch}", channels=(0,), fps=30)
    cmd = m.command(0)
    assert cmd[cmd.index("-r") + 1] == "30"
    assert cmd[cmd.index("-g") + 1] == "60"  # gop = 2s = fps*2


# ---------------------------------------------------------------- fake-ffmpeg


def test_stays_alive_reports_running_pid_and_stderr():
    async def run():
        m = ScriptedManager("stay")
        await m.start_all()
        try:
            assert await _poll(lambda: m.status()["0"]["running"]), m.status()
            st = m.status()["0"]
            assert isinstance(st["pid"], int) and st["pid"] > 0
            assert st["restarts"] == 0
            assert st["last_exit_code"] is None
            assert await _poll(lambda: any(
                "fake ffmpeg started" in ln
                for ln in m.status()["0"]["stderr_tail"])), m.status()
        finally:
            await m.stop_all()
        st = m.status()["0"]
        assert st["running"] is False
        assert st["last_exit_code"] is not None  # terminate 后退出码已记录

    asyncio.run(run())


def test_immediate_exit_restarts_with_backoff_and_records_exit_code():
    async def run():
        m = ScriptedManager("exit3")
        await m.start_all()
        try:
            assert await _poll(lambda: m.status()["0"]["restarts"] >= 2), m.status()
            st = m.status()["0"]
            assert st["last_exit_code"] == 3
            # 脚本写 8 行（0..7），环形缓冲收尾、status 露最后 5 行
            assert any("err line 7" in ln for ln in st["stderr_tail"]), st
            assert len(st["stderr_tail"]) <= 5
        finally:
            await m.stop_all()
        # stopping 置位抑制重启：停后计数不再涨
        n = m.status()["0"]["restarts"]
        await asyncio.sleep(0.3)
        assert m.status()["0"]["restarts"] == n

    asyncio.run(run())


def test_backoff_resets_after_stable_run():
    """稳定运行（存活 ≥ stable_reset_s）后崩溃：退避回到 backoff_base，
    不继承指数惩罚。fake 'live' 存活 0.3s、stable_reset_s=0.2 → 每次崩溃
    都算"曾经健康"，白盒观测 st.backoff 恒等于基值。"""
    async def run():
        m = ScriptedManager("live", stable_reset_s=0.2,
                            backoff_base=0.05, backoff_cap=5.0)
        await m.start_all()
        try:
            assert await _poll(lambda: m.status()["0"]["restarts"] >= 3,
                               timeout=15), m.status()
            assert m._states[0].backoff == 0.05, m._states[0].backoff
            assert m.status()["0"]["last_exit_code"] == 5
        finally:
            await m.stop_all()

    asyncio.run(run())


def test_backoff_keeps_growing_without_stable_run():
    """负对照：立即崩溃（存活 << stable_reset_s）时退避照旧指数增长。"""
    async def run():
        m = ScriptedManager("exit3", stable_reset_s=10.0,
                            backoff_base=0.05, backoff_cap=5.0)
        await m.start_all()
        try:
            assert await _poll(lambda: m.status()["0"]["restarts"] >= 3), m.status()
            # 第 3 次重启前的退避已是 base*4=0.2（读取时可能又翻了几倍）
            assert m._states[0].backoff >= 0.2, m._states[0].backoff
        finally:
            await m.stop_all()

    asyncio.run(run())


def test_stderr_tail_redacts_stream_key():
    """脱敏（Task 4 ride-along）：stderr 里出现的推流 URL，末段路径（串流
    码位）在进入 stderr_tail 前必须换成 ***——/status 会把尾巴吐给任何
    观测方。fake 'say' 原样回显一行含完整 URL 的报错文本。"""
    async def run():
        url = "rtmp://a.rtmp.example.com/live2/secret-stream-key-0"
        m = ScriptedManager(
            "say", f"[flv @ 0x1] Failed to update header with correct duration. {url}",
            rtmp_url_template="rtmp://a.rtmp.example.com/live2/secret-stream-key-{ch}")
        await m.start_all()
        try:
            assert await _poll(lambda: m.status()["0"]["stderr_tail"]), m.status()
            tail = "\n".join(m.status()["0"]["stderr_tail"])
            assert "secret-stream-key-0" not in tail, tail
            assert "rtmp://a.rtmp.example.com/live2/***" in tail, tail
        finally:
            await m.stop_all()

    asyncio.run(run())


def test_flooded_stderr_is_drained_no_deadlock():
    """2MB stderr：不并发排空则子进程写满管道即阻塞、wait() 永不返回
    （测试会在 _poll 超时上失败）；排空到位则正常退出且环形缓冲拿到尾行。"""
    async def run():
        m = ScriptedManager("flood", backoff_base=5.0)  # 大退避：只观察首轮
        await m.start_all()
        try:
            assert await _poll(
                lambda: m.status()["0"]["last_exit_code"] == 0, timeout=20), m.status()
            tail = m.status()["0"]["stderr_tail"]
            assert len(tail) == 5
            assert tail[-1].startswith("019999"), tail  # 最后一行确实进了缓冲
        finally:
            await m.stop_all()

    asyncio.run(run())


def test_stop_all_prompt_and_idempotent():
    async def run():
        m = ScriptedManager("stay", channels=(0, 1))
        await m.start_all()
        assert await _poll(lambda: all(s["running"] for s in m.status().values()))
        pids = {s["pid"] for s in m.status().values()}
        assert len(pids) == 2  # 每信道一个独立进程
        t0 = time.monotonic()
        await m.stop_all()
        elapsed = time.monotonic() - t0
        # Windows 上 terminate 即 TerminateProcess，远快于 3s kill 宽限
        assert elapsed < 2.5, f"stop_all took {elapsed:.1f}s"
        assert all(not s["running"] for s in m.status().values())
        await m.stop_all()  # 幂等：二次调用不抛不挂

    asyncio.run(run())


def test_stop_during_ready_probe_spawns_nothing():
    """探针未就绪时停机：stopping 置位后即使探针随后放行也绝不 spawn。"""
    async def run():
        gate = asyncio.Event()

        async def probe():
            await gate.wait()

        m = ScriptedManager("stay", ready_probe=probe)
        starter = asyncio.create_task(m.start_all())
        await asyncio.sleep(0.05)
        await m.stop_all()
        gate.set()  # 探针这时才放行
        await starter
        assert m.status()["0"]["running"] is False
        assert m.status()["0"]["pid"] is None
        await asyncio.sleep(0.1)
        assert m.status()["0"]["pid"] is None  # 没有任何延迟 spawn

    asyncio.run(run())


# ---------------------------------------------------------------- 真 ffmpeg


def test_real_ffmpeg_has_libx264_and_aac():
    """gyan full build 必须带 libx264 + aac（推流命令的两个编码器）——硬断言。"""
    out = subprocess.run([resolve_ffmpeg(), "-hide_banner", "-encoders"],
                         capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr[-1000:]
    assert "libx264" in out.stdout
    assert re.search(r"^\s*A[A-Z.]+\s+aac\s", out.stdout, re.MULTILINE), \
        "aac encoder missing from ffmpeg -encoders"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_status_ok(url: str, server: subprocess.Popen, timeout: float = 40.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if server.poll() is not None:
            err = server.stderr.read().decode("utf-8", "replace") if server.stderr else ""
            raise AssertionError(f"serve_echo died rc={server.returncode}\n{err[-3000:]}")
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return
        except OSError:
            pass
        time.sleep(0.2)
    raise AssertionError(f"serve_echo not ready within {timeout}s")


@pytest.mark.ffmpeg_e2e
def test_real_ffmpeg_consumes_mjpeg_and_wav_streams():
    """经验性 demuxer 检查（review carry-forward）：真 uvicorn 服务真端口，
    真 ffmpeg 以生产命令的输入半区拉 /stream.mjpeg + /stream.wav 各 3 秒，
    输出换成 -f null（Task 3 无 RTMP sink）。退出码 0 = mjpeg + wav 两路
    demuxer 都实际消化了我们的流格式。"""
    port = _free_port()
    import os
    env = dict(os.environ, PYTHONPATH=str(ENGINE_ROOT))
    server = subprocess.Popen(
        [sys.executable, str(SERVE_ECHO), "--port", str(port)],
        env=env, cwd=str(ENGINE_ROOT),
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        _wait_status_ok(f"http://127.0.0.1:{port}/status", server)
        m = StreamerManager(ffmpeg_path=resolve_ffmpeg(),
                            base_url=f"http://127.0.0.1:{port}",
                            rtmp_url_template="rtmp://unused/{ch}", channels=(0,))
        cmd = m.command(0)
        i = cmd.index("-f")  # 生产命令输入半区原样保留，仅替换输出目标
        cmd = cmd[:i] + ["-t", "3", "-f", "null", "-"]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
        assert r.returncode == 0, \
            f"ffmpeg rc={r.returncode}\ncmd={cmd}\nstderr:\n{r.stderr[-3000:]}"
    finally:
        server.kill()
        server.wait(timeout=10)
