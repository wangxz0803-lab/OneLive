"""测试假 ffmpeg（test_streamer.py fake-ffmpeg 用例的"二进制"）：按 argv[1] 行动。

stay  ：stderr 报一行后长眠（模拟正常推流的常驻进程）
exit3 ：stderr 写 8 行后以退出码 3 退出（模拟启动即失败，驱动退避重启）
flood ：stderr 灌 ~2MB 后以 0 退出——监督者若不并发排空 stderr 管道，
        子进程写满缓冲即阻塞、永不退出（僵而不死），wait() 死锁
live  ：存活 0.3s 后以退出码 5 退出（模拟"跑了一阵才断线"——驱动
        stable_reset_s 退避归位路径）
say   ：把 argv[2] 原样写一行到 stderr 后长眠（驱动脱敏路径：文本里
        埋着推流 URL，监督者入缓冲前必须打码）
"""

import sys
import time

mode = sys.argv[1] if len(sys.argv) > 1 else "?"
if mode == "stay":
    sys.stderr.write("fake ffmpeg started\n")
    sys.stderr.flush()
    time.sleep(300)
elif mode == "live":
    time.sleep(0.3)
    sys.exit(5)
elif mode == "say":
    sys.stderr.write(sys.argv[2] + "\n")
    sys.stderr.flush()
    time.sleep(300)
elif mode == "exit3":
    for i in range(8):
        sys.stderr.write(f"err line {i}\n")
    sys.exit(3)
elif mode == "flood":
    payload = "x" * 100
    for i in range(20000):
        sys.stderr.write(f"{i:06d} {payload}\n")
    sys.exit(0)
else:
    sys.exit(f"unknown mode: {mode!r}")
