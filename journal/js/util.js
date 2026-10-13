// Small helpers: photo dates (EXIF), dictation text insertion, and search matching.

/** When a JPEG was taken (EXIF DateTimeOriginal, local time unless an offset is recorded), or null. */
export async function photoTakenAt(blob) {
  try {
    const buf = new DataView(await blob.slice(0, 256 * 1024).arrayBuffer());
    if (buf.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 4 < buf.byteLength) {
      const marker = buf.getUint16(off);
      const size = buf.getUint16(off + 2);
      if (marker === 0xffe1 && buf.getUint32(off + 4) === 0x45786966) return readExif(buf, off + 10);
      if ((marker & 0xff00) !== 0xff00) return null;
      off += 2 + size;
    }
  } catch { /* not a readable JPEG */ }
  return null;
}

function readExif(v, tiff) {
  const le = v.getUint16(tiff) === 0x4949;
  const u16 = (o) => v.getUint16(o, le), u32 = (o) => v.getUint32(o, le);
  const ascii = (o, n) => { let s = ''; for (let i = 0; i < n - 1; i++) s += String.fromCharCode(v.getUint8(o + i)); return s; };
  const tags = (ifd) => {
    const out = {};
    const n = u16(tiff + ifd);
    for (let i = 0; i < n; i++) {
      const e = tiff + ifd + 2 + i * 12;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      if (type === 2) out[tag] = ascii(count > 4 ? tiff + u32(e + 8) : e + 8, count);
      else if (type === 4) out[tag] = u32(e + 8);
    }
    return out;
  };
  const ifd0 = tags(u32(tiff + 4));
  const exif = ifd0[0x8769] ? tags(ifd0[0x8769]) : {};
  const raw = exif[0x9003] ?? ifd0[0x0132];
  const m = raw && /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(raw);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const offset = exif[0x9011] && /^([+-])(\d{2}):(\d{2})/.exec(exif[0x9011]);
  if (offset) {
    const sign = offset[1] === '-' ? -1 : 1;
    return Date.UTC(y, mo - 1, d, h, mi, s) - sign * (Number(offset[2]) * 60 + Number(offset[3])) * 60000;
  }
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

/** Same rules as the Android app's TextInsert: spacing and capitals around a dictated phrase. */
export function insertPhrase(text, selStart, selEnd, phrase) {
  const start = Math.max(0, Math.min(selStart, text.length));
  const end = Math.max(start, Math.min(selEnd, text.length));
  const before = text.slice(0, start), after = text.slice(end);
  let p = phrase.trim();
  if (!p) return [text, end];
  const prev = before.replace(/ +$/, '').slice(-1);
  if (!prev || prev === '\n' || '.!?'.includes(prev)) p = p[0].toUpperCase() + p.slice(1);
  const lead = !before || /\s$/.test(before) ? '' : ' ';
  const trail = after && !/^[\s.,;:!?]/.test(after) ? ' ' : '';
  return [before + lead + p + trail + after, before.length + lead.length + p.length];
}

const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Every word must appear as a word prefix (like the Android app's FTS search). Returns match ranges or null. */
export function matchEntry(entry, query) {
  const words = fold(query).match(/[\p{L}\p{N}]+/gu);
  if (!words) return null;
  const hay = fold(`${entry.title}\n${entry.body}`);
  const ranges = [];
  for (const w of words) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gu');
    let m, found = false;
    while ((m = re.exec(hay))) { found = true; ranges.push([m.index + m[1].length, m.index + m[1].length + w.length]); }
    if (!found) return null;
  }
  return ranges;
}

export function duration(ms) {
  const s = Math.floor((ms ?? 0) / 1000);
  const p = (n) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${Math.floor(s / 60)}:${p(s % 60)}`;
}
