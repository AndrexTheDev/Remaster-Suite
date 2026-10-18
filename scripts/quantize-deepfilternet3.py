#!/usr/bin/env python3
"""Verify and reproducibly convert the pinned DeepFilterNet3 ONNX graph group.

The default mode needs only Python's standard library and verifies that input
bytes match models/sources/deepfilternet3.json. FP16/INT8 conversion is
opt-in and writes to a separate directory; production publication still
requires the browser quality gate documented in DEEPFILTERNET3-CONTRACT.md.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "models/sources/deepfilternet3.json"
DEFAULT_INPUT = ROOT / "models/deepfilternet3"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def graph_records(lock: dict) -> list[dict]:
    records = lock.get("artifacts") or lock.get("files") or lock.get("graphs")
    if not isinstance(records, list):
        raise ValueError("source lock has no graph list")
    return records


def verify_sources(input_dir: Path, records: list[dict]) -> None:
    for record in records:
        name = record.get("file") or record.get("name")
        path = input_dir / name
        if not path.is_file():
            raise ValueError(f"missing pinned graph: {path}")
        size = path.stat().st_size
        actual = sha256(path)
        if size != record["bytes"] or actual != record["sha256"]:
            raise ValueError(f"source mismatch: {name} ({size} B, {actual})")
        print(f"verified {name}: {size} B · {actual}")


def convert(input_dir: Path, output_dir: Path, records: list[dict], output_format: str) -> list[dict]:
    try:
        import onnx
        import onnxruntime as ort
        from onnxconverter_common import float16
        from onnxruntime.quantization import QuantType, quantize_dynamic
    except ImportError as exc:
        raise RuntimeError(
            "quantization requires: python -m pip install -r scripts/requirements-quantize.txt"
        ) from exc
    if ort.__version__ != "1.20.1":
        raise RuntimeError(f"expected onnxruntime 1.20.1, got {ort.__version__}")
    output_dir.mkdir(parents=True, exist_ok=True)
    result = []
    for record in records:
        name = record.get("file") or record.get("name")
        source, target = input_dir / name, output_dir / name
        if output_format == "fp16":
            model = float16.convert_float_to_float16(
                onnx.load(str(source)), keep_io_types=True,
            )
            onnx.save(model, str(target))
        else:
            quantize_dynamic(
                str(source), str(target), weight_type=QuantType.QInt8,
                per_channel=True, reduce_range=False,
                op_types_to_quantize=["MatMul", "Gemm", "GRU", "Conv"],
            )
            model = onnx.load(str(target), load_external_data=False)
        quantized_nodes = sum(node.op_type in {
            "DynamicQuantizeLinear", "MatMulInteger", "QLinearMatMul", "QLinearConv"
        } for node in model.graph.node)
        fp16_initializers = sum(initializer.data_type == onnx.TensorProto.FLOAT16 for initializer in model.graph.initializer)
        result.append({
            "file": name, "sourceBytes": source.stat().st_size,
            "bytes": target.stat().st_size, "sha256": sha256(target),
            "quantizedNodes": quantized_nodes,
            "fp16Initializers": fp16_initializers,
        })
        print(
            f"converted {name}: {target.stat().st_size} B · "
            f"{quantized_nodes} quantized nodes · {fp16_initializers} fp16 initializers · "
            f"{result[-1]['sha256']}"
        )
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, help="write an unpublished candidate graph group here")
    parser.add_argument("--format", choices=("fp16", "int8"), default="fp16",
                        help="candidate representation (default: fp16)")
    parser.add_argument("--metadata", type=Path, help="write generated hashes/sizes as JSON")
    args = parser.parse_args()
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    records = graph_records(lock)
    verify_sources(args.input, records)
    if not args.output:
        print("source group is pinned and reproducible; no quantization requested")
        return 0
    generated = convert(args.input, args.output, records, args.format)
    metadata = {
        "schema": 1,
        "sourceCommit": lock.get("upstreamCommit") or lock.get("commit"),
        "tool": ("onnxconverter_common.float16" if args.format == "fp16"
                 else "onnxruntime.quantization.quantize_dynamic"),
        "onnxruntime": "1.20.1",
        "format": args.format,
        "weightType": "Float16" if args.format == "fp16" else "QInt8",
        "keepIoTypes": args.format == "fp16",
        "perChannel": args.format == "int8",
        "operators": [] if args.format == "fp16" else ["MatMul", "Gemm", "GRU", "Conv"],
        "publishable": False,
        "qualityGateRequired": True,
        "artifacts": generated,
    }
    metadata_path = args.metadata or args.output / "quantization.json"
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {metadata_path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
