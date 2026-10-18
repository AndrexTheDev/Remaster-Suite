#!/usr/bin/env python3
"""Compare Remaster Suite's STFT/ISTFT with the official libDF wheel.

Requires scripts/requirements-libdf-reference.txt. No generated data is kept.
The deterministic signal exercises both low and high model bins.
"""
from __future__ import annotations
import json
from pathlib import Path
import subprocess
import tempfile
import numpy as np
from libdf import DF

ROOT = Path(__file__).resolve().parents[1]
N, FFT, HOP, BINS = 12000, 960, 480, 481


def main() -> int:
    i = np.arange(N, dtype=np.float32)
    signal = (.15 * np.sin(2 * np.pi * 440 * i / 48000)
              + .01 * np.sin(2 * np.pi * 7000 * i / 48000)).astype(np.float32)
    state = DF(48000, FFT, HOP, 32, 2)
    spectrum = state.analysis(np.pad(signal[None], ((0, 0), (0, FFT))))[0]
    # libDF's inverse FFT may reuse/mutate its complex input buffer.
    synthesized = state.synthesis(spectrum.copy()[None])[0]
    with tempfile.TemporaryDirectory(prefix="rs-libdf-") as tmp_name:
        tmp = Path(tmp_name)
        signal.tofile(tmp / "signal.f32")
        spectrum.real.astype(np.float32).tofile(tmp / "real.f32")
        spectrum.imag.astype(np.float32).tofile(tmp / "imag.f32")
        synthesized.astype(np.float32).tofile(tmp / "synth.f32")
        script = r'''
const fs=require('fs'); global.self=global;
require(process.argv[1]+'/assets/js/neural-worker.js');
function read(name){const b=fs.readFileSync(process.argv[2]+'/'+name);return new Float32Array(b.buffer,b.byteOffset,b.byteLength/4)}
const x=read('signal.f32'), refRe=read('real.f32'), refIm=read('imag.f32'), refY=read('synth.f32');
const framed=new Float32Array(x.length+1440); framed.set(x,480);
const st=RSNeuralWorker.stft(framed,960,480,RSNeuralWorker.vorbisWindow(960));
let analysisMax=0,analysisMae=0;
for(let i=0;i<refRe.length;i++){const dr=st.re[i]/960-refRe[i],di=st.im[i]/960-refIm[i];analysisMax=Math.max(analysisMax,Math.abs(dr),Math.abs(di));analysisMae+=Math.abs(dr)+Math.abs(di)}
const re=Float32Array.from(refRe,v=>v*960), im=Float32Array.from(refIm,v=>v*960);
const out=RSNeuralWorker.istft(re,im,st.frames,960,480,RSNeuralWorker.vorbisWindow(960),framed.length);
let synthesisMax=0,synthesisMae=0;
for(let i=0;i<x.length;i++){const d=out[i+480]-refY[i+480];synthesisMax=Math.max(synthesisMax,Math.abs(d));synthesisMae+=Math.abs(d)}
console.log(JSON.stringify({frames:st.frames,analysisMax,analysisMae:analysisMae/(2*refRe.length),synthesisMax,synthesisMae:synthesisMae/x.length}));
'''
        run = subprocess.run(["node", "-e", script, str(ROOT), str(tmp)], check=True,
                             capture_output=True, text=True)
    result = json.loads(run.stdout)
    print(json.dumps(result, indent=2))
    if result["frames"] != 27 or result["analysisMax"] > 2e-7 or result["synthesisMax"] > 2e-7:
        print("libDF parity gate failed")
        return 1
    print("official libDF analysis/synthesis parity gate passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
