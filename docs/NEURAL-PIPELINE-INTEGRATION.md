# Neuronale Pipeline: Integrationsaudit und belastbarer Ausbauplan

Stand: 18. Oktober 2026

## Kurzfazit

Die Architektur ist für eine optionale Browser-Inferenz bereits gut vorbereitet: dedizierter Worker, OPFS-Modellspeicher, WebGPU/WebNN/WASM-Fallback, Stage 0 vor der DSP-Kette, saubere Rückfallwerte und umfangreiche synthetische Tests. **Die neuronale Pipeline ist jedoch noch nicht als Ende-zu-Ende-Funktion auslieferbar**, weil die entscheidenden Artefakte und Verträge fehlen:

1. Der tote `@models`-Kanal wurde entfernt; der Standard ist jetzt das mitgelieferte Same-Origin-Verzeichnis `models/`.
2. Der offizielle DeepFilterNet3-Dreifachgraph ist mit Manifest, Hash, Größe, Lizenz und Upstream-Commit ausgeliefert; deterministische Feature- und PCM-Golden-Hashes sind eingefroren; der direkte Vergleich zur Python/Rust-Referenz fehlt noch.
3. Ein echter ORT/WASM-Test lädt und inferiert alle drei ausgelieferten Graphen. Download, OPFS, Worker und vollständige PCM-Inferenz sind jetzt in echtem Chromium automatisiert; offen bleibt der Audiovergleich zur Upstream-Referenz.
4. Die drei Modelladapter setzen sehr konkrete Tensorverträge voraus. Dateinamen allein beweisen keine Kompatibilität. Besonders BS-RoFormer-Exporte haben häufig feste Zeitachsen bzw. andere STFT-Verträge; DeepFilterNet-Exporte können Zustands- und Zusatz-Tensoren verlangen.
5. `audiosr_lite.onnx` ist im Projekt kein veröffentlichtes, reproduzierbar erzeugtes Artefakt. Ohne ein solches Modell bleibt Stage 7 ein vorbereiteter Adapter, keine installierbare Funktion.

Die wichtigste Konsequenz: Nicht mehr Modellfamilien anbinden, bevor **ein** Modell (DeepFilterNet Stage 0) mit reproduzierbarem Export, echtem Browser-E2E-Test und Qualitätsgates vollständig geschlossen ist.

---

## 1. Ist-Zustand

### Bereits sinnvoll integriert

- Inferenz läuft in `neural-worker.js`, nicht im AudioWorklet und damit nicht im Echtzeit-Audiothread.
- `neural-controller.js` löst Fehler als `{applied:false, reason}` auf; die DSP-Kette bleibt funktionsfähig.
- Stage 0 sitzt korrekt vor der restaurierenden DSP-Kette.
- Lange Audiodateien werden abschnittsweise verarbeitet; Überlappung und Crossfade vermeiden harte Nähte.
- OPFS trennt persistente Modelle von temporären Renderdateien.
- Modell-Downloads werden gestreamt; Teil-Downloads werden verworfen.
- WebGPU, WebNN und WASM-SIMD sind als Ausführungspfade vorgesehen.
- Hardwarefehler, Timeout und fehlende Gewichte führen nicht zu beschädigtem oder halb verarbeitetem Audio.
- Das reine DSP-Ergebnis bleibt der verbindliche Fallback.

### Was die vorhandenen Tests tatsächlich beweisen

Die Tests beweisen Steuerfluss, Mathematik, Fehlerverhalten, Provider-Reihenfolge, Cache und simulierte Tensorantworten. Das ist wertvoll, beweist aber nicht:

- dass ein reales Modell geladen werden kann,
- dass seine Input- und Output-Namen stimmen,
- dass dynamische Dimensionen auf allen Execution Providern funktionieren,
- dass Quantisierung die erwartete Audioqualität erhält,
- dass WASM-Hilfsdateien und Worker-CSP in einer echten Bereitstellung funktionieren,
- dass das Ergebnis auf realem Audiomaterial besser ist.

Diese Unterscheidung muss in UI, README und Releasekriterien erhalten bleiben.

---

## 2. Sofortige Blocker

### P0.1 – Modellkanal ist nicht veröffentlichbar

Der Default lautet:

```text
https://cdn.jsdelivr.net/gh/AndrexTheDev/Remaster-Suite@models
```

Im GitHub-Repository existiert gegenwärtig weder ein Branch noch ein Tag `models`. Ein erstmaliges Aktivieren kann deshalb trotz sichtbarer Download-Funktion kein Modell beziehen.

**Lösung:** versionierte Modell-Releases oder ein tatsächlich gepflegter, unveränderlicher Modell-Tag. Produktionscode darf niemals einem beweglichen Branch vertrauen. Empfohlen:

```text
.../Remaster-Suite@models-v1/manifest.json
.../Remaster-Suite@models-v1/deepfilternet3/deepfilternet3_int8.onnx
```

Noch besser: GitHub Release Assets oder ein eigener statischer Modell-Origin mit CORS, Range Requests und unveränderlichen URLs. Große Dateien gehören nicht in den Hauptbranch.

### P0.2 – Ein Manifest fehlt

`MODEL_FILES` enthält nur erwartete Dateinamen. Benötigt wird pro Artefakt mindestens:

```json
{
  "schema": 1,
  "model": "deepfilternet3",
  "version": "1.0.0",
  "file": "deepfilternet3_int8.onnx",
  "bytes": 0,
  "sha256": "...",
  "license": "...",
  "sampleRate": 48000,
  "inputs": [{"name": "feat_erb", "dtype": "float32", "shape": [1,1,"T",32]}],
  "outputs": [],
  "ort": {"min": "1.20.1", "maxTested": "1.20.1"},
  "providersTested": ["wasm", "webgpu"]
}
```

Der Loader muss vor dem Publizieren in OPFS Byteanzahl **und SHA-256** prüfen. `Content-Length` und eine HTML-Prüfung schützen nicht gegen beschädigte, vertauschte oder kompromittierte Gewichte.

### P0.3 – Reale Tensorverträge sind nicht eingefroren

Jeder Adapter braucht einen kanonischen Modellvertrag:

- exakte Input-/Output-Namen,
- Datentypen,
- statische und dynamische Dimensionen,
- Kanalreihenfolge,
- STFT-Fenster, Padding, Centering und Normierung,
- Lookahead und algorithmische Latenz,
- Modellzustände zwischen Blöcken,
- erwarteter Wertebereich,
- Quantisierungsparameter.

`session.inputNames`, `session.outputNames` und Metadaten müssen beim Start validiert werden. Eine Abweichung muss `model-contract-mismatch` liefern, nicht erst während `session.run()` als allgemeiner Inferenzfehler erscheinen.

### P0.4 – Kein echter Ende-zu-Ende-Test

Mindestens ein kleines, rechtlich redistribuierbares ONNX-Testmodell muss in Test-Fixtures verfügbar sein. Es muss folgende reale Kette durchlaufen:

```text
HTTP-Download → Hashprüfung → OPFS → Worker → ORT/WASM → Session →
Tensoradapter → Stage 0 → DSP → Export → erneute Messung
```

Zusätzlich gehört ein separater, optionaler Modell-Release-Test in CI, der die großen Produktionsgewichte herunterlädt. Der normale Repository-Test muss klein bleiben.

---

## 3. Integrationsmöglichkeiten

## A. Lokale On-Device-Inferenz – empfohlen

### A1. ONNX Runtime Web

Passt am besten zur bestehenden Architektur und erlaubt WebGPU, WebNN und WASM aus einem Modellformat.

**Vorteile:** vorhandener Adapter, mehrere Provider, keine Audio-Uploads, gute Fallbackfähigkeit.  
**Risiken:** Bundle-/WASM-Auslieferung, Operatorabdeckung, Browser-/Treiberabweichungen, hoher Speicherbedarf.  
**Empfehlung:** ORT-Version pinnen und Runtime plus WASM-Hilfsdateien selbst hosten. CDN nur als expliziter Fallback. Das macht Offlinebetrieb, CSP, Datenschutz und reproduzierbare Releases belastbar.

### A2. WebNN

Interessant für NPU/GPU auf mobilen Geräten, aber nicht als alleiniger Pfad. Operatorunterstützung und Browserabdeckung bleiben modellabhängig.

**Empfehlung:** WebNN nur nach einem echten Session-Smoke-Test als verfügbar melden. Capability Detection allein genügt nicht. Providerentscheidung pro Modell cachen und im Diagnosebericht ausgeben.

### A3. WebGPU

Voraussichtlich schnellster breit nutzbarer Browserpfad für kompatible Netze.

**Empfehlung:** Grenzwerte des Adapters (`maxBufferSize`, `maxStorageBufferBindingSize`) gegen Modell- und Chunkbedarf prüfen; Chunkgröße daraus ableiten statt nur aus User-Agent. Bei Device Loss einmal auf WASM zurückfallen, nicht erneut denselben GPU-Pfad versuchen.

### A4. WASM-SIMD/Threads

Der zuverlässigste Kompatibilitätspfad.

**Voraussetzung:** Threads benötigen Cross-Origin Isolation. Ohne Isolation muss `numThreads=1` gelten. Die Runtime-WASM-Dateien müssen mit korrektem MIME-Type und derselben gepinnten ORT-Version ausgeliefert werden.

### A5. WebAssembly-Modellruntime ohne ORT

Möglich über projektspezifische Rust/C++-Inference oder Modell-eigene Runtime (beispielsweise DeepFilterNet-nahe DSP-/Inference-Bindings).

**Wann sinnvoll:** wenn der ONNX-Graph auf Browserprovidern nicht stabil läuft oder ein nativer Streaming-Zustand wesentlich effizienter ist.  
**Nachteil:** höherer Wartungsaufwand, weitere Toolchain, weniger austauschbare Modelle.

## B. Serverinferenz – nur als anderes Produkt-/Datenschutzmodell

Ein Server kann große Separation- oder Diffusionsmodelle betreiben, widerspricht aber dem Kernversprechen „Audio verlässt das Gerät nicht“.

Falls jemals angeboten, muss es ein separater, ausdrücklicher Modus sein: Opt-in, Verschlüsselung, Löschfristen, Region, Kosten-/Quotenanzeige und kein stiller Fallback vom lokalen Modell zum Server.

## C. Native Begleit-App / lokaler Dienst

Eine Desktop-App oder ein lokaler Daemon könnte CUDA/Metal/CoreML/DirectML verwenden und der Weboberfläche lokal dienen.

**Vorteil:** größere Modelle, besseres Hardwaremanagement.  
**Nachteil:** Installation, Signierung, Updates, lokale API-Sicherheit.  
**Einordnung:** gute Pro-Option, aber nicht Teil der statischen Browser-App.

## D. Hybrid DSP + kleines Netz – für dieses Projekt besonders passend

Das Netz schätzt nur Masken, Störpegel, Defektwahrscheinlichkeiten oder eine begrenzte Korrekturkurve; die bestehende DSP-Kette erzeugt das Audio.

**Vorteile:** kleine Modelle, interpretierbar, clampbar, geringere Artefaktgefahr, leichter A/B-testbar.  
**Empfehlung:** Stage 7 genau in diese Richtung weiterentwickeln, aber nicht unter dem Namen AudioSR, solange kein reproduzierbares Modellartefakt existiert. Ein eigener Name wie „Neural Air Guide“ ist technisch ehrlicher.

---

## 4. Empfohlene Modellstrategie

### Phase 1 – nur DeepFilterNet Stage 0 produktionsreif machen

1. Ein bestimmtes Upstream-Modell und dessen Lizenz auswählen.
2. Exportskript samt Commit, Python-Abhängigkeiten und Opset einchecken.
3. FP32-Referenz exportieren.
4. INT8 nur nach objektivem Vergleich freigeben; INT4 nicht allein wegen kleinerer Dateigröße anbieten.
5. Golden Fixtures mit erwarteten Tensoren und Audiosummen erzeugen.
6. Manifest signieren bzw. mindestens SHA-256 pinnen.
7. Auf Chrome/Edge WebGPU, WASM Single-Thread, WASM Threads sowie unterstütztem WebNN testen.
8. Erst dann den UI-Download standardmäßig aktivieren.

### Phase 2 – intelligente Qualitätssteuerung

- Neuralen Anteil anhand gemessener Störung dosieren, nicht pauschal einschalten.
- SNR-/Artefakt-Detektor vor und nach Stage 0 laufen lassen.
- Ergebnis verwerfen, wenn Pegel, DC, NaN/Inf, Kanalzahl, Länge oder Qualitätsmetriken unplausibel sind.
- Mid/Side-Kohärenz und Transientenverlust prüfen.
- Denoiser und DSP-Dehisser nicht nur über einen festen Faktor 0,35 koppeln; den verbleibenden Rauschboden nach Stage 0 neu messen und den DSP-Rest daraus ableiten.

### Phase 3 – Separation nur als eigener Modus

BS-RoFormer ist keine normale Rauschunterdrückung. Stem-Auswahl verändert den musikalischen Inhalt und darf nicht unbemerkt Bestandteil von „Magic Fix“ werden.

Erforderlich sind:

- explizite UI für Stems,
- feste Segmentlänge gemäß Exportvertrag,
- Overlap/Add auf Spektrogramm- oder Waveformebene,
- Stereo- und Phasentests,
- großer Speicher-/Zeit-Hinweis,
- separate Exportnamen und Metadaten.

### Phase 4 – Bandbreitenerweiterung

Drei realistische Wege:

1. **Kleines Kurven-/Maskennetz**: beste Passung zur existierenden AirSynth-Stufe.
2. **Direktes BWE-Netz**: bessere Rekonstruktion möglich, aber strengere Artefakt-, Phasen- und Halluzinationskontrolle nötig.
3. **Großes AudioSR/Diffusionsmodell**: im Browser für dieses Produkt derzeit keine sinnvolle Standardoption; eher Server oder native Pro-App.

---

## 5. Audio- und Chunking-Details

### Zustände über Chunkgrenzen

Ein zustandsbehaftetes Modell darf nicht für jeden Ein-Sekunden-Block vollständig zurückgesetzt werden. Falls der gewählte DeepFilterNet-Export rekurrente Zustände nutzt, müssen diese zwischen fortlaufenden Blöcken weitergereicht und nur an echten Dateigrenzen gelöscht werden. Kontext plus Crossfade kaschiert Nähte, ersetzt aber keinen korrekten Modellzustand.

### Latenz und Alignment

- Modell-Lookahead und STFT-Centering müssen als Samples dokumentiert werden.
- Ausgabe muss vor dem Crossfade auf die ursprüngliche Zeitachse zurückverschoben werden.
- Resampling 44,1 ↔ 48 kHz benötigt einen Impuls-/Phasentest, nicht nur einen Pegeltest.
- Bei Stereo darf unabhängige Kanalinferenz die Stereomitte nicht wandern lassen. Besser sind Stereo-Modell, Mid/Side-Verarbeitung oder gekoppelte Masken.

### Chunkgröße adaptiv wählen

Nicht User-Agent, sondern ein Laufzeitbudget sollte entscheiden:

```text
min(Modellmaximum, Speicherbudget, Providerlimit, thermisches Zeitbudget)
```

Ein kurzer Warm-up-Block kann Durchsatz und Peak-Speicher schätzen. Danach Chunkgröße verkleinern oder den Provider wechseln.

### Abbruch

Controller und Worker brauchen echte Cancellation:

- `AbortSignal` vom Renderauftrag bis Download und Inferenz,
- Worker-Anfrage abbrechen bzw. Worker bei hartem Abbruch ersetzen,
- OPFS-Teildatei entfernen,
- keine zwei Minuten wartende Altanfrage nach Nutzerabbruch.

---

## 6. Sicherheit, Datenschutz und Lieferkette

1. Runtime und Modelle versionieren und hashen.
2. Modelllizenz und Upstream-Commit im UI/NOTICE ausweisen.
3. Keine beliebige benutzerdefinierte Modell-URL ohne Warnung; sie ist aktiver Input für eine komplexe Runtime.
4. Maximale Modellgröße vor Download und vor ArrayBuffer-Allokation prüfen.
5. ONNX-Metadaten und Tensorgrößen vor Inferenz validieren, um Speicherexplosionen zu vermeiden.
6. CSP für `worker-src`, `connect-src` und ggf. `script-src` dokumentieren.
7. Telemetrie nur lokal aggregieren; keine Audiodaten oder Dateinamen senden.
8. OPFS-Modellverwaltung anbieten: belegter Speicher, Version, Löschen, Aktualisieren.
9. Updates atomar schreiben: neue Version prüfen, dann aktiv schalten; alte funktionierende Version bis dahin behalten.

---

## 7. UX

- Schalter nicht als verfügbar darstellen, wenn nur ein Download *theoretisch* möglich ist. Vorher Manifest abrufen und Kompatibilität prüfen.
- Downloadgröße, geschätzten Speicher und erwarteten Provider vor Zustimmung anzeigen.
- Zustände unterscheiden: „nicht installiert“, „wird geladen“, „bereit“, „inkompatibles Modell“, „Hardware zu klein“, „DSP-Fallback“.
- A/B/C muss pegelgematcht und blind umschaltbar bleiben.
- Pro Datei ausweisen, ob Neural wirklich angewandt wurde, mit Modellversion und Provider.
- Batch-Export nach erstem Hardwarefehler wahlweise komplett auf DSP fixieren, statt pro Datei erneut einen aussichtslosen Modellstart zu versuchen.
- Nutzer müssen Modellcache löschen und neuronale Verarbeitung pro Export deaktivieren können.

---

## 8. Qualitäts- und Releasegates

### Funktional

- Reales Modell läuft über Download, OPFS und Worker.
- Offline-Neustart funktioniert aus OPFS.
- Beschädigtes Modell wird anhand Hash verworfen.
- Providerwechsel erzeugt dieselbe Länge und begrenzte numerische Abweichung.
- Abbruch hinterlässt weder Pending Promise noch Teilmodell.

### Audioqualität

Mindestens messen:

- SI-SDR/SDR-Verbesserung auf bekannten Mischungen,
- DNSMOS oder vergleichbare wahrnehmungsnahe Metrik, falls Lizenz und Reproduzierbarkeit passen,
- Musik-/Transientenerhalt,
- Spektralneigung und Hochtonverlust,
- Stereo-Korrelation und Mono-Kompatibilität,
- Seam-Energie an jeder Chunkgrenze,
- Loudness-/True-Peak-Differenz,
- Halluzinationsrate auf sauberem Material und Stille.

Ein Modell darf nur angewandt werden, wenn es auf einem Holdout-Satz nicht schlechter als DSP allein ist. Sauberes Material ist ein zentrales Negativ-Gate.

### Leistung

Matrix aus:

- 2/4/8 GB Geräteklasse,
- mobil/desktop,
- WebGPU/WebNN/WASM,
- 44,1/48/96 kHz,
- mono/stereo,
- 1 min/10 min/Albumlänge.

Erfassen: Download, Sessionstart, Real-Time-Faktor, Peak-Heap, OPFS, GPU-Speicher soweit messbar, thermische Drosselung und Akkuverbrauch.

---

## 9. Konkrete Umsetzung in Prioritätsreihenfolge

### P0 – vor jeder öffentlichen Neural-Freigabe

- [x] Reales DeepFilterNet-Artefakt und Lizenz festlegen.
- [ ] Reproduzierbares Export-/Quantisierungsskript hinzufügen.
- [x] Versioniertes Manifest mit SHA-256 einführen.
- [x] Same-Origin-Modellverzeichnis veröffentlichen; toten `@models`-Default entfernen.
- [x] Modellvertrag beim Sessionstart prüfen.
- [x] Echten ORT/WASM-E2E bis zu endlichem, längengenauem PCM in Node und Chromium einschließlich Manifest/OPFS/Worker hinzufügen.
- [x] ONNX Runtime Web 1.20.1 und benötigte JSEP-WASM-Sidecars selbst hosten; CDN nur als Rescue Mirror.

### P1 – Robustheit

- [x] AbortSignal durch Download, atomare Installation, Controller, laufende ORT-Ausführung und Render führen; Worker-Neustarts lösen kollaterale wartende Aufträge explizit als `worker-restarted` auf.
- [x] Direkte Denoiser-Eingaben vor STFT-/Tensorallokation begrenzen; Stage 0 bleibt zusätzlich chunk-basiert.
- [x] Provider-Fallback innerhalb desselben Auftrags implementieren: Accelerator-Sessions freigeben und denselben Chunk einmal über WASM wiederholen.
- [ ] Modellzustände über Chunks führen, falls der Export sie besitzt.
- [x] Nach Stage 0 neu analysieren und DSP-Dehiss aus gemessener SNR-Verbesserung adaptiv dosieren; 15-%-Sicherheitsnetz und voller DSP-Fallback bleiben erhalten.
- [x] Modellcache-Verwaltung in der UI ergänzen: Variante, Größe, Version, Lizenz und Updates anzeigen; bestätigtes Löschen entfernt Gewichte und Provenienz und ist während Render/Download gesperrt.

### P2 – Qualität und Geräteabdeckung

- [ ] Realgeräte-Browsermatrix automatisieren. Chromium deckt Desktop sowie emulierte Android-/iPhone-Mobile-Profile mit echter ORT/WASM-Inferenz ab; physische Safari-/Android-Geräte, Thermik und Akku bleiben offen.
- [x] Reale Wailing-Wailers-MP3 als hash-gepinnte objektive Fixture mit Decode- und Problembaseline versionieren; Hörtest-Protokoll bleibt manuell.
- [x] Adaptive Chunkgröße aus Warm-up-/Span-Telemetrie implementieren: 0,25–2 s, Hysterese, graduelle Änderung und expliziter Override.
- [x] Identische Stereokanäle über Neural-Chunks und Crossfades samplegenau gekoppelt validieren; weitere Realmusik-Kohärenzmetriken bleiben Teil der Geräteprüfung.
- [ ] INT4 nur bei bestandenem Qualitätsgate veröffentlichen.

### P3 – weitere Funktionen

- [ ] BS-RoFormer als separaten Stem-Workflow bauen.
- [ ] Eigenes kleines Neural-Air-Guide-Modell trainieren/exportieren.
- [ ] Native/Server-Pro-Option ausschließlich als klar getrennten Modus evaluieren.

---

## 10. Definition of Done

Die Pipeline ist erst „perfekt integriert“, wenn alle folgenden Aussagen gleichzeitig wahr sind:

1. Ein frischer Nutzer kann das Modell erfolgreich installieren.
2. Jede installierte Datei ist versioniert, lizenziert und kryptografisch geprüft.
3. Mindestens ein reales Modell wird im CI durch die vollständige Browserpipeline getestet.
4. Dasselbe Modell funktioniert auf mindestens WebGPU und WASM; WebNN ist ein Bonus, kein Versprechen.
5. Fehlende oder inkompatible Hardware erzeugt bitidentischen DSP-Fallback ohne Hänger.
6. Chunkgrenzen, Resampling, Latenz und Stereo bleiben messtechnisch sauber.
7. Ein Qualitätsgate kann ein neuronales Ergebnis verwerfen.
8. UI und Exportbericht sagen wahrheitsgemäß, ob, womit und wie Neural angewandt wurde.
9. Download, Inferenz und Cache sind abbrechbar und verwaltbar.
10. Reale Hörtests bestätigen einen Vorteil gegenüber DSP allein.

Bis dahin sollte die Funktion als experimentell/optional bezeichnet werden. Die vorhandene Architektur ist eine gute Grundlage; der nächste Engpass ist nicht mehr JavaScript-Steuerlogik, sondern eine **reproduzierbare, lizenzierte und tatsächlich getestete Modelllieferkette**.
