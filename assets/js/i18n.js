/* =============================================================================
 * Remaster Suite — bilingual UI text (DE / EN)
 * -----------------------------------------------------------------------------
 * Every visible word of the application comes from here: labels, hints, tooltips,
 * the plain-language diagnosis, status pills, error messages and the legal
 * overlays. HTML strings are marked with `html: true` and are only ever assigned
 * to `[data-i18n-html]` nodes by us — never from user input.
 *
 * Usage
 *   RSi18n.t('ctl.power')                    → "Restaurationskraft"
 *   RSi18n.t('meta.line', {d:'3:12', ...})   → "3:12 · Stereo · 44,1 kHz · 7,2 MB"
 *   RSi18n.setLang('en')                     → re-applies every [data-i18n*]
 * ========================================================================== */
(function (global) {
  'use strict';

  const DICT = {
    /* --------------------------------------------------------------- German */
    de: {
      'brand.name': 'Harmonic Restoration',
      'brand.sub': 'Remaster Suite',
      'a11y.skip': 'Zum Hochladen springen',
      'a11y.help': 'Hilfe öffnen',
      'a11y.dropzone': 'Audiodateien zum Reparieren ablegen',
      'nav.help': 'Hilfe',
      'hero.title': 'Alte Aufnahmen klingen wieder neu.',
      'hero.sub': 'Ziehe eine Aufnahme hinein — die Suite hört zu, erkennt das Problem und repariert es mit einem Klick. Alles bleibt auf deinem Gerät.',
      'steps.1': 'Datei ablegen',
      'steps.2': 'Automatisch prüfen',
      'steps.3': 'Vergleichen & speichern',
      'drop.title': 'Audiodateien hier ablegen',
      'drop.hint': '… oder klicken und auswählen. Mehrere Dateien auf einmal sind erlaubt.',
      'drop.titleTouch': 'Audiodateien auswählen',
      'drop.hintTouch': 'Tippe hier und wähle eine oder mehrere Dateien. Alles bleibt auf deinem Gerät.',
      'drop.button': 'Dateien auswählen',
      'drop.formats': 'MP3 · WAV · FLAC · OGG · M4A/AAC — ohne Größenlimit, ohne Upload',
      'drop.privacy': 'Null Upload, null Konto, null Kosten. Deine Dateien verlassen dieses Gerät nicht.',

      'ctl.power': 'Restaurationskraft',
      'ctl.powerHint': 'Ein Regler für alles. 0 % = Original, 100 % = maximal repariert.',
      'ctl.profile': 'Klangprofil',
      'ctl.listen': 'Anhören',
      'ctl.original': 'Original',
      'ctl.restored': 'Repariert',
      'ctl.compare': 'A/B',
      'ctl.compareHint': 'Wechselt automatisch alle 4 Sekunden zwischen Original und Repariert',
      'ctl.processAll': 'Alle verarbeiten',
      'ctl.zip': 'ZIP herunterladen',
      'ctl.clear': 'Liste leeren',
      'ctl.export': 'Export',

      'preset.auto': 'Automatisch (empfohlen)',
      'preset.garage': 'Garage / Ein-Mikrofon (60er/70er)',
      'preset.vinyl': 'Vinyl-Rip reparieren',
      'preset.cassette': 'Kassette ent-rauschen',
      'preset.lowbitrate': 'Niedrige Bitrate aufhellen',
      'preset.general': 'Allgemeine Politur',
      'preset.auto.short': 'Automatik',

      'list.title': 'Deine Dateien',
      'feat.engine.t': 'Was hier wirklich passiert',
      'feat.engine.b': 'Echtes DSP in Echtzeit: Obertonsynthese bis 16 kHz, Sub-Bass bis 30 Hz, Ent-Rauschen, Ent-Knacksen und ein dynamischer Resonanz-Tilger — berechnet auf deinem Gerät, nicht in einer Cloud.',
      'feat.privacy.t': 'Privat by design',
      'feat.privacy.b': 'Es gibt keinen Server. Keine Uploads, keine Cookies, kein Tracking, keine Analyse-Tools. Schließe den Tab — alles ist weg.',
      'feat.free.t': 'Kostenlos & offen',
      'feat.free.b': 'Statisches HTML, CSS und JavaScript — läuft auf GitHub Pages, ohne Build, ohne Abo. Der Quellcode ist frei einsehbar.',
      'feat.batch.t': 'Stapelverarbeitung',
      'feat.batch.b': 'Beliebig viele Dateien auf einmal — eine nach der anderen, damit dein Speicher atmet. Am Ende ein ZIP mit allen Ergebnissen.',

      'foot.support': 'Freiwillig unterstützen',
      'foot.supportHint': 'Die Suite bleibt für immer kostenlos. Wenn sie dir Arbeit abnimmt, freue ich mich über eine Krypto-Spende — ein Klick kopiert die Adresse.',
      'foot.donateLegal': 'Spenden sind freiwillig und kein Kauf: Es entsteht kein Anspruch auf Leistung.',
      'foot.developedBy': 'Entwickelt von',
      'foot.localOnly': 'Diese Anwendung arbeitet zu 100 % in deinem Browser. Es werden keine Audiodaten übertragen.',

      'legal.terms': 'AGB',
      'legal.privacy': 'Datenschutz',
      'legal.contact': 'Kontakt',
      'legal.about': 'Über & Quellen',
      'ui.close': 'Schließen',
      'ui.percent': '{v} %',

      'card.remove': 'Datei entfernen',
      'card.waveAria': 'Wellenform-Vergleich Original und Repariert',
      'card.legendOriginal': 'Original',
      'card.legendRestored': 'Repariert',
      'card.analyzing': 'Analyse läuft …',
      'card.profile': 'Klangprofil',
      'card.power': 'Kraft für diese Datei',
      'card.listen': 'Vergleichen',
      'card.save': 'Speichern',
      'card.saveFile': 'Fertig – speichern',
      'card.retry': 'Nochmal verarbeiten',
      'card.loop': 'Loop',
      'card.loopHint': 'Nur die Vorschau in Dauerschleife abspielen',
      'card.window': 'Vorschau: Sekunde {a}–{b}',
      'work.aria': 'Fortschritt',
      'card.play': 'Abspielen',
      'card.pause': 'Pause',
      'meta.line': '{dur} · {ch} · {sr} · {size}',

      'status.queued': 'In Warteschlange',
      'status.analyzing': 'Hört zu …',
      'status.ready': 'Bereit',
      'status.processing': 'Repariert …',
      'status.rendering': 'Rendert {p} %',
      'status.done': 'Fertig',
      'status.error': 'Fehler',
      'status.export': 'Speichert …',
      'work.decode': 'Datei wird gelesen …',
      'work.analyze': 'Klang wird vermessen …',
      'work.diagnose': 'Klangprofil wird bestimmt …',
      'work.window': 'Vorschau-Stelle wird gesucht …',
      'work.envelope': 'Wellenform wird aufbereitet …',
      'work.preview': 'Vorschau wird gerechnet …',
      'work.render': 'Aufnahme wird repariert …',
      'work.encode': 'Datei wird geschrieben …',
      'work.zip': 'ZIP wird gepackt …',
      'work.wait': 'Warteschlange …',
      'work.eta': 'noch ~{s} s',
      'work.etaMin': 'noch ~{m} min',
      'job.file': 'Datei {i} von {n}: {name}',

      'kind.garage': 'Garage- bzw. Ein-Mikrofon-Aufnahme der 60er/70er',
      'kind.vinyl': 'Vinyl-Rip mit Knacksen und Rauschen',
      'kind.cassette': 'Kassettenaufnahme mit Bandrauschen',
      'kind.lowbitrate': 'stark komprimierte Aufnahme mit dumpfem Höhenbild',
      'kind.general': 'Aufnahme, die eine sanfte Politur braucht',
      'kind.healthy': 'gut klingende Aufnahme',
      'diag.lead': 'Klingt nach: <strong>{kind}</strong>.',
      'diag.issues': ' Auffällig: {issues}.',
      'diag.confident': ' (Erkennung: {p} % sicher)',
      'diag.clean': ' Hier ist nichts zu retten — nur Feinschliff.',

      'issue.weakBass': 'wenig Tiefbass',
      'issue.boxyMids': 'boxige Mitten',
      'issue.dullTop': 'dumpfe Höhen',
      'issue.hiss': 'Bandrauschen',
      'issue.crackle': 'Knacksen',
      'issue.hum': 'Netzbrummen',
      'issue.codec': 'abgeschnittene Höhen (Codec)',
      'issue.harsh': 'scharfe Höhen',
      'issue.clipping': 'Übersteuerung',
      'issue.squashed': 'kaum Dynamik',
      'issue.narrow': 'fast Mono',
      'issue.healthy': 'keine größeren Schwächen',

      'chip.score': 'Klang-Qualität',
      'chip.peak': 'Spitze',
      'chip.hf': 'Höhen bis',
      'chip.noise': 'Rauschteppich',
      'chip.dynamics': 'Dynamik',
      'chip.width': 'Stereo',
      'chip.clip': 'Clipping',

      'batch.done': 'Alle {n} Dateien sind fertig.',

      'note.done': 'Fertig. „{fmt}“ speichern legt die Datei auf deinem Gerät ab.',
      'note.realtime': 'Vorschau in Echtzeit (kein Warten). Die volle Datei entsteht beim Speichern.',
      'note.decode': 'Wird gelesen …',
      'note.analyze': 'Der Klang wird vermessen …',

      'toast.added': '{n} Datei(en) hinzugefügt.',
      'toast.addedOne': 'Hinzugefügt: {name}',
      'toast.noFiles': 'Keine Audiodateien gefunden.',
      'toast.skipped': '{n} Datei(en) übersprungen (zu groß oder nicht lesbar).',
      'toast.copyOk': '{label}-Adresse kopiert.',
      'toast.copyFail': 'Kopieren nicht möglich — bitte Text markieren.',
      'toast.saved': '„{name}“ gespeichert.',
      'toast.zipStart': 'ZIP wird gebaut …',
      'toast.zipDone': 'ZIP mit {n} Datei(en) gespeichert.',
      'toast.zipEmpty': 'Noch keine fertige Datei zum Packen.',
      'toast.zipFail': 'ZIP konnte nicht gebaut werden.',
      'toast.engineFail': 'Audio-Engine konnte nicht gestartet werden.',
      'toast.workletFail': 'Der DSP-Prozessor wurde blockiert. Bitte die Seite über http(s) öffnen (nicht als lokale Datei).',
      'toast.libLocal': 'Bibliotheken: lokale Kopien (keine externen Aufrufe).',
      'toast.libCdn': 'Bibliotheken: CDN aktiviert — dabei wird die CDN-Adresse aufgerufen.',
      'toast.cleared': 'Liste geleert.',
      'toast.tooBig': '„{name}“ ist größer als {mb} MB und wurde übersprungen.',
      'toast.mp3Slow': 'MP3 wird encodiert — das dauert etwas länger als WAV.',
      'toast.needDecode': 'Die Datei ist noch nicht bereit.',
      'toast.renderFail': 'Rendern fehlgeschlagen: {msg}',

      'err.decode': 'Die Datei konnte nicht gelesen werden.',
      'err.broken': 'Diese Datei enthält beschädigte Audiodaten (keine gültigen Samples) — sie lässt sich nicht reparieren.',
      'err.render': 'Das Rendern ist fehlgeschlagen.',

      /* -------------------------------------------------------- German legal */
      'terms.body': `
<p>Diese Bedingungen gelten für die Nutzung von „Harmonic Restoration — Remaster Suite“ (im Folgenden „die Suite“), einer rein im Browser laufenden Web-Anwendung, bereitgestellt von <strong>AndrexTheDev</strong>, Kontakt: <a href="mailto:hippie.highho@gmail.com">hippie.highho@gmail.com</a>.</p>
<h3>§ 1 Leistungsumfang</h3>
<p>Die Suite ist ein kostenloses Werkzeug zur Nachbearbeitung von Audiodateien. Die Verarbeitung findet ausschließlich lokal auf dem Gerät der nutzenden Person statt; es werden keine Dateien übertragen oder gespeichert. Ein Anspruch auf Bereitstellung, Verfügbarkeit oder Weiterentwicklung besteht nicht.</p>
<h3>§ 2 Nutzung und Rechte</h3>
<p>Für die verarbeiteten Dateien ist ausschließlich die nutzende Person verantwortlich. Es dürfen nur Aufnahmen verarbeitet werden, für die die erforderlichen Rechte vorliegen. Die Suite darf nicht genutzt werden, um Urheber- oder Persönlichkeitsrechte zu verletzen oder rechtswidrige Inhalte zu bearbeiten.</p>
<h3>§ 3 Keine Gewährleistung</h3>
<p>Das Ergebnis der Signalverarbeitung hängt vom Ausgangsmaterial ab. Eine bestimmte klangliche Verbesserung, ein bestimmtes Messergebnis oder eine Eignung für einen konkreten Zweck wird nicht zugesagt. Die Suite wird „wie besehen“ bereitgestellt.</p>
<h3>§ 4 Haftung</h3>
<p>Die Haftung für Vorsatz und grobe Fahrlässigkeit sowie nach den zwingenden Vorschriften des Produkthaftungsgesetzes und bei Verletzung von Leben, Körper oder Gesundheit bleibt unberührt. Im Übrigen ist die Haftung für leichte Fahrlässigkeit ausgeschlossen, insbesondere für Datenverlust, entgangenen Gewinn oder mittelbare Schäden. Bearbeite Originale daher immer auf einer Kopie.</p>
<h3>§ 5 Spenden</h3>
<p>Angebotene Krypto-Adressen dienen ausschließlich freiwilligen Zuwendungen. Es handelt sich nicht um einen Kauf, keine Gegenleistung und keine Kapitalanlage. Spenden sind grundsätzlich nicht erstattungsfähig. Angaben zu Spenden sind keine steuerliche Beratung.</p>
<h3>§ 6 Fremdkomponenten</h3>
<p>Die Suite enthält fremde Bibliotheken (unter anderem JSZip unter MIT-Lizenz und lamejs unter LGPL-3.0). Für diese Komponenten gelten die jeweiligen Lizenzen; sie werden unverändert eingebunden und dürfen den Anbieter- und Lizenzhinweisen nicht entnommen werden.</p>
<h3>§ 7 Änderungen, Schlussbestimmungen</h3>
<p>Diese Bedingungen können für künftige Versionen angepasst werden. Es gilt deutsches Recht. Sollten einzelne Bestimmungen unwirksam sein, bleibt der übrige Teil wirksam. Stand: {date}.</p>`,

      'privacy.title': 'Datenschutz',
      'contact.title': 'Kontakt',
      'about.title': 'Über die Suite',
      'help.title': 'So funktioniert es',
      'privacy.body': `
<p><strong>Kurzfassung: Es gibt keinen Server. Deine Audiodateien verlassen dieses Gerät nicht.</strong></p>
<h3>1. Verantwortlich</h3>
<p>AndrexTheDev, Kontakt: <a href="mailto:hippie.highho@gmail.com">hippie.highho@gmail.com</a>.</p>
<h3>2. Verarbeitung der Audiodaten</h3>
<p>Beim Öffnen einer Datei wird sie vom Browser in den Arbeitsspeicher geladen und dort dekodiert, analysiert, bearbeitet und wieder encodiert. Es findet <strong>keine Übertragung, keine Zwischenspeicherung und keine serverseitige Verarbeitung</strong> statt. Beim Schließen oder Neuladen des Tabs verschwinden alle Daten aus dem Speicher. Ein automatisches Herunterladen findet nur statt, wenn du es selbst anklickst.</p>
<h3>3. Keine Cookies, kein Tracking</h3>
<p>Die Suite setzt keine Cookies, kein Local Storage, keine Sitzungskennungen, keine Analyse- oder Werbe-Dienste und keine Social-Media-Plugins ein. Es werden keine Nutzungsprofile gebildet. Für deine Spracheinstellung wird lediglich ein Wert im Arbeitsspeicher des Tabs gehalten.</p>
<h3>4. Externe Verbindungen</h3>
<p>Im Standardbetrieb lädt die Suite <strong>nichts</strong> von außen: Schriften, Symbole und Hilfsbibliotheken liegen bei. Optional kann in „Über & Quellen“ der Bezug der Hilfsbibliothek (JSZip, lamejs, optional FFmpeg.wasm) über ein freies CDN aktiviert werden; dabei würde die IP-Adresse an das CDN übertragen, wie bei jedem normalen Webseitenaufruf. Ohne diese Option entsteht kein externer Aufruf.</p>
<h3>5. Hosting-Aufrufdaten</h3>
<p>Wird die Suite über GitHub Pages aufgerufen, verarbeitet der Hosting-Anbieter technisch notwendige Zugriffsdaten (z. B. IP-Adresse, Zeitpunkt, abgerufene Datei) auf Grundlage berechtigter Interessen (Art. 6 Abs. 1 lit. f DSGVO) zur Auslieferung und Sicherheit. Auf diese Protokolle hat der Anbieter der Suite keinen Zugriff.</p>
<h3>6. Deine Rechte</h3>
<p>Da keine personenbezogenen Daten durch die Suite gespeichert werden, bestehen in der Regel keine Datenbestände, auf die sich Auskunft, Berichtigung, Löschung, Einschränkung, Übertragung oder Widerspruch richten könnten. Anfragen richtest du trotzdem gern an die oben genannte Adresse. Beschwerden sind bei der zuständigen Aufsichtsbehörde möglich.</p>
<h3>7. Kinder, Sicherheit, Änderungen</h3>
<p>Die Suite richtet sich nicht an Kinder und erhebt wissentlich keine Daten von ihnen. Übertragene Daten wären durch TLS geschützt — es werden jedoch keine übertragen. Diese Hinweise können für künftige Versionen angepasst werden. Stand: {date}.</p>`,

      'contact.body': `
<p>Fragen, Fehlerberichte, Klangbeispiele oder ein Wunsch für die nächste Version? Schreib einfach eine Mail:</p>
<p><strong>E-Mail:</strong> <a href="mailto:hippie.highho@gmail.com">hippie.highho@gmail.com</a><br>
<strong>Entwicklung:</strong> AndrexTheDev<br>
<strong>Projekt:</strong> Harmonic Restoration — Remaster Suite (Open Source, GitHub Pages)</p>
<h3>Was hilft bei einer Fehlermeldung</h3>
<ul>
  <li>Welcher Browser und welche Version? (z. B. Chrome 126, Firefox 128, Safari 18)</li>
  <li>Welches Dateiformat und welche Länge hat die Aufnahme?</li>
  <li>Was hast du angeklickt und was ist stattdessen passiert?</li>
  <li>Optional: Screenshot der Entwicklerkonsole (F12).</li>
</ul>
<h3>Unterstützen</h3>
<p>Spenden sind freiwillig und kein Kauf — die Adressen stehen im Fußbereich. Danke für jede Rückmeldung.</p>`,

      'about.body': `
<p><strong>Version 1.4</strong> — eine komplette Audio-Restaurations-Kette im Browser. Alles rechnet auf deinem Gerät.</p>
<h3>Die Kette in Reihenfolge</h3>
<ul>
  <li><strong>Entzerren (EQ):</strong> sechs Bänder, automatisch anhand der Messung dosiert.</li>
  <li><strong>Dynamischer Resonanz-Tilger:</strong> sechs schmale Bänder senken aufschwingende Raumresonanzen ab, ohne die Grundtöne anzutasten.</li>
  <li><strong>Harmonischer Exciter:</strong> erzeugt fehlende Obertöne mit 2. und 3. Ordnung — der Kern der Obertonsynthese.</li>
  <li><strong>Air-Synthese 8–16 kHz:</strong> baut den obersten Bereich aus dem verbliebenen Hochtonanteil auf.</li>
  <li><strong>Sub-Bass 30–60 Hz:</strong> gewinnt die fehlende unterste Oktave über eine Oktav-Teilung mit Mitten-Folgung.</li>
  <li><strong>Ent-Rauschen:</strong> dynamischer Hinweis-Filter in der Höhenlage, der nur zwischen den Tönen zumacht — offen lässt er das Signal unangetastet.</li>
  <li><strong>Ent-Knacksen:</strong> erkennt kurze Nadel- und Digital-Pops und ersetzt sie durch die Vorhersage des Signals.</li>
  <li><strong>Glue-Kompressor, Wärme, Neigung:</strong> Kleben, Sättigung, letzter Feinschliff — mit Pegelanpassung für ein ehrliches A/B.</li>
</ul>
<h3>Technik</h3>
<ul>
  <li>Web Audio API mit <code>AudioWorklet</code> in eigener Datei <code>assets/worklets/remaster-processor.js</code>.</li>
  <li>Ein einziger Echtzeit-Kern: dieselbe Kette läuft für die Vorschau live und für den Export offline (<code>OfflineAudioContext</code>).</li>
  <li>Analyse: 8192-Punkt-FFT, Rauschboden-, Crest- und Clipping-Messung; daraus Klangprofil und Diagnose in normaler Sprache.</li>
  <li>Ausgabe: WAV 16/24/32 Bit ohne Verluste oder MP3 bis 320 kbps über lamejs.</li>
  <li>Fortschritt in zwei Balken: pro Datei mit Stufe und Restzeit, dazu ein Job-Balken über der Liste, der auf dem Handy am unteren Rand andockt.</li>
  <li>Für Handy-Browser gebaut: 44-px-Ziele, keine Hover-Abhängigkeit, sichere Ränder für Notch und Gestenleiste, kleinere Speichergrenze.</li>
  <li>Keine Frameworks, kein Build-Schritt, kein Server — statische Dateien, direkt auf GitHub Pages.</li>
</ul>
<h3>Bibliotheken</h3>
<ul>
  <li><strong>JSZip</strong> (MIT) — ZIP-Export im Browser, eigene, mitgelieferte Kopie.</li>
  <li><strong>lamejs</strong> (LGPL-3.0) — MP3-Encoder, eigene, mitgelieferte Kopie.</li>
  <li><strong>FFmpeg.wasm</strong> (LGPL/GPL, optional) — nur als Notfall-Dekoder für Formate, die der Browser selbst nicht öffnet.</li>
</ul>
<p>Beim Modus „lokal“ liegt keine einzige Fremddatei außerhalb dieses Projekts. Im Modus „CDN“ werden JSZip/lamejs beim ersten Bedarf von einem freien CDN geladen.</p>
<h3>Lizenz und Haftung</h3>
<p>Der Quellcode steht unter der MIT-Lizenz; Fremdbibliotheken behalten ihre Lizenzen. Keine Gewähr für Ergebnisse — bearbeite Originale immer auf einer Kopie.</p>`,

      'help.body': `
<h3>In drei Schritten</h3>
<ol>
  <li><strong>Ablegen:</strong> Ziehe eine oder mehrere Audiodateien auf die große Fläche. Sie werden lokal gelesen, nicht hochgeladen.</li>
  <li><strong>Zuhören:</strong> Jede Datei bekommt eine Karte mit Diagnose in normaler Sprache, Wellenform-Vergleich und Messwerten. Der Schalter <em>Original / Repariert / A/B</em> lässt dich direkt umschalten, ohne den Ton lauter zu machen.</li>
  <li><strong>Speichern:</strong> „Fertig – speichern“ schreibt die reparierte Datei auf dein Gerät (WAV verlustfrei oder MP3). Mehrere Karten: „Alle verarbeiten“, dann „ZIP herunterladen“.</li>
</ol>
<h3>Der eine Regler</h3>
<p>„Restaurationskraft“ skaliert alle Einzelparameter gemeinsam. 0 % ist identisch mit dem Original, 100 % ist der volle Eingriff des gewählten Profils. Ein Wert um 60–80 % ist meist der musikalischste.</p>
<h3>Klangprofile</h3>
<ul>
  <li><strong>Automatisch:</strong> wählt anhand der Messung das passende Profil (Garage, Vinyl, Kassette, Bitrate, Politur).</li>
  <li><strong>Garage / Ein-Mikrofon:</strong> schmale Aufnahmen mit wenig Bass, boxigen Mitten und dumpfen Höhen.</li>
  <li><strong>Vinyl-Rip:</strong> Knacksen, Laufgeräusch und etwas Rumpeln.</li>
  <li><strong>Kassette:</strong> Bandrauschen und weicher Hochtonabfall.</li>
  <li><strong>Niedrige Bitrate:</strong> harte Höhenkante ab etwa 11–16 kHz — hier ist die Obertonsynthese am größten.</li>
  <li><strong>Allgemeine Politur:</strong> nichts Wildes, nur besser.</li>
</ul>
<h3>Wenn etwas nicht klingt</h3>
<ul>
  <li>Die Suite fügt nichts hinzu, was das Original nicht hergibt: ein dumpfes Band bleibt ein dumpfes Band, nur mit glaubwürdigerem Rand.</li>
  <li>„Repariert“ ist pegelnah zum Original abgestimmt. Lauter heißt hier nicht besser — schalte im Zweifel A/B.</li>
  <li>Für den MP3-Export wird etwas länger gerechnet. WAV geht schneller und ist verlustfrei.</li>
</ul>`,

      'about.libLocal': 'Bibliotheken: lokal (empfohlen)',
      'about.libCdn': 'Bibliotheken: freies CDN',
      'about.libToggle': 'Klick wechselt zwischen lokalen Kopien und dem Bezug über ein freies CDN.',
    },

    /* -------------------------------------------------------------- English */
    en: {
      'brand.name': 'Harmonic Restoration',
      'brand.sub': 'Remaster Suite',
      'a11y.skip': 'Skip to upload',
      'a11y.help': 'Open help',
      'a11y.dropzone': 'Drop audio files to restore',
      'nav.help': 'Help',
      'hero.title': 'Old recordings, new life.',
      'hero.sub': 'Drop a recording in — the suite listens, works out what went wrong and fixes it in one click. Everything stays on your device.',
      'steps.1': 'Drop a file',
      'steps.2': 'Automatic check',
      'steps.3': 'Compare & save',
      'drop.title': 'Drop audio files here',
      'drop.hint': '… or click to browse. Several files at once are welcome.',
      'drop.titleTouch': 'Choose audio files',
      'drop.hintTouch': 'Tap here and pick one or more files. Nothing leaves your device.',
      'drop.button': 'Choose files',
      'drop.formats': 'MP3 · WAV · FLAC · OGG · M4A/AAC — no size limit, no upload',
      'drop.privacy': 'No upload, no account, no cost. Your files never leave this device.',

      'ctl.power': 'Restoration power',
      'ctl.powerHint': 'One slider for everything. 0 % = original, 100 % = maximum repair.',
      'ctl.profile': 'Sound profile',
      'ctl.listen': 'Listen',
      'ctl.original': 'Original',
      'ctl.restored': 'Restored',
      'ctl.compare': 'A/B',
      'ctl.compareHint': 'Switches between original and restored every 4 seconds',
      'ctl.processAll': 'Process all',
      'ctl.zip': 'Download ZIP',
      'ctl.clear': 'Clear list',
      'ctl.export': 'Export',

      'preset.auto': 'Automatic (recommended)',
      'preset.garage': 'Garage / one-mic (60s/70s)',
      'preset.vinyl': 'Vinyl rip restoration',
      'preset.cassette': 'Cassette de-hiss',
      'preset.lowbitrate': 'Low bitrate brightener',
      'preset.general': 'General polish',
      'preset.auto.short': 'Auto',

      'list.title': 'Your files',
      'feat.engine.t': 'What actually happens here',
      'feat.engine.b': 'Real DSP in real time: harmonic synthesis up to 16 kHz, sub-bass down to 30 Hz, de-hissing, de-clicking and a dynamic resonance tamer — computed on your device, not in a cloud.',
      'feat.privacy.t': 'Private by design',
      'feat.privacy.b': 'There is no server. No uploads, no cookies, no tracking, no analytics. Close the tab and everything is gone.',
      'feat.free.t': 'Free & open',
      'feat.free.b': 'Static HTML, CSS and JavaScript — runs on GitHub Pages, no build step, no subscription. The source is open for inspection.',
      'feat.batch.t': 'Batch processing',
      'feat.batch.b': 'As many files as you like — one at a time so your memory can breathe. At the end, one ZIP with every result.',

      'foot.support': 'Support it voluntarily',
      'foot.supportHint': 'The suite stays free forever. If it saves you work, a crypto tip is welcome — one click copies the address.',
      'foot.donateLegal': 'Tips are voluntary and not a purchase: no service obligation is created.',
      'foot.developedBy': 'Developed by',
      'foot.localOnly': 'This application works 100 % inside your browser. No audio data is transmitted.',

      'legal.terms': 'Terms',
      'legal.privacy': 'Privacy',
      'legal.contact': 'Contact',
      'legal.about': 'About & credits',
      'ui.close': 'Close',
      'ui.percent': '{v} %',

      'card.remove': 'Remove file',
      'card.waveAria': 'Waveform comparison of original and restored audio',
      'card.legendOriginal': 'Original',
      'card.legendRestored': 'Restored',
      'card.analyzing': 'Analysing …',
      'card.profile': 'Sound profile',
      'card.power': 'Power for this file',
      'card.listen': 'Compare',
      'card.save': 'Save',
      'card.saveFile': 'Done – save file',
      'card.retry': 'Process again',
      'card.loop': 'Loop',
      'card.loopHint': 'Repeat the preview continuously',
      'card.window': 'Preview: second {a}–{b}',
      'work.aria': 'Progress',
      'card.play': 'Play',
      'card.pause': 'Pause',
      'meta.line': '{dur} · {ch} · {sr} · {size}',

      'status.queued': 'Queued',
      'status.analyzing': 'Listening …',
      'status.ready': 'Ready',
      'status.processing': 'Restoring …',
      'status.rendering': 'Rendering {p} %',
      'status.done': 'Done',
      'status.error': 'Error',
      'status.export': 'Saving …',
      'work.decode': 'Reading the file …',
      'work.analyze': 'Measuring the sound …',
      'work.diagnose': 'Picking the profile …',
      'work.window': 'Looking for the preview spot …',
      'work.envelope': 'Preparing the waveform …',
      'work.preview': 'Rendering the preview …',
      'work.render': 'Restoring the recording …',
      'work.encode': 'Writing the file …',
      'work.zip': 'Packing the ZIP …',
      'work.wait': 'Waiting in the queue …',
      'work.eta': '~{s} s left',
      'work.etaMin': '~{m} min left',
      'job.file': 'File {i} of {n}: {name}',

      'kind.garage': 'a 1960s/70s garage or one-microphone recording',
      'kind.vinyl': 'a vinyl rip with crackle and surface noise',
      'kind.cassette': 'a cassette recording with tape hiss',
      'kind.lowbitrate': 'a heavily compressed recording with a dull top end',
      'kind.general': 'a recording that needs a gentle polish',
      'kind.healthy': 'an already good-sounding recording',
      'diag.lead': 'Sounds like: <strong>{kind}</strong>.',
      'diag.issues': ' Standing out: {issues}.',
      'diag.confident': ' (detection {p} % confident)',
      'diag.clean': ' Nothing to rescue here — just fine-tuning.',

      'issue.weakBass': 'little deep bass',
      'issue.boxyMids': 'boxy mids',
      'issue.dullTop': 'dull highs',
      'issue.hiss': 'tape hiss',
      'issue.crackle': 'crackle',
      'issue.hum': 'mains hum',
      'issue.codec': 'chopped-off highs (codec)',
      'issue.harsh': 'harsh highs',
      'issue.clipping': 'overload',
      'issue.squashed': 'hardly any dynamics',
      'issue.narrow': 'almost mono',
      'issue.healthy': 'no major weaknesses',

      'chip.score': 'Sound quality',
      'chip.peak': 'Peak',
      'chip.hf': 'Highs to',
      'chip.noise': 'Noise floor',
      'chip.dynamics': 'Dynamics',
      'chip.width': 'Stereo',
      'chip.clip': 'Clipping',

      'batch.done': 'All {n} files are done.',

      'note.done': 'Done. “{fmt}” saves the file to your device.',
      'note.realtime': 'Real-time preview (no waiting). The full file is rendered when you save.',
      'note.decode': 'Reading file …',
      'note.analyze': 'Measuring the sound …',

      'toast.added': '{n} file(s) added.',
      'toast.addedOne': 'Added: {name}',
      'toast.noFiles': 'No audio files found.',
      'toast.skipped': '{n} file(s) skipped (too large or unreadable).',
      'toast.copyOk': '{label} address copied.',
      'toast.copyFail': 'Copy failed — please select the text manually.',
      'toast.saved': '“{name}” saved.',
      'toast.zipStart': 'Building ZIP …',
      'toast.zipDone': 'ZIP with {n} file(s) saved.',
      'toast.zipEmpty': 'No finished file to pack yet.',
      'toast.zipFail': 'ZIP could not be built.',
      'toast.engineFail': 'The audio engine could not be started.',
      'toast.workletFail': 'The DSP processor was blocked. Please open the page over http(s), not as a local file.',
      'toast.libLocal': 'Libraries: local copies (no external requests).',
      'toast.libCdn': 'Libraries: CDN enabled — this contacts the CDN host.',
      'toast.cleared': 'List cleared.',
      'toast.tooBig': '“{name}” is larger than {mb} MB and was skipped.',
      'toast.mp3Slow': 'Encoding MP3 — this takes a bit longer than WAV.',
      'toast.needDecode': 'This file is not ready yet.',
      'toast.renderFail': 'Rendering failed: {msg}',

      'err.decode': 'The file could not be read.',
      'err.broken': 'This file contains corrupted audio data (no valid samples) — it cannot be repaired.',
      'err.render': 'Rendering failed.',

      /* ------------------------------------------------------- English legal */
      'terms.body': `
<p>These terms cover the use of “Harmonic Restoration — Remaster Suite” (“the suite”), a web application that runs entirely in your browser and is provided by <strong>AndrexTheDev</strong>, contact: <a href="mailto:hippie.highho@gmail.com">hippie.highho@gmail.com</a>.</p>
<h3>§ 1 Scope</h3>
<p>The suite is a free tool for post-processing audio files. All processing happens locally on the user's device; no files are transmitted or stored. There is no entitlement to availability, support or further development.</p>
<h3>§ 2 Use and rights</h3>
<p>The user alone is responsible for the files processed. Only recordings may be processed for which the necessary rights exist. The suite must not be used to infringe copyright or personal rights or to process unlawful content.</p>
<h3>§ 3 No warranty</h3>
<p>Results depend on the source material. No specific sonic improvement, measurement outcome or fitness for a particular purpose is promised. The suite is provided “as is”.</p>
<h3>§ 4 Liability</h3>
<p>Liability for intent and gross negligence, for injury to life, body or health, and under mandatory product liability law remains unaffected. Beyond that, liability for slight negligence is excluded, in particular for data loss, lost profit or indirect damages. Always work on a copy of your originals.</p>
<h3>§ 5 Donations</h3>
<p>Any crypto addresses are offered purely for voluntary contributions. They are not a purchase, not consideration and not an investment. Donations are generally non-refundable and are not tax advice.</p>
<h3>§ 6 Third-party components</h3>
<p>The suite includes third-party libraries (including JSZip under the MIT licence and lamejs under LGPL-3.0). Their own licences apply; they are bundled unmodified and their copyright and licence notices must not be removed.</p>
<h3>§ 7 Changes, final provisions</h3>
<p>These terms may be updated for future versions. German law applies. Should individual provisions be invalid, the remainder stays in force. Last updated: {date}.</p>`,

      'privacy.title': 'Privacy',
      'contact.title': 'Contact',
      'about.title': 'About the suite',
      'help.title': 'How it works',
      'privacy.body': `
<p><strong>In one sentence: there is no server. Your audio files never leave this device.</strong></p>
<h3>1. Controller</h3>
<p>AndrexTheDev, contact: <a href="mailto:hippie.highho@gmail.com">hippie.highho@gmail.com</a>.</p>
<h3>2. Processing of audio data</h3>
<p>When you open a file, the browser loads it into memory, decodes it, analyses it, processes it and encodes it again — locally. There is <strong>no transmission, no intermediate storage and no server-side processing</strong>. Closing or reloading the tab removes everything from memory. A download only happens when you click it yourself.</p>
<h3>3. No cookies, no tracking</h3>
<p>The suite sets no cookies, no local storage, no session identifiers, no analytics or advertising services and no social media plugins. No usage profiles are created. Your language choice is kept in the tab's memory only.</p>
<h3>4. External connections</h3>
<p>In its default mode the suite loads <strong>nothing</strong> from the outside: fonts, icons and helper libraries are bundled. Optionally, “About & credits” can switch the helper libraries (JSZip, lamejs, optionally FFmpeg.wasm) to a free CDN; in that case your IP address would be sent to the CDN, as with any ordinary page visit. Without that option, no external request is made.</p>
<h3>5. Hosting access data</h3>
<p>If you reach the suite through GitHub Pages, the hosting provider processes technically necessary access data (e.g. IP address, time, file requested) on the basis of legitimate interests (Art. 6(1)(f) GDPR) to deliver and secure the site. The suite's author has no access to those logs.</p>
<h3>6. Your rights</h3>
<p>Because the suite stores no personal data, there is normally no data set to which access, rectification, erasure, restriction, portability or objection could apply. Requests are still welcome at the address above. Complaints can be lodged with the competent supervisory authority.</p>
<h3>7. Children, security, changes</h3>
<p>The suite is not directed at children and knowingly collects no data from them. Any transmitted data would be protected by TLS — but none is transmitted. These notes may be updated for future versions. Last updated: {date}.</p>`,

      'contact.body': `
<p>Questions, bug reports, sound examples, or a wish for the next version? Just write an email:</p>
<p><strong>Email:</strong> <a href="mailto:hippie.highho@gmail.com">hippie.highho@gmail.com</a><br>
<strong>Developer:</strong> AndrexTheDev<br>
<strong>Project:</strong> Harmonic Restoration — Remaster Suite (open source, GitHub Pages)</p>
<h3>What helps with a bug report</h3>
<ul>
  <li>Which browser and version? (e.g. Chrome 126, Firefox 128, Safari 18)</li>
  <li>What format and length is the recording?</li>
  <li>What did you click, and what happened instead?</li>
  <li>Optional: a screenshot of the developer console (F12).</li>
</ul>
<h3>Supporting</h3>
<p>Tips are voluntary and not a purchase — the addresses are in the footer. Thanks for any feedback.</p>`,

      'about.body': `
<p><strong>Version 1.4</strong> — a complete audio restoration chain in the browser. Everything computes on your device.</p>
<h3>The chain, in order</h3>
<ul>
  <li><strong>Corrective EQ:</strong> six bands, dosed automatically from the measurement.</li>
  <li><strong>Dynamic resonance tamer:</strong> six narrow bands pull down ringing room resonances without touching the fundamentals.</li>
  <li><strong>Harmonic exciter:</strong> rebuilds missing overtones with 2nd and 3rd order generation — the core of the harmonic restoration.</li>
  <li><strong>Air synthesis 8–16 kHz:</strong> rebuilds the very top from the remaining high-frequency content.</li>
  <li><strong>Sub-bass 30–60 Hz:</strong> recovers the missing lowest octave with octave division and pitch tracking.</li>
  <li><strong>De-hiss:</strong> a dynamic high-frequency gate that only closes between notes — wide open it hands the signal through untouched.</li>
  <li><strong>De-click:</strong> detects short needle and digital pops and replaces them with the signal's own prediction.</li>
  <li><strong>Glue compressor, warmth, tilt:</strong> cohesion, saturation, final polish — with level matching for an honest A/B.</li>
</ul>
<h3>Technical</h3>
<ul>
  <li>Web Audio API with <code>AudioWorklet</code> in its own file <code>assets/worklets/remaster-processor.js</code>.</li>
  <li>One single real-time core: the same chain runs live for the preview and offline for the export (<code>OfflineAudioContext</code>).</li>
  <li>Analysis: 8192-point FFT, noise-floor, crest and clipping measurement; from that comes the sound profile and the plain-language diagnosis.</li>
  <li>Output: lossless WAV 16/24/32-bit or MP3 up to 320 kbps via lamejs.</li>
  <li>Progress in two bars: per file with stage and time left, plus a job bar above the list that docks to the bottom edge on a phone.</li>
  <li>Built for phone browsers: 44 px targets, no hover-only affordances, safe areas for the notch and the gesture bar, a smaller memory budget.</li>
  <li>No frameworks, no build step, no server — static files, ready for GitHub Pages.</li>
</ul>
<h3>Libraries</h3>
<ul>
  <li><strong>JSZip</strong> (MIT) — in-browser ZIP export, bundled copy.</li>
  <li><strong>lamejs</strong> (LGPL-3.0) — MP3 encoder, bundled copy.</li>
  <li><strong>FFmpeg.wasm</strong> (LGPL/GPL, optional) — emergency decoder only, for formats the browser itself cannot open.</li>
</ul>
<p>In “local” mode not a single third-party file is fetched from outside this project. In “CDN” mode JSZip/lamejs are fetched from a free CDN on first use.</p>
<h3>Licence and liability</h3>
<p>The source code is released under the MIT licence; third-party libraries keep their own licences. No guarantee of results — always work on a copy of your originals.</p>`,

      'help.body': `
<h3>Three steps</h3>
<ol>
  <li><strong>Drop:</strong> drag one or more audio files onto the big panel. They are read locally, not uploaded.</li>
  <li><strong>Listen:</strong> each file gets a card with a plain-language diagnosis, a waveform comparison and measurements. The <em>Original / Restored / A/B</em> switch lets you flip directly, without fooling yourself with volume.</li>
  <li><strong>Save:</strong> “Done – save file” writes the restored file to your device (lossless WAV or MP3). For several cards: “Process all”, then “Download ZIP”.</li>
</ol>
<h3>The single slider</h3>
<p>“Restoration power” scales every individual parameter together. 0 % is identical to the original, 100 % is the full intervention of the chosen profile. Somewhere around 60–80 % is usually the most musical.</p>
<h3>Sound profiles</h3>
<ul>
  <li><strong>Automatic:</strong> picks the fitting profile from the measurement (garage, vinyl, cassette, bitrate, polish).</li>
  <li><strong>Garage / one-mic:</strong> narrow recordings with little bass, boxy mids and dull highs.</li>
  <li><strong>Vinyl rip:</strong> crackle, surface noise and a bit of rumble.</li>
  <li><strong>Cassette:</strong> tape hiss and a soft high-frequency roll-off.</li>
  <li><strong>Low bitrate:</strong> a hard top-end edge from roughly 11–16 kHz — this is where harmonic synthesis does the most.</li>
  <li><strong>General polish:</strong> nothing wild, just better.</li>
</ul>
<h3>If it does not sound right</h3>
<ul>
  <li>The suite adds nothing the original does not have: a dull tape stays a dull tape, only with a more believable edge.</li>
  <li>“Restored” is level-matched to the original. Louder is not better here — switch A/B when in doubt.</li>
  <li>MP3 export takes a little longer to compute. WAV is faster and lossless.</li>
</ul>`,

      'about.libLocal': 'Libraries: local (recommended)',
      'about.libCdn': 'Libraries: free CDN',
      'about.libToggle': 'Click to switch between bundled local copies and fetching from a free CDN.',
    },
  };

  const LANGS = ['de', 'en'];
  let lang = 'de';

  /* ------------------------------------------------------------------ helpers */

  function isHtml(key) {
    const v = DICT[lang][key];
    return typeof v === 'string' && v.indexOf('<') !== -1;
  }

  /** Interpolate {placeholders}. */
  function fill(str, vars) {
    if (!vars) return str;
    return str.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])));
  }

  /**
   * Translate a key.
   * @param {string} key
   * @param {object} [vars] placeholder values
   */
  function t(key, vars) {
    const table = DICT[lang] || DICT.de;
    let s = table[key];
    if (s === undefined) s = DICT.de[key];
    if (s === undefined) return key;
    return fill(s, vars);
  }

  /** Pick the best starting language: stored choice → browser → German. */
  function detect() {
    try {
      const nav = (global.navigator && (global.navigator.language || (global.navigator.languages || [])[0])) || 'de';
      return String(nav).toLowerCase().indexOf('de') === 0 ? 'de' : 'en';
    } catch (e) { return 'de'; }
  }

  /** Apply every translation to a DOM subtree (defaults to the whole document). */
  function apply(root) {
    const scope = root || global.document;
    if (!scope || !scope.querySelectorAll) return;
    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    scope.querySelectorAll('[data-i18n-html]').forEach((el) => {
      const v = t(el.getAttribute('data-i18n-html'), { date: today() });
      el.innerHTML = v;
    });
    scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    });
    scope.querySelectorAll('[data-i18n-aria]').forEach((el) => {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
    });
    if (global.document && global.document.documentElement) global.document.documentElement.lang = lang;
  }

  /** Localised date for the legal overlays. */
  function today() {
    const d = new Date();
    const months = lang === 'de'
      ? ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']
      : ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return lang === 'de'
      ? `${d.getDate()}. ${months[d.getMonth()]} ${d.getFullYear()}`
      : `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }

  /** Switch language and re-render every tagged node. */
  function setLang(next, opts) {
    if (LANGS.indexOf(next) === -1) next = 'de';
    lang = next;
    if (!opts || opts.apply !== false) apply();
    if (global.document && global.document.title) {
      global.document.title = t('brand.name') + ' · ' + t('brand.sub');
    }
    try {
      if (global.dispatchEvent) global.dispatchEvent(new CustomEvent('rs:lang', { detail: { lang: lang } }));
    } catch (e) { /* very old browsers */ }
    return lang;
  }

  /** All keys of a language — used by the test suite for completeness checks. */
  function keys(l) { return Object.keys(DICT[l || lang]); }

  const API = { LANGS, DICT, t, apply, setLang, detect, keys, isHtml, get lang() { return lang; } };
  global.RSi18n = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
