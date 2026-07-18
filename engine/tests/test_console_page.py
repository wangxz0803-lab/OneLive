"""控制台页面端点测试（M3b Task 3）：/console 页面服务、/avatars 白名单列举、
/status 增补的 uptime 字段。JS 行为不在此测（Task 4 E2E 覆盖）。"""

from fastapi.testclient import TestClient

from service.app import create_app


class EchoPipeline:
    def infer(self, frame_bgr, seq, lip_ratio=None):
        return frame_bgr


def test_console_page_served():
    app = create_app(lambda ch: EchoPipeline())
    client = TestClient(app)
    r = client.get("/console")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
    body = r.text
    assert "OneLive" in body          # 品牌标记
    assert "console" in body.lower()  # 控制台标记（title / class 等）


def test_status_has_uptime():
    app = create_app(lambda ch: EchoPipeline())
    client = TestClient(app)
    body = client.get("/status").json()
    assert "uptime_s" in body
    assert isinstance(body["uptime_s"], (int, float))
    assert body["uptime_s"] >= 0.0


def test_avatars_lists_only_whitelisted(tmp_path, monkeypatch):
    """/avatars 只返回通过白名单正则的纯文件名——错误扩展名、含空格、
    以及 traversal 形状（前导点）的名字都必须被排除。"""
    (tmp_path / "s1.jpg").write_bytes(b"x")
    (tmp_path / "avatar_2.png").write_bytes(b"x")
    (tmp_path / "not_allowed.txt").write_bytes(b"x")     # 扩展名不在白名单
    (tmp_path / "bad name.jpg").write_bytes(b"x")        # 含空格（\w 不含空格）
    (tmp_path / "..evil.jpg").write_bytes(b"x")          # traversal 形状：前导点

    monkeypatch.setenv("ONELIVE_AVATAR_DIR", str(tmp_path))
    app = create_app(lambda ch: EchoPipeline())
    client = TestClient(app)
    body = client.get("/avatars").json()
    assert set(body["avatars"]) == {"s1.jpg", "avatar_2.png"}


def test_avatars_missing_dir_returns_empty(tmp_path, monkeypatch):
    """底图目录不存在时诚实返回空列表，不 500。"""
    monkeypatch.setenv("ONELIVE_AVATAR_DIR", str(tmp_path / "nope"))
    app = create_app(lambda ch: EchoPipeline())
    client = TestClient(app)
    body = client.get("/avatars").json()
    assert body["avatars"] == []
