/**
 * zip.js — dependency-free, store-only (no compression) ZIP writer.
 *
 * Used by the popup's batch mode to bundle per-video .txt files into one
 * download. Included in the service worker via importScripts() and in the
 * popup via a plain <script> tag, so both share this one tested file.
 *
 * Exposes: globalThis.makeZip(files) -> Uint8Array
 *          globalThis.crc32(bytes)  -> unsigned int
 *
 * `files` is an array of { name: string, data: string | Uint8Array }.
 */

(function (root) {
  "use strict";

  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(d) {
    const time =
      ((d.getHours() & 31) << 11) |
      ((d.getMinutes() & 63) << 5) |
      (Math.floor(d.getSeconds() / 2) & 31);
    const date =
      (((d.getFullYear() - 1980) & 127) << 9) |
      (((d.getMonth() + 1) & 15) << 5) |
      (d.getDate() & 31);
    return { time: time >>> 0, date: date >>> 0 };
  }

  const encoder = new TextEncoder();

  function makeZip(files) {
    const now = dosDateTime(new Date());
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const f of files) {
      const nameBytes = encoder.encode(f.name);
      const data =
        typeof f.data === "string" ? encoder.encode(f.data) : f.data;
      const crc = crc32(data);

      // --- local file header ---
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); // signature
      lv.setUint16(4, 20, true); // version needed
      lv.setUint16(6, 0x0800, true); // flags: UTF-8 filenames
      lv.setUint16(8, 0, true); // method: store
      lv.setUint16(10, now.time, true);
      lv.setUint16(12, now.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true); // compressed size
      lv.setUint32(22, data.length, true); // uncompressed size
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true); // extra length
      local.set(nameBytes, 30);

      localParts.push(local, data);

      // --- central directory record ---
      const cd = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true); // signature
      cv.setUint16(4, 20, true); // version made by
      cv.setUint16(6, 20, true); // version needed
      cv.setUint16(8, 0x0800, true); // flags
      cv.setUint16(10, 0, true); // method
      cv.setUint16(12, now.time, true);
      cv.setUint16(14, now.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true); // extra
      cv.setUint16(32, 0, true); // comment
      cv.setUint16(34, 0, true); // disk number
      cv.setUint16(36, 0, true); // internal attrs
      cv.setUint32(38, 0, true); // external attrs
      cv.setUint32(42, offset, true); // local header offset
      cd.set(nameBytes, 46);
      centralParts.push(cd);

      offset += local.length + data.length;
    }

    let centralSize = 0;
    for (const c of centralParts) centralSize += c.length;

    // --- end of central directory ---
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true); // disk number
    ev.setUint16(6, 0, true); // disk with central dir
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true); // central dir offset
    ev.setUint16(20, 0, true); // comment length

    const total = offset + centralSize + eocd.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const part of localParts) {
      out.set(part, p);
      p += part.length;
    }
    for (const part of centralParts) {
      out.set(part, p);
      p += part.length;
    }
    out.set(eocd, p);
    return out;
  }

  root.makeZip = makeZip;
  root.crc32 = crc32;

  // Allow the file to be exercised directly under Node for testing.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { makeZip, crc32 };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
