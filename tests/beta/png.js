/* =============================================================================
 * Remaster Suite — a minimal PNG reader/writer, for visual regression.
 * -----------------------------------------------------------------------------
 * The beta suite photographs the app and compares the photographs with the
 * baselines in `docs/beta/baseline/`. Doing that needs an image library, and
 * this project has no dependencies beyond jsdom and acorn — so this is the
 * part of one that screenshots actually require: 8-bit PNG, colour type 0
 * (grey), 2 (RGB) or 6 (RGBA), non-interlaced, which is everything
 * Chromium's `Page.captureScreenshot` ever produces.
 *
 * Decode · encode · compare, and nothing else. No scaling, no colour
 * management, no metadata: a screenshot is a rectangle of pixels, and a
 * regression is a pixel that changed.
 *
 * Usage:
 *   const png = require('./png.js');
 *   const a = png.decode(fs.readFileSync('a.png'));
 *   const b = png.decode(fs.readFileSync('b.png'));
 *   const d = png.diff(a, b, { tolerance: 2 });
 *   fs.writeFileSync('diff.png', png.diffImage(a, b));
 * ========================================================================== */
'use strict';

const zlib = require('zlib');

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Pixels per byte: the colour types this reader accepts, and their channels. */
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };
/** The colour type a given channel count is written as. */
const COLOUR_TYPE = { 1: 0, 2: 4, 3: 2, 4: 6 };

/**
 * A decoded image: 8 bits per channel, row-major, top-left first.
 * @typedef {object} PNGImage
 * @property {number} width - pixels per row.
 * @property {number} height - rows.
 * @property {number} channels - 1 (grey), 2 (grey+alpha), 3 (RGB) or 4 (RGBA).
 * @property {Buffer} data - `width * height * channels` bytes.
 */

/* ────────────────────────────────────────────────────────────── CRC-32 ── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

/**
 * The CRC-32 of the bytes between a chunk's type and its data, as PNG
 * requires it.
 * @param {Buffer} buf - chunk type + data.
 * @returns {number} the unsigned CRC.
 */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ────────────────────────────────────────────────────────────── decode ── */

/** @param {Buffer} buf - a whole PNG file. @returns {object[]} its chunks. */
function chunks(buf) {
  if (buf.length < 8 || !buf.slice(0, 8).equals(SIGNATURE)) throw new Error('png: not a PNG file');
  const out = [];
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.slice(p + 8, p + 8 + len);
    out.push({ type, data });
    p += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

/** Paeth predictor, straight from the specification. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
}

/**
 * Undo the per-scanline filters of the PNG specification.
 * @param {Buffer} raw - the inflated IDAT stream.
 * @param {number} width - pixels per row.
 * @param {number} height - rows.
 * @param {number} bpp - bytes per pixel.
 * @returns {Buffer} `width * height * bpp` unfiltered bytes.
 */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = raw.slice(p, p + stride);
    p += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y ? out.slice((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? cur[x - bpp] : 0;
      const up = prev ? prev[x] : 0;
      const upLeft = (prev && x >= bpp) ? prev[x - bpp] : 0;
      const v = line[x];
      switch (filter) {
        case 0: cur[x] = v; break;
        case 1: cur[x] = (v + left) & 0xff; break;
        case 2: cur[x] = (v + up) & 0xff; break;
        case 3: cur[x] = (v + ((left + up) >> 1)) & 0xff; break;
        case 4: cur[x] = (v + paeth(left, up, upLeft)) & 0xff; break;
        default: throw new Error('png: unknown scanline filter ' + filter);
      }
    }
  }
  return out;
}

/**
 * Read a PNG file into pixels.
 * @param {Buffer} buf - the file's bytes.
 * @returns {PNGImage} the decoded image.
 * @throws {Error} on a format this reader does not handle — deliberately loud,
 *   because a silently mis-read screenshot would make every visual row a
 *   coin toss.
 */
function decode(buf) {
  const list = chunks(buf);
  const ihdr = list.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('png: no IHDR chunk');
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const depth = ihdr.data[8];
  const colour = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (depth !== 8) throw new Error('png: unsupported bit depth ' + depth);
  if (interlace !== 0) throw new Error('png: interlaced images are not supported');
  const channels = CHANNELS[colour];
  if (!channels) throw new Error('png: unsupported colour type ' + colour);

  const idat = Buffer.concat(list.filter((c) => c.type === 'IDAT').map((c) => c.data));
  if (!idat.length) throw new Error('png: no IDAT data');
  const raw = zlib.inflateSync(idat);
  const bpp = channels;
  const expected = height * (1 + width * bpp);
  if (raw.length < expected) throw new Error('png: truncated image data (' + raw.length + ' of ' + expected + ')');
  return { width, height, channels, data: unfilter(raw, width, height, bpp) };
}

/* ─────────────────────────────────────────────────────────────── encode ── */

/**
 * Make a PNG chunk: length, type, data, CRC.
 * @param {string} type - the four-character chunk type.
 * @param {Buffer} data - the chunk's payload.
 * @returns {Buffer} the chunk, ready to concatenate.
 */
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const body = Buffer.concat([head.slice(4), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * Write pixels back out as an 8-bit PNG. Grey and grey+alpha are widened to
 * RGB/RGBA so that one writer serves every image this suite makes.
 * @param {PNGImage} img - the image to write.
 * @returns {Buffer} the complete PNG file.
 */
function encode(img) {
  const { width, height } = img;
  const pixelBytes = img.channels;                     // 1, 2, 3 or 4
  const colourType = COLOUR_TYPE[pixelBytes];          // …written as 0, 4, 2 or 6
  if (colourType === undefined) throw new Error('png: cannot write an image with ' + img.channels + ' channels');
  const stride = width * pixelBytes;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const rowOut = y * (1 + stride) + 1;               // one filter byte per row, always 0
    img.data.copy(raw, rowOut, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colourType;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ─────────────────────────────────────────────────────────────── pixel ── */

/**
 * A fresh, opaque image to draw into.
 * @param {number} width - pixels per row.
 * @param {number} height - rows.
 * @param {number[]} [fill] - initial `[r, g, b, a]`, white by default.
 * @param {number} [channels] - 3 (RGB) or 4 (RGBA), 4 by default.
 * @returns {PNGImage} the new image.
 */
function blank(width, height, fill, channels) {
  const ch = channels || 4;
  const colour = fill || [255, 255, 255, 255];
  const data = Buffer.alloc(width * height * ch);
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < ch; c++) data[i * ch + c] = colour[c === 3 ? 3 : c];
  }
  return { width, height, channels: ch, data };
}

/**
 * Draw a filled rectangle into an image, in place — the tool the suite uses to
 * prove that its own diff is not a rubber stamp: change a known rectangle and
 * the reported difference must be exactly that rectangle.
 * @param {PNGImage} img - the image to draw into.
 * @param {number} x - left edge.
 * @param {number} y - top edge.
 * @param {number} w - width in pixels.
 * @param {number} h - height in pixels.
 * @param {number[]} colour - `[r, g, b]` (alpha is left alone).
 * @returns {PNGImage} the same image.
 */
function fill(img, x, y, w, h, colour) {
  const px = img.channels;
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * img.width + xx) * px;
      img.data[i] = colour[0];
      img.data[i + 1] = colour[1];
      img.data[i + 2] = colour[2];
    }
  }
  return img;
}

/* ──────────────────────────────────────────────────────────────── diff ── */

/**
 * What a comparison found.
 * @typedef {object} PNGDiff
 * @property {boolean} sameSize - both images have the same width and height.
 * @property {boolean} identical - no pixel differs by more than `tolerance`.
 * @property {number} width - compared width.
 * @property {number} height - compared height.
 * @property {number} different - pixels beyond the tolerance.
 * @property {number} ratio - `different` as a fraction of all pixels.
 * @property {number} maxDelta - the largest single-channel difference.
 * @property {number} meanDelta - mean absolute difference over every channel.
 * @property {?object} bbox - `{x0, y0, x1, y1}` around the differing pixels.
 */

/**
 * Compare two images pixel by pixel.
 *
 * The tolerance is per channel and inclusive: `tolerance: 2` lets a channel
 * move by two steps (0.8 %) and calls a pixel different at three. Rendering
 * the same page twice on the same machine is byte-identical, so the default is
 * one step of slack for the odd antialiasing edge, not a licence to drift.
 *
 * @param {PNGImage} a - the baseline.
 * @param {PNGImage} b - the new capture.
 * @param {{tolerance?:number}} [opts] - comparison options.
 * @returns {PNGDiff} the comparison.
 */
function diff(a, b, opts) {
  const tolerance = (opts && opts.tolerance !== undefined) ? opts.tolerance : 1;
  const sameSize = a.width === b.width && a.height === b.height;
  const sameDepth = a.channels === b.channels;
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const out = {
    sameSize, identical: false, width, height,
    different: 0, ratio: 1, maxDelta: 0, meanDelta: 0, bbox: null,
  };
  if (!sameSize || !sameDepth) {
    // nothing sensible to compare pixel for pixel — every compared pixel counts
    out.different = width * height;
    out.ratio = 1;
    out.meanDelta = 0;
    return out;
  }
  const channels = Math.min(a.channels, b.channels);
  const bbox = { x0: width, y0: height, x1: -1, y1: -1 };
  let sum = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ia = (y * a.width + x) * a.channels;
      const ib = (y * b.width + x) * b.channels;
      let worst = 0;
      for (let c = 0; c < channels; c++) {
        const d = Math.abs(a.data[ia + c] - b.data[ib + c]);
        sum += d;
        if (d > worst) worst = d;
      }
      if (worst > out.maxDelta) out.maxDelta = worst;
      if (worst > tolerance) {
        out.different++;
        if (x < bbox.x0) bbox.x0 = x;
        if (y < bbox.y0) bbox.y0 = y;
        if (x > bbox.x1) bbox.x1 = x;
        if (y > bbox.y1) bbox.y1 = y;
      }
    }
  }
  const pixels = width * height;
  out.ratio = pixels ? out.different / pixels : 0;
  out.meanDelta = (pixels * channels) ? sum / (pixels * channels) : 0;
  out.identical = out.different === 0;
  out.bbox = out.different ? bbox : null;
  return out;
}

/**
 * A picture of what changed: the new capture, dimmed, with every pixel beyond
 * the tolerance painted red. This is the artefact a human opens when a row
 * fails — it answers "where" without a second tool.
 * @param {PNGImage} a - the baseline.
 * @param {PNGImage} b - the new capture.
 * @param {{tolerance?:number, dim?:number}} [opts] - same options as `diff`,
 *   plus the brightness the unchanged pixels keep (0–255, default 96).
 * @returns {Buffer} a PNG file.
 */
function diffImage(a, b, opts) {
  const tolerance = (opts && opts.tolerance !== undefined) ? opts.tolerance : 1;
  const dim = (opts && opts.dim !== undefined) ? opts.dim : 96;
  if (a.channels !== b.channels) throw new Error('png: cannot draw a difference between images with different depth');
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const out = blank(width, height, [dim, dim, dim, 255]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ia = (y * a.width + x) * a.channels;
      const ib = (y * b.width + x) * b.channels;
      const o = (y * width + x) * 4;
      let worst = 0;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a.data[ia + c] - b.data[ib + c]);
        if (d > worst) worst = d;
      }
      if (worst > tolerance) {
        out.data[o] = 255; out.data[o + 1] = 48; out.data[o + 2] = 48;
      } else {
        // keep a readable ghost of the new capture under the red
        out.data[o] = Math.round(b.data[ib] / 255 * dim);
        out.data[o + 1] = Math.round(b.data[ib + 1] / 255 * dim);
        out.data[o + 2] = Math.round(b.data[ib + 2] / 255 * dim);
      }
    }
  }
  return encode(out);
}

module.exports = { decode, encode, blank, fill, diff, diffImage, crc32, SIGNATURE };
