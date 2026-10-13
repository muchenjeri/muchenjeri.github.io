// Export archive, same layout as the Android app's (see the README):
//   README.txt, journal.json, entries/YYYY/MM/*.md, entries/recently-deleted/*.md, attachments/<id>.<ext>
import * as codec from './codec.js';
import { duration } from './util.js';

const pad = (n) => String(n).padStart(2, '0');

export function slug(title) {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

export function markdownPath(e) {
  const d = new Date(e.entryAt);
  const s = slug(e.title);
  const name = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${s ? `_${s}` : ''}_${e.id.slice(0, 8)}.md`;
  return e.deletedAt != null ? `entries/recently-deleted/${name}` : `entries/${d.getFullYear()}/${pad(d.getMonth() + 1)}/${name}`;
}

export function markdown(e, attachments) {
  const path = markdownPath(e);
  const up = '../'.repeat(path.split('/').length - 1);
  const atts = attachments.filter((a) => a.removedAt == null).sort((a, b) => a.position - b.position);
  const heading = e.title.trim() ? e.title : new Date(e.entryAt).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const lines = ['---', `id: ${e.id}`, `title: ${JSON.stringify(e.title)}`, `date: ${codec.iso(e.entryAt)}`,
    `created: ${codec.iso(e.createdAt)}`, `modified: ${codec.iso(e.updatedAt)}`];
  if (e.deletedAt != null) lines.push(`deleted: ${codec.iso(e.deletedAt)}`);
  if (atts.length) { lines.push('attachments:'); for (const a of atts) lines.push(`  - attachments/${codec.archiveName(a)}`); }
  lines.push('---', '', `# ${heading}`, '');
  if (e.body.trim()) lines.push(e.body.trimEnd(), '');
  if (atts.length) {
    lines.push('## Attachments', '');
    for (const a of atts) {
      const link = `${up}attachments/${codec.archiveName(a)}`;
      lines.push(a.kind === 'photo' ? `![Photo](${link})` : `[Voice note${a.durationMs ? ` (${duration(a.durationMs)})` : ''}](${link})`, '');
    }
  }
  return lines.join('\n') + '\n';
}

export function readme(exportedAt, entryCount, attachmentCount) {
  return `Muchenjeri Journal export
=========================

Exported: ${codec.iso(exportedAt)}
Entries: ${entryCount}
Attachments: ${attachmentCount}

Everything here is plain text or the original media files, so it can be read without the app.

entries/YYYY/MM/*.md
    One Markdown file per entry, in folders by year and month. The block between the "---"
    lines (YAML front matter) holds the entry's id, title, date, creation and modification
    times. Photos and voice notes are linked at the bottom with relative paths.

entries/recently-deleted/*.md
    Entries that were in Recently deleted when you exported.

attachments/
    Original photos and voice notes (.m4a from the phone; .webm or .m4a from the browser).

journal.json
    The complete journal in one JSON file, used by the Android app's "Import from export".
`;
}

// ---- ZIP writer (stored, no compression; media is already compressed) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** files: [{ name, data: Uint8Array }] -> Blob (application/zip). */
export function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = new TextEncoder().encode(f.name);
    const crc = crc32(f.data);
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true); header.setUint16(4, 20, true); header.setUint16(6, 0x0800, true); // UTF-8 names
    header.setUint16(10, dosTime, true); header.setUint16(12, dosDate, true);
    header.setUint32(14, crc, true); header.setUint32(18, f.data.length, true); header.setUint32(22, f.data.length, true);
    header.setUint16(26, name.length, true);
    parts.push(header, name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true);
    c.setUint32(16, crc, true); c.setUint32(20, f.data.length, true); c.setUint32(24, f.data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(c, name);
    offset += 30 + name.length + f.data.length;
  }
  const centralSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

/** Builds the whole export from the local journal. */
export async function exportJournal(journal) {
  const enc = (s) => new TextEncoder().encode(s);
  const entries = (await journal.allEntries()).filter((e) => e.purgedAt == null).sort((a, b) => a.entryAt - b.entryAt);
  const allAtts = (await journal.allAttachments()).filter((a) => a.removedAt == null);
  const byEntry = new Map();
  for (const a of allAtts) { if (!byEntry.has(a.entryId)) byEntry.set(a.entryId, []); byEntry.get(a.entryId).push(a); }
  const files = [];
  const exported = entries.flatMap((e) => byEntry.get(e.id) ?? []);
  const now = Date.now();
  files.push({ name: 'README.txt', data: enc(readme(now, entries.length, exported.length)) });
  files.push({
    name: 'journal.json',
    data: enc(JSON.stringify({
      format: 'muchenjeri-journal-export', formatVersion: 1, exportedAt: codec.iso(now),
      entries: entries.map((e) => codec.toJson(codec.fromLocal(e, byEntry.get(e.id) ?? [], e.remoteRev ?? ''))),
    }, null, 2)),
  });
  for (const e of entries) files.push({ name: markdownPath(e), data: enc(markdown(e, byEntry.get(e.id) ?? [])) });
  let missing = 0;
  for (const a of exported) {
    const blob = await journal.getBlob(a.fileName);
    if (!blob) { missing++; continue; }
    files.push({ name: `attachments/${codec.archiveName(a)}`, data: new Uint8Array(await blob.arrayBuffer()) });
  }
  return { blob: zip(files), entries: entries.length, attachments: exported.length - missing, missing };
}
