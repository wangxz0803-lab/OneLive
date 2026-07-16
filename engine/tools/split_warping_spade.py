# -*- coding: utf-8 -*-
"""
OneLive V2 M0 spike (Task 3): split warping_spade.onnx at its two 5D GridSample
nodes into 3 GPU-runnable ONNX parts.

Why: warping_spade.onnx contains two 5D GridSample ops. On this machine
(Intel Core Ultra 7 155H, Arc iGPU):
  - ORT DirectML EP claims GridSample but kernel creation fails
    (MLOperatorAuthorImpl.cpp(2818), HRESULT 0x80004005) -> whole 402MB model
    falls back to pure CPU at ~4-8 s/frame.
  - OpenVINO's ONNX frontend rejects the model outright (GridSample is 4D-only:
    "Check 'data_shape.rank().compatible(4)' failed").
After splitting, the parts contain no GridSample and run on GPU; the two
grid_samples execute via torch CPU F.grid_sample (~130 ms total). Consumed by
SplitWarpingSpadePredictor in engine/FasterLivePortrait/src/models/predictor.py
(see engine/patches/faster-live-portrait-dml.patch).

Usage:
    python split_warping_spade.py [model_dir]
model_dir defaults to engine/models/liveportrait/liveportrait_onnx (relative to
this file's repo). Writes warping_spade_dml_part{a,b,c}.onnx and
warping_spade_dml_split.json into model_dir.
"""
import os
import sys
import json

import onnx
from onnx import utils as onnx_utils

DEFAULT_DIR = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "models", "liveportrait", "liveportrait_onnx"))


def main(model_dir):
    src = os.path.join(model_dir, "warping_spade.onnx")
    m = onnx.load(src)
    g = m.graph
    graph_inputs = [i.name for i in g.input]
    graph_outputs = [o.name for o in g.output]
    inits = {i.name for i in g.initializer}

    gs_nodes = [n for n in g.node if n.op_type == "GridSample"]
    assert len(gs_nodes) == 2, f"expected 2 GridSample nodes, got {len(gs_nodes)}"
    gs1 = next(n for n in gs_nodes if "dense_motion" in n.name)
    gs2 = next(n for n in gs_nodes if n is not gs1)

    # Partition nodes by dependency on the GridSample outputs (graph is in
    # topological order): A = independent of both, B = depends on gs1 only,
    # C = depends on gs2 (transitively).
    dep1, dep2 = set(gs1.output), set(gs2.output)
    parts = {"A": [], "B": [], "C": []}
    for n in g.node:
        if n is gs1 or n is gs2:
            continue
        if any(i in dep2 for i in n.input):
            part = "C"
        elif any(i in dep1 for i in n.input):
            part = "B"
        else:
            part = "A"
        parts[part].append(n)
        if part in ("B", "C"):
            dep1.update(n.output)
        if part == "C":
            dep2.update(n.output)

    def boundary(nodes):
        produced = {o for n in nodes for o in n.output}
        consumed = {i for n in nodes for i in n.input if i}
        inputs = sorted(t for t in consumed if t not in produced and t not in inits)
        needed = set()
        for n2 in g.node:
            if any(n2 is n for n in nodes):
                continue
            needed.update(i for i in n2.input if i in produced)
        needed.update(o for o in graph_outputs if o in produced)
        return inputs, sorted(needed)

    inA, outA = boundary(parts["A"])
    inB, outB = boundary(parts["B"])
    inC, outC = boundary(parts["C"])

    for pname, (i_, o_) in {"a": (inA, outA), "b": (inB, outB), "c": (inC, outC)}.items():
        dst = os.path.join(model_dir, f"warping_spade_dml_part{pname}.onnx")
        onnx_utils.extract_model(src, dst, i_, o_, check_model=False)
        print("wrote", dst, f"{os.path.getsize(dst) / 1e6:.1f} MB")

    manifest = {
        "original_inputs": graph_inputs,
        "original_outputs": graph_outputs,
        "steps": [
            {"type": "onnx", "file": "warping_spade_dml_parta.onnx", "inputs": inA, "outputs": outA},
            {"type": "grid_sample", "x": gs1.input[0], "grid": gs1.input[1], "out": gs1.output[0]},
            {"type": "onnx", "file": "warping_spade_dml_partb.onnx", "inputs": inB, "outputs": outB},
            {"type": "grid_sample", "x": gs2.input[0], "grid": gs2.input[1], "out": gs2.output[0]},
            {"type": "onnx", "file": "warping_spade_dml_partc.onnx", "inputs": inC, "outputs": outC},
        ],
    }
    mp = os.path.join(model_dir, "warping_spade_dml_split.json")
    with open(mp, "w") as f:
        json.dump(manifest, f, indent=1)
    print("wrote", mp)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DIR)
