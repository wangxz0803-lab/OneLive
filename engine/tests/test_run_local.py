"""run_local 参数面单测（argparse 层，不起服务、不构造管线）。"""

import asyncio

from service.run_local import StubTranslateProvider, build_parser


def test_no_lip_flag_default_and_set():
    ap = build_parser()
    assert ap.parse_args([]).no_lip is False          # 默认嘴型开
    assert ap.parse_args(["--no-lip"]).no_lip is True  # 逃生开关：渲染路径回 M1a 基线


def test_translate_stub_flag_default_off():
    """--translate-stub 是测试脚手架：默认必须关，且与 --translate 相互独立解析。"""
    ap = build_parser()
    args = ap.parse_args([])
    assert args.translate is False and args.translate_stub is False
    assert ap.parse_args(["--translate-stub"]).translate_stub is True


def test_stub_provider_self_declares_and_marks_text():
    """stub Provider 返回 ok + 'EN: '+原文，detail 自我声明 test-only——
    事件流里一眼可辨不是真翻译。"""
    p = StubTranslateProvider()
    assert p.available is True
    r = asyncio.run(p.translate("大家好", "en"))
    assert r.ok is True and r.status == "ok"
    assert r.text == "EN: 大家好"
    assert "test-only" in r.detail
