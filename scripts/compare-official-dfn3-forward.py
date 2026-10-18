#!/usr/bin/env python3
"""Compare the complete official Python/libDF forward with JS/ORT-WASM PCM."""
from __future__ import annotations
import json
from pathlib import Path
import subprocess
import tempfile
import numpy as np
import onnxruntime as ort
from libdf import DF, erb, erb_norm, unit_norm

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / "models/deepfilternet3"
FFT, HOP, DF_BINS, ORDER, LOOKAHEAD = 960, 480, 96, 5, 2


def session(name: str):
    options = ort.SessionOptions(); options.intra_op_num_threads = 1
    return ort.InferenceSession(str(MODEL / name), options, providers=["CPUExecutionProvider"])


def official_forward(signal: np.ndarray) -> np.ndarray:
    state = DF(48000, FFT, HOP, 32, 2)
    spec = state.analysis(np.pad(signal[None], ((0, 0), (0, FFT))))
    frames = spec.shape[1]; aligned = (frames + 3) & ~3
    erb_actual = erb_norm(erb(spec, state.erb_widths(), True), .99)
    cplx_actual = unit_norm(spec[:, :, :DF_BINS], .99)
    feat_erb = np.zeros((1, 1, aligned, 32), np.float32)
    feat_spec = np.zeros((1, 2, aligned, DF_BINS), np.float32)
    feat_erb[:, 0, :frames] = erb_actual
    feat_spec[:, 0, :frames] = cplx_actual.real
    feat_spec[:, 1, :frames] = cplx_actual.imag
    enc = session("enc.onnx")
    values = enc.run(None, {"feat_erb": feat_erb, "feat_spec": feat_spec})
    encoded = dict(zip((item.name for item in enc.get_outputs()), values))
    mask = session("erb_dec.onnx").run(None, {k: encoded[k] for k in ("emb", "e3", "e2", "e1", "e0")})[0][:, 0, :frames]
    coefs_raw = session("df_dec.onnx").run(None, {k: encoded[k] for k in ("emb", "c0")})[0][:, :frames]
    coefs = coefs_raw[..., 0::2] + 1j * coefs_raw[..., 1::2]
    output = spec.copy(); edges = np.r_[0, np.cumsum(state.erb_widths())]
    for band in range(32): output[:, :, edges[band]:edges[band + 1]] *= mask[:, :, band, None]
    padded = np.pad(spec, ((0, 0), (ORDER - 1 - LOOKAHEAD, LOOKAHEAD), (0, 0)))
    for frame in range(frames):
        window = padded[:, frame:frame + ORDER, :DF_BINS].transpose(0, 2, 1)
        output[:, frame, :DF_BINS] = np.sum(window * coefs[:, frame], axis=-1)
    # libDF inverse may mutate its input, hence the copy.
    return state.synthesis(output.copy())[0][FFT - HOP:FFT - HOP + signal.size].astype(np.float32)


def js_forward(signal: np.ndarray, directory: Path) -> np.ndarray:
    signal.tofile(directory / "input.f32")
    script = r'''
const fs=require('fs'),path=require('path'); global.self=global;
require(process.argv[1]+'/assets/js/neural-worker.js');
const ort=require(process.argv[1]+'/node_modules/onnxruntime-web'); ort.env.wasm.numThreads=1;
(async()=>{const root=process.argv[1],tmp=process.argv[2],opts={executionProviders:['wasm'],graphOptimizationLevel:'all'};
const make=async n=>ort.InferenceSession.create(fs.readFileSync(path.join(root,'models/deepfilternet3',n)),opts);
const [encoder,erbDecoder,dfDecoder]=await Promise.all([make('enc.onnx'),make('erb_dec.onnx'),make('df_dec.onnx')]);
const b=fs.readFileSync(path.join(tmp,'input.f32')), input=new Float32Array(b.buffer,b.byteOffset,b.byteLength/4);
const result=await RSNeuralWorker.denoiseOfficialDfn3(input,{ort,provider:'wasm',fp16:false,sessions:{encoder,erbDecoder,dfDecoder}});
if(!result.applied)throw new Error(JSON.stringify(result));fs.writeFileSync(path.join(tmp,'js.f32'),Buffer.from(result.output.buffer,result.output.byteOffset,result.output.byteLength));
await Promise.all([encoder.release(),erbDecoder.release(),dfDecoder.release()]);})().catch(e=>{console.error(e);process.exit(1)});
'''
    subprocess.run(["node", "-e", script, str(ROOT), str(directory)], check=True)
    return np.fromfile(directory / "js.f32", np.float32)


def main() -> int:
    i = np.arange(12000, dtype=np.float32)
    signal = (.15 * np.sin(2 * np.pi * 440 * i / 48000)
              + .01 * np.sin(2 * np.pi * 7000 * i / 48000)).astype(np.float32)
    reference = official_forward(signal)
    with tempfile.TemporaryDirectory(prefix="rs-dfn3-forward-") as name:
        actual = js_forward(signal, Path(name))
    delta = actual.astype(np.float64) - reference.astype(np.float64)
    result = {"samples": int(actual.size), "max": float(np.max(np.abs(delta))),
              "mae": float(np.mean(np.abs(delta))),
              "relativeRms": float(np.sqrt(np.mean(delta * delta)) / np.sqrt(np.mean(reference.astype(np.float64) ** 2)))}
    print(json.dumps(result, indent=2))
    if actual.size != signal.size or not np.isfinite(actual).all() or result["max"] > 2e-5 or result["relativeRms"] > 2e-4:
        print("complete official forward parity gate failed")
        return 1
    print("complete official Python/libDF vs JavaScript/ORT-WASM parity gate passed")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
