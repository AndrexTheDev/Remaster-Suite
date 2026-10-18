# DeepFilterNet3 — eingefrorener Upstream-Vertrag

Stand: 18. Oktober 2026

## Gewählte Referenz

Die Browserintegration wird auf den offiziellen ONNX-Export im Repository
[`Rikorose/DeepFilterNet`](https://github.com/Rikorose/DeepFilterNet) festgelegt:

- Upstream-Commit: `d375b2d8309e0935d165700c91da9de862a99c31`
- Archiv: `models/DeepFilterNet3_onnx.tar.gz`
- Lizenz: wahlweise MIT oder Apache-2.0
- maschinenlesbarer Lock: [`models/sources/deepfilternet3.json`](../models/sources/deepfilternet3.json)

Die drei Graphen wurden direkt aus diesem Archiv extrahiert und mit einem ONNX-Parser untersucht.
Die drei offiziellen Graphen werden unter `models/deepfilternet3/` mit den beiden Upstream-Lizenzen
mitgeliefert. `models/manifest.json` und der Source Lock frieren Quelle, Größen, Hashes und
Graphgrenzen ein; Tests hashen die tatsächlich ausgelieferten Bytes erneut.

## Entscheidende Korrektur

Der offizielle DeepFilterNet3-Export ist **kein einzelner Graph** namens `deepfilter.onnx`. Er besteht
aus drei zusammengehörigen Graphen:

| Rolle | Datei | Größe | Eingänge | Ausgänge |
| --- | --- | ---: | --- | --- |
| Encoder | `enc.onnx` | 1,954,042 B | `feat_erb`, `feat_spec` | `e0`, `e1`, `e2`, `e3`, `emb`, `c0`, `lsnr` |
| ERB-Decoder | `erb_dec.onnx` | 3,292,397 B | `emb`, `e3`, `e2`, `e1`, `e0` | `m` |
| Deep-Filter-Decoder | `df_dec.onnx` | 3,340,803 B | `emb`, `c0` | `coefs`, `235` |

Daraus folgt zwingend:

1. Der Modellmanager muss eine Variante als atomare **Artefaktgruppe** installieren.
2. Der Worker muss drei ORT-Sessions mit demselben Provider erzeugen.
3. Encoder-Ausgaben werden ohne JS-Neuinterpretation an beide Decoder weitergereicht.
4. Die ERB-Maske `m` ist nur ein Teil des Ergebnisses. Für echte DeepFilterNet3-Kompatibilität müssen
   auch `coefs` angewandt werden. Der zusätzliche skalare Graphausgang ist im eingefrorenen
   DeepFilterNet3-Forward-Pfad **kein** Mischfaktor und darf nicht als solcher interpretiert werden.
5. Ein Adapter, der nur `feat_erb`/`feat_spec` in einen erfundenen monolithischen Graphen gibt und
   nur eine ERB-Maske auswertet, darf nicht als vollständige DeepFilterNet3-Integration gelten.

## DSP-Vertrag

Aus `config.ini` des gewählten Exports:

- Abtastrate: 48 kHz
- FFT: 960 Samples
- Hop: 480 Samples
- ERB-Bänder: 32
- lineare DF-Bins: 96
- DF-Ordnung: 5
- DF-Lookahead: 2 Frames
- Convolution-Lookahead: 2 Frames
- minimale ERB-Binbreite: 2
- Normalisierungszeitkonstante: 1 s
- lokaler SNR-Bereich: −15 bis +35 dB

## Nächste Implementationsschritte

- [x] Manifest-Schema von Einzeldatei auf atomare Artefaktgruppen erweitern.
- [x] Download, Hashprüfung, In-Memory-Staging, Promotion und Rollback für alle drei Dateien gemeinsam ausführen.
- [x] Worker-Sessiongruppe einführen und jeden Graphvertrag separat prüfen.
- [x] Offizielle Feature-Normalisierung aus der Referenzimplementierung portieren.
- [x] Encoder → ERB-Decoder/DF-Decoder verdrahten.
- [x] ERB-Maske und komplexe Deep-Filter-Koeffizienten vollständig anwenden.
- [x] Exaktes libDF-ERB-Binning einschließlich Minimum-Breite, Overflow-Carry und 481-Bin-Korrektur portieren.
- [x] Die libDF-Verzögerungskompensation mit initialem Null-Hop und abschließendem 960-Sample-Flush nachbilden.
- [x] Deterministischen Golden-Hash für normalisierte Features und vollständiges ORT/WASM-PCM einfrieren.
- [x] Aktive Browser-Inferenz mit der hashfixierten Wailing-Wailers-Musikdatei durch das Safety Gate führen.
- [ ] Diese Goldens zusätzlich byteweise gegen den offiziellen Python/Rust-Pfad abgleichen.
- [x] Reproduzierbaren QInt8-Kandidatenlauf bereitstellen und ungeeignete Kandidaten nicht publizieren. Der erste dynamische ORT-Lauf quantisiert nur Nebenpfade, vergrößert die Gruppe und bleibt deshalb gesperrt.
- [ ] Einen tatsächlich kleineren INT8-Export erzeugen und gegen FP32 sowie die Realmusik-Fixture qualifizieren.

Dieser Vertrag ersetzt die bisherige Annahme eines monolithischen DeepFilterNet3-Modells als
technische Zieldefinition. Die Dreifach-Pipeline ist mit realen Gewichten in Node/WASM und Chromium/WASM
aktiv getestet; der sichere Fallback bleibt für fehlende Gewichte, Vertragsfehler und Hardwaregrenzen erhalten.
