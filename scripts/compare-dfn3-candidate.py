#!/usr/bin/env python3
"""Compare a DeepFilterNet3 candidate graph group with the pinned FP32 group.

This deterministic graph-boundary gate complements (but never replaces) the
real-music browser PCM gate. It exercises encoder routing and both decoders.
"""
from __future__ import annotations
import argparse
from pathlib import Path
import sys
import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[1]
REFERENCE = ROOT / "models/deepfilternet3"


def sessions(directory: Path):
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    return tuple(ort.InferenceSession(str(directory / name), options,
                                      providers=["CPUExecutionProvider"])
                 for name in ("enc.onnx", "erb_dec.onnx", "df_dec.onnx"))


def run(group, feat_erb, feat_spec):
    encoder, erb_decoder, df_decoder = group
    values = encoder.run(None, {"feat_erb": feat_erb, "feat_spec": feat_spec})
    encoded = dict(zip((item.name for item in encoder.get_outputs()), values))
    mask = erb_decoder.run(None, {key: encoded[key] for key in ("emb", "e3", "e2", "e1", "e0")})[0]
    coefs = df_decoder.run(None, {key: encoded[key] for key in ("emb", "c0")})[0]
    return mask, coefs


def metric(reference, candidate):
    delta = candidate.astype(np.float64) - reference.astype(np.float64)
    rms = np.sqrt(np.mean(np.square(reference.astype(np.float64))))
    return {
        "mae": float(np.mean(np.abs(delta))),
        "max": float(np.max(np.abs(delta))),
        "relativeRms": float(np.sqrt(np.mean(np.square(delta))) / max(rms, 1e-12)),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--frames", type=int, default=12)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--max-relative-rms", type=float, default=0.005)
    parser.add_argument("--max-absolute", type=float, default=0.01)
    args = parser.parse_args()
    rng = np.random.default_rng(args.seed)
    feat_erb = rng.normal(0, 0.3, (1, 1, args.frames, 32)).astype(np.float32)
    feat_spec = rng.normal(0, 0.3, (1, 2, args.frames, 96)).astype(np.float32)
    reference = run(sessions(REFERENCE), feat_erb, feat_spec)
    candidate = run(sessions(args.candidate), feat_erb, feat_spec)
    failed = False
    for name, expected, actual in zip(("mask", "coefs"), reference, candidate):
        if expected.shape != actual.shape or not np.isfinite(actual).all():
            print(f"{name}: invalid shape or non-finite output", file=sys.stderr)
            failed = True
            continue
        result = metric(expected, actual)
        print(f"{name}: MAE {result['mae']:.9g} · max {result['max']:.9g} · relative RMS {result['relativeRms']:.9g}")
        failed |= result["relativeRms"] > args.max_relative_rms or result["max"] > args.max_absolute
    if failed:
        print("candidate failed deterministic graph gate", file=sys.stderr)
        return 1
    print("candidate passed deterministic graph gate; browser PCM qualification is still required")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
