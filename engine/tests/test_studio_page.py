"""Studio 展示控制台页面端点测试：/studio 页面服务与关键诚实标注。

镜像 test_console_page.py 的口径：只测端点服务与页面关键标记
（每频道 canvas、链路RTT(ws) 限定词、演示数据标注），JS 行为不在此测。
"""

from fastapi.testclient import TestClient

from service.app import create_app


class EchoPipeline:
    def infer(self, frame_bgr, seq, lip_ratio=None):
        return frame_bgr


def test_studio_page_served():
    app = create_app(lambda ch: EchoPipeline())
    client = TestClient(app)
    r = client.get("/studio")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
    body = r.text
    assert "OneLive" in body                     # 品牌标记
    assert "studio" in body.lower()              # 页面标记（title / 注释等）


def test_studio_page_has_channel_canvases():
    """三卡位各有一个 /out 预览 canvas（真实频道数由 /status 在前端决定，
    未配置槽由 JS 置灰——canvas 元素本身三个都在）。"""
    app = create_app(lambda ch: EchoPipeline())
    body = TestClient(app).get("/studio").text
    for i in range(3):
        assert f'id="cv{i}"' in body
        assert f'id="img{i}"' in body            # 待机占位图（帧到达前显示）
    assert body.count("<canvas") == 3


def test_studio_page_honest_labels():
    """诚实标注：RTT 必须限定为 链路RTT(ws)（非蜂窝），无真实数据源的
    模块必须带 演示数据/演示素材 标注。"""
    app = create_app(lambda ch: EchoPipeline())
    body = TestClient(app).get("/studio").text
    assert "链路RTT(ws)" in body
    assert "演示数据" in body
    assert "演示素材" in body
    # 绝不把 WS 传输 RTT 标成蜂窝/5G 时延（"5G" 只允许出现在演示标注的手机面板里）
    assert "5G RTT" not in body and "蜂窝RTT" not in body


def test_studio_page_no_streams_no_uplink_ok():
    """未配推流/无上行上报时 /studio 与 /status 都不 500——页面 JS 对
    streams 缺失渲染 推流未启用，对 uplink 空 dict 渲染 "-"。"""
    app = create_app(lambda ch: EchoPipeline())
    client = TestClient(app)
    assert client.get("/studio").status_code == 200
    s = client.get("/status").json()
    assert "streams" not in s          # 未配推流：键整体不存在
    assert s["uplink"] == {}           # 无上报：空 dict
