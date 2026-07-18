"""上行统计存储（M3b Task 2）：capture 端每 2s 上报一次 uplink_stats
（fps_sent / skipped / rtt_ms），/status 汇总成每频道的真实 HUD 数据。

时钟契约：record 与 snapshot 都收注入的 now——/ingest 记录与 /status 取快照
统一用 time.monotonic()。monotonic 不是墙钟、不能当 JSON 时间戳序列化，但
age 计算（snapshot.now - received_at）纯是差值，单调递增即可，语义正确。
纯逻辑、now 注入 → 可单测（不依赖真实时钟、不睡眠）。

snapshot 键沿用 record 传入的 channel（int）；经 FastAPI JSON 编码后自然
变成字符串键，与 /status 里 channels 块的 str(ch) 键一致。"""


class UplinkStore:
    """每频道保留最近一次上行统计（后到覆盖先到）。线程无关：record 在
    /ingest 接收协程里调、snapshot 在 /status 处理器里调，同一事件循环。"""

    def __init__(self) -> None:
        self._by_channel: dict[int, dict] = {}

    def record(self, channel: int, stats: dict, now: float) -> None:
        """记录一份上行统计并打上 received_at=now（内部时间戳，不外泄）。"""
        self._by_channel[channel] = {**stats, "received_at": now}

    def snapshot(self, now: float, stale_after_s: float = 5.0) -> dict:
        """返回 {channel: {...stats, "age_s": float, "stale": bool}}。
        age_s = now - received_at；age_s >= stale_after_s 记为 stale
        （上报中断超过阈值——HUD 据此把该频道标灰）。无上报则空 dict。"""
        out: dict[int, dict] = {}
        for ch, entry in self._by_channel.items():
            age = now - entry["received_at"]
            rec = {k: v for k, v in entry.items() if k != "received_at"}
            rec["age_s"] = round(age, 3)
            rec["stale"] = age >= stale_after_s
            out[ch] = rec
        return out
