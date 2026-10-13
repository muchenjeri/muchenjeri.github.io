// The entry document stored on Drive and in exports. Must stay identical to the Android
// app's EntryCodec ("muchenjeri-journal-entry", format 1).

export const FORMAT = 'muchenjeri-journal-entry';
export const FORMAT_VERSION = 1;

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** ISO 8601 with the local UTC offset, e.g. 2026-10-11T14:22:05.120-05:00 (offsetMinutes for tests). */
export function iso(ms, offsetMinutes = -new Date(ms).getTimezoneOffset()) {
  const d = new Date(ms + offsetMinutes * 60000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const off = Math.abs(offsetMinutes);
  const frac = d.getUTCMilliseconds() ? '.' + pad(d.getUTCMilliseconds(), 3) : '';
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${frac}` +
    (off === 0 ? 'Z' : `${sign}${pad(Math.floor(off / 60))}:${pad(off % 60)}`);
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;

/** Parses Java's ISO_OFFSET_DATE_TIME output (seconds and fraction optional, 1-9 fraction digits). */
export function parse(s) {
  const m = ISO_RE.exec(s);
  if (!m) throw new Error(`Bad timestamp: ${s}`);
  const [, y, mo, d, h, mi, sec = '0', frac = '', off] = m;
  const ms = Number((frac + '000').slice(0, 3));
  let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec, ms);
  if (off !== 'Z') {
    const sign = off[0] === '-' ? -1 : 1;
    t -= sign * (Number(off.slice(1, 3)) * 60 + Number(off.slice(4, 6))) * 60000;
  }
  return t;
}

export const extensionOf = (fileName) => {
  const i = fileName.lastIndexOf('.');
  return i < 0 ? 'bin' : fileName.slice(i + 1);
};
export const archiveName = (att) => `${att.id}.${extensionOf(att.fileName)}`;

/** Entry + attachment records (local shape) -> EntryDoc. */
export function fromLocal(e, attachments, rev) {
  return {
    id: e.id, title: e.title, body: e.body,
    createdAt: e.createdAt, entryAt: e.entryAt, updatedAt: e.updatedAt,
    deletedAt: e.deletedAt ?? null, purged: false, rev,
    attachments: attachments.filter((a) => a.removedAt == null).sort((a, b) => a.position - b.position).map((a) => ({
      id: a.id, kind: a.kind, mimeType: a.mimeType, extension: extensionOf(a.fileName),
      createdAt: a.createdAt, takenAt: a.takenAt ?? null, durationMs: a.durationMs ?? null,
      sizeBytes: a.sizeBytes, md5: a.md5,
    })),
  };
}

export function tombstone(e, rev, now) {
  return {
    id: e.id, title: '', body: '', createdAt: e.createdAt, entryAt: e.entryAt, updatedAt: now,
    deletedAt: e.deletedAt ?? now, purged: true, rev, attachments: [],
  };
}

/** Same text, date, trash state and attachments (ignores sync bookkeeping). */
export function sameContent(e, attachments, doc) {
  if (doc.purged || e.purgedAt != null) return false;
  const ids = attachments.filter((a) => a.removedAt == null).sort((a, b) => a.position - b.position).map((a) => a.id);
  return e.title === doc.title && e.body === doc.body && e.entryAt === doc.entryAt &&
    (e.deletedAt != null) === (doc.deletedAt != null) &&
    ids.length === doc.attachments.length && ids.every((id, i) => id === doc.attachments[i].id);
}

export function toJson(doc) {
  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    id: doc.id,
    title: doc.title,
    body: doc.body,
    createdAt: iso(doc.createdAt),
    entryAt: iso(doc.entryAt),
    updatedAt: iso(doc.updatedAt),
    deletedAt: doc.deletedAt != null ? iso(doc.deletedAt) : null,
    purged: doc.purged,
    rev: doc.rev,
    attachments: doc.attachments.map((a) => ({
      id: a.id,
      kind: a.kind,
      file: `attachments/${a.id}.${a.extension}`,
      mimeType: a.mimeType,
      createdAt: iso(a.createdAt),
      takenAt: a.takenAt != null ? iso(a.takenAt) : null,
      durationMs: a.durationMs ?? null,
      sizeBytes: a.sizeBytes,
      md5: a.md5,
    })),
  };
}

export const encode = (doc) => JSON.stringify(toJson(doc), null, 2);

export function fromJson(j) {
  if (j.format !== FORMAT) throw new Error('Not a journal entry document');
  if ((j.formatVersion ?? 1) > FORMAT_VERSION) throw new Error(`Entry was written by a newer version of the app (format ${j.formatVersion})`);
  return {
    id: j.id,
    title: j.title ?? '',
    body: j.body ?? '',
    createdAt: parse(j.createdAt),
    entryAt: parse(j.entryAt),
    updatedAt: parse(j.updatedAt),
    deletedAt: j.deletedAt ? parse(j.deletedAt) : null,
    purged: !!j.purged,
    rev: j.rev ?? '',
    attachments: (j.attachments ?? []).map((a) => ({
      id: a.id,
      kind: a.kind,
      mimeType: a.mimeType ?? '',
      extension: extensionOf(a.file),
      createdAt: parse(a.createdAt),
      takenAt: a.takenAt ? parse(a.takenAt) : null,
      durationMs: a.durationMs ?? null,
      sizeBytes: a.sizeBytes ?? 0,
      md5: a.md5 ?? '',
    })),
  };
}

export const decode = (text) => fromJson(JSON.parse(text));
