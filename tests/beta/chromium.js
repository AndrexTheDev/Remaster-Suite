/* =============================================================================
 * Headless Chromium for the beta suite.
 * -----------------------------------------------------------------------------
 * The sandbox has no system browser, so this resolves @sparticuz/chromium (an
 * optional dev dependency that ships a complete headless Chromium build) and
 * unpacks its brotli-compressed binary and shared libraries by hand — outside
 * AWS Lambda the package only extracts the binary, not the runtime libs.
 * ========================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync, spawn } = require('child_process');

function inflateBr(src, dst) {
  fs.writeFileSync(dst, zlib.brotliDecompressSync(fs.readFileSync(src)));
}

function extractTar(tarFile, dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xf', tarFile, '-C', dir]);
}

/** @returns {{exe:string, env:object, args:string[]}} */
function ensureChromium() {
  let chromium;
  try {
    chromium = require('@sparticuz/chromium').default;
  } catch {
    throw new Error('beta suite needs `npm i` first (optional dependency @sparticuz/chromium)');
  }

  // walk up from the package entry until we find its bin/ directory
  let here = path.dirname(require.resolve('@sparticuz/chromium'));
  while (here !== path.dirname(here) && !fs.existsSync(path.join(here, 'bin'))) here = path.dirname(here);
  const bin = path.join(here, 'bin');
  const work = path.join(os.tmpdir(), 'rs-beta-chromium');
  fs.mkdirSync(work, { recursive: true });

  // One profile per run, and never a profile two browsers could share: a
  // second Chromium on the same `--user-data-dir` wedges the first one's OPFS
  // layer (its worker's storage calls never return), and that surfaces much
  // later as a render that sits at 100 % forever. Stale profiles from killed
  // runs are pruned by age, so a browser that is still running keeps its own.
  const PROFILE_TTL_MS = 6 * 60 * 60 * 1000;
  for (const entry of fs.readdirSync(work)) {
    if (!entry.startsWith('profile-')) continue;
    const dir = path.join(work, entry);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > PROFILE_TTL_MS) fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) { /* in use by another run — leave it alone */ }
  }
  const profile = path.join(work, 'profile-' + process.pid + '-' + Date.now().toString(36));

  // the package extracts the binary itself; the shared libs and fonts we unpack
  // ourselves, exactly like the package does on AWS Lambda.
  if (!fs.existsSync(path.join(work, 'chromium'))) {
    // chromium.br is the brotli'd executable itself, not an archive
    inflateBr(path.join(bin, 'chromium.br'), path.join(work, 'chromium'));
  }
  if (!fs.existsSync(path.join(work, 'lib', 'libnspr4.so'))) {
    inflateBr(path.join(bin, 'al2023.tar.br'), path.join(work, 'al2023.tar'));
    extractTar(path.join(work, 'al2023.tar'), work);
    fs.unlinkSync(path.join(work, 'al2023.tar'));
  }
  if (!fs.existsSync(path.join(work, 'swiftshader', 'libvk_swiftshader.so')) && fs.existsSync(path.join(bin, 'swiftshader.tar.br'))) {
    inflateBr(path.join(bin, 'swiftshader.tar.br'), path.join(work, 'swiftshader.tar'));
    extractTar(path.join(work, 'swiftshader.tar'), work);
    fs.unlinkSync(path.join(work, 'swiftshader.tar'));
  }
  if (!fs.existsSync(path.join(work, 'fonts', 'fonts.conf'))) {
    inflateBr(path.join(bin, 'fonts.tar.br'), path.join(work, 'fonts.tar'));
    extractTar(path.join(work, 'fonts.tar'), work);
    fs.unlinkSync(path.join(work, 'fonts.tar'));
  }
  const exe = path.join(work, 'chromium');
  fs.chmodSync(exe, 0o755);

  const env = {
    ...process.env,
    LD_LIBRARY_PATH: [work, path.join(work, 'lib'), process.env.LD_LIBRARY_PATH || ''].join(':'),
    FONTCONFIG_PATH: path.join(work, 'fonts'),
    HOME: os.tmpdir(),
    XDG_RUNTIME_DIR: os.tmpdir(),
  };

  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-extensions',
    '--hide-scrollbars',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--force-device-scale-factor=1',
    '--force-color-profile=srgb',
    // deterministic text rasterisation: two loads of the same page must
    // produce the same pixels, or a visual-regression baseline is noise
    '--disable-lcd-text',
    '--disable-font-subpixel-positioning',
    '--user-data-dir=' + profile,
  ];

  // smoke test
  const version = execFileSync(exe, ['--version'], { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  return { exe, env, args, version };
}

/**
 * Delete the profile directory this run created, once its browser is gone: a
 * killed Chromium leaves a locked OPFS store behind, and the next run must not
 * inherit it.
 * @returns {void}
 */
function cleanProfile() {
  const work = path.join(os.tmpdir(), 'rs-beta-chromium');
  for (const entry of fs.readdirSync(work)) {
    if (!entry.startsWith('profile-' + process.pid + '-')) continue;
    try { fs.rmSync(path.join(work, entry), { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
}

/** launch and return the spawned process; caller kills it afterwards */
function launch(port) {
  const { exe, env, args, version } = ensureChromium();
  const child = spawn(exe, [...args, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, 'about:blank'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  child.stdout.on('data', () => {});
  return { child, version };
}

module.exports = { ensureChromium, launch, cleanProfile };
