"""run_local 参数面单测（argparse 层，不起服务、不构造管线）。"""

from service.run_local import build_parser


def test_no_lip_flag_default_and_set():
    ap = build_parser()
    assert ap.parse_args([]).no_lip is False          # 默认嘴型开
    assert ap.parse_args(["--no-lip"]).no_lip is True  # 逃生开关：渲染路径回 M1a 基线
