// The journal on this device. Mirrors the Android JournalRepository: every change is one
// transaction, bumps the entry's localVersion, and then notifies listeners (UI + sync scheduler).
// Methods taking expectedVersion do nothing if the entry changed meanwhile, so a sync can never
// overwrite an edit it hasn't seen.

import { isDirty } from './engine.js';

export const conflictTitle = (title) => `${title.trim() ? title : 'Untitled'} (conflict copy)`;

export class LocalJournal {
  constructor(store, clock = () => Date.now()) {
    this.store = store;
    this.clock = clock;
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  #changed(local = true) { for (const fn of this.listeners) fn(local); }

  // ---- Reading ----

  entry(id) { return this.store.tx('readonly', (t) => t.get('entries', id)); }
  allEntries() { return this.store.tx('readonly', (t) => t.all('entries')); }
  allAttachments() { return this.store.tx('readonly', (t) => t.all('attachments')); }
  async dirtyEntries() {
    return (await this.allEntries()).filter(isDirty).sort((a, b) => a.updatedAt - b.updatedAt);
  }
  snapshot(id) {
    return this.store.tx('readonly', async (t) => {
      const entry = await t.get('entries', id);
      if (!entry) return null;
      return { entry, attachments: (await t.byIndex('attachments', 'entryId', id)).sort((a, b) => a.position - b.position) };
    });
  }
  async activeAttachments(entryId) {
    return ((await this.snapshot(entryId))?.attachments ?? []).filter((a) => a.removedAt == null);
  }
  async getBlob(fileName) { return (await this.store.tx('readonly', (t) => t.get('blobs', fileName)))?.blob ?? null; }
  async hasBlob(fileName) { return (await this.getBlob(fileName)) != null; }
  async saveBlob(fileName, blob) { await this.store.tx('readwrite', (t) => t.put('blobs', { fileName, blob })); this.#changed(false); }
  async getMeta(key) { return (await this.store.tx('readonly', (t) => t.get('meta', key)))?.value; }
  async setMeta(key, value) { await this.store.tx('readwrite', (t) => t.put('meta', { key, value })); }

  // ---- Writing (from the UI) ----

  /** Creates the entry if needed, otherwise updates its text if it changed. */
  async saveText(id, title, body, entryAtIfNew = null) {
    const changed = await this.store.tx('readwrite', async (t) => {
      const e = await t.get('entries', id);
      const now = this.clock();
      if (!e) {
        await t.put('entries', {
          id, title, body, createdAt: now, entryAt: entryAtIfNew ?? now, updatedAt: now,
          deletedAt: null, purgedAt: null, localVersion: 1, syncedVersion: 0, remoteFileId: null, remoteRev: null,
        });
        return true;
      }
      if (e.title === title && e.body === body) return false;
      await t.put('entries', { ...e, title, body, updatedAt: now, localVersion: e.localVersion + 1 });
      return true;
    });
    if (changed) this.#changed();
  }

  async #change(id, f) {
    await this.store.tx('readwrite', async (t) => {
      const e = await t.get('entries', id);
      if (!e) return;
      await t.put('entries', { ...f(e), updatedAt: this.clock(), localVersion: e.localVersion + 1 });
    });
    this.#changed();
  }

  setEntryAt(id, at) { return this.#change(id, (e) => ({ ...e, entryAt: at })); }
  moveToTrash(id) { return this.#change(id, (e) => ({ ...e, deletedAt: this.clock() })); }
  restore(id) { return this.#change(id, (e) => ({ ...e, deletedAt: null })); }

  /** Permanent deletion; completed by the next sync, which also removes it from Drive. */
  async purge(id) {
    const orphans = await this.store.tx('readwrite', async (t) => {
      const e = await t.get('entries', id);
      if (!e) return [];
      const atts = await t.byIndex('attachments', 'entryId', id);
      if (!e.remoteFileId && atts.every((a) => !a.remoteFileId)) {
        for (const a of atts) await t.delete('attachments', a.id);
        await t.delete('entries', id);
        return atts.map((a) => a.fileName);
      }
      await t.put('entries', { ...e, purgedAt: this.clock(), updatedAt: this.clock(), localVersion: e.localVersion + 1 });
      return [];
    });
    await this.#deleteUnreferenced(orphans);
    this.#changed();
  }

  /** Stores a copy of the file and attaches it. The entry must exist. */
  async addAttachment(entryId, { blob, kind, mimeType, extension, md5, takenAt = null, durationMs = null }) {
    const id = crypto.randomUUID();
    const fileName = `${id}.${extension}`;
    const att = await this.store.tx('readwrite', async (t) => {
      const e = await t.get('entries', entryId);
      if (!e) throw new Error('Entry not saved yet');
      const existing = await t.byIndex('attachments', 'entryId', entryId);
      const a = {
        id, entryId, kind, fileName, mimeType, createdAt: this.clock(), takenAt, durationMs,
        sizeBytes: blob.size, md5, position: existing.reduce((m, x) => Math.max(m, x.position), -1) + 1,
        removedAt: null, remoteFileId: null, uploaded: false,
      };
      await t.put('blobs', { fileName, blob });
      await t.put('attachments', a);
      await t.put('entries', { ...e, updatedAt: this.clock(), localVersion: e.localVersion + 1 });
      return a;
    });
    this.#changed();
    return att;
  }

  async removeAttachment(attId) {
    const orphan = await this.store.tx('readwrite', async (t) => {
      const a = await t.get('attachments', attId);
      if (!a) return null;
      const e = await t.get('entries', a.entryId);
      let result = null;
      if (!a.remoteFileId && !a.uploaded) {
        await t.delete('attachments', a.id);
        result = a.fileName;
      } else {
        await t.put('attachments', { ...a, removedAt: this.clock() });
      }
      if (e) await t.put('entries', { ...e, updatedAt: this.clock(), localVersion: e.localVersion + 1 });
      return result;
    });
    if (orphan) await this.#deleteUnreferenced([orphan]);
    this.#changed();
  }

  // ---- Used by the sync engine ----

  async insertRemote(doc, fileId) {
    const r = await this.store.tx('readwrite', async (t) => {
      if (await t.get('entries', doc.id)) return null;
      await t.put('entries', {
        id: doc.id, title: doc.title, body: doc.body, createdAt: doc.createdAt, entryAt: doc.entryAt,
        updatedAt: doc.updatedAt, deletedAt: doc.deletedAt, purgedAt: null, localVersion: 1, syncedVersion: 1,
        remoteFileId: fileId, remoteRev: doc.rev,
      });
      return this.#replaceAttachments(t, doc);
    });
    return this.#afterRemote(r);
  }

  async applyRemote(doc, fileId, expectedVersion) {
    const r = await this.store.tx('readwrite', async (t) => {
      const e = await t.get('entries', doc.id);
      if (!e || e.localVersion !== expectedVersion) return null;
      return this.#overwrite(t, e, doc, fileId);
    });
    return this.#afterRemote(r);
  }

  async resolveConflict(doc, fileId, expectedVersion) {
    let copyId = null;
    const r = await this.store.tx('readwrite', async (t) => {
      const e = await t.get('entries', doc.id);
      if (!e || e.localVersion !== expectedVersion) return null;
      copyId = crypto.randomUUID();
      await t.put('entries', {
        ...e, id: copyId, title: conflictTitle(e.title), updatedAt: this.clock(), purgedAt: null,
        localVersion: 1, syncedVersion: 0, remoteFileId: null, remoteRev: null,
      });
      // The copy shares the (never-modified) local files; they upload under new ids.
      for (const a of await t.byIndex('attachments', 'entryId', e.id)) {
        if (a.removedAt != null) continue;
        await t.put('attachments', { ...a, id: crypto.randomUUID(), entryId: copyId, remoteFileId: null, uploaded: false });
      }
      return this.#overwrite(t, e, doc, fileId);
    });
    await this.#afterRemote(r);
    return r ? copyId : null;
  }

  async #overwrite(t, e, doc, fileId) {
    const v = e.localVersion + 1;
    await t.put('entries', {
      ...e, title: doc.title, body: doc.body, createdAt: doc.createdAt, entryAt: doc.entryAt,
      updatedAt: doc.updatedAt, deletedAt: doc.deletedAt, purgedAt: null,
      localVersion: v, syncedVersion: v, remoteFileId: fileId, remoteRev: doc.rev,
    });
    return this.#replaceAttachments(t, doc);
  }

  /** Inside a transaction: makes the entry's attachment rows match doc. Returns file names that may be unused now. */
  async #replaceAttachments(t, doc) {
    const existing = new Map((await t.byIndex('attachments', 'entryId', doc.id)).map((a) => [a.id, a]));
    const wanted = new Set(doc.attachments.map((a) => a.id));
    for (const [i, ad] of doc.attachments.entries()) {
      const ex = existing.get(ad.id);
      await t.put('attachments', ex ? { ...ex, position: i, removedAt: null, uploaded: true } : {
        id: ad.id, entryId: doc.id, kind: ad.kind, fileName: `${ad.id}.${ad.extension}`, mimeType: ad.mimeType,
        createdAt: ad.createdAt, takenAt: ad.takenAt, durationMs: ad.durationMs, sizeBytes: ad.sizeBytes,
        md5: ad.md5, position: i, removedAt: null, remoteFileId: null, uploaded: true,
      });
    }
    const dropped = [...existing.values()].filter((a) => !wanted.has(a.id));
    for (const a of dropped) await t.delete('attachments', a.id);
    return dropped.map((a) => a.fileName);
  }

  async #afterRemote(orphans) {
    if (orphans == null) return false;
    await this.#deleteUnreferenced(orphans);
    this.#changed(false);
    return true;
  }

  async adoptRemote(id, fileId, rev, expectedVersion, markSynced) {
    const ok = await this.store.tx('readwrite', async (t) => {
      const e = await t.get('entries', id);
      if (!e || e.localVersion !== expectedVersion) return false;
      await t.put('entries', { ...e, remoteFileId: fileId, remoteRev: rev, syncedVersion: markSynced ? e.localVersion : e.syncedVersion });
      return true;
    });
    if (ok) this.#changed(false);
    return ok;
  }

  async setEntryFileId(id, fileId) {
    await this.store.tx('readwrite', async (t) => {
      const e = await t.get('entries', id);
      if (e) await t.put('entries', { ...e, remoteFileId: fileId });
    });
  }

  async markSynced(id, version, fileId, rev) {
    await this.store.tx('readwrite', async (t) => {
      const e = await t.get('entries', id);
      if (!e) return;
      await t.put('entries', { ...e, syncedVersion: Math.max(e.syncedVersion, Math.min(version, e.localVersion)), remoteFileId: fileId, remoteRev: rev });
    });
    this.#changed(false);
  }

  async forgetRemote(id) {
    await this.store.tx('readwrite', async (t) => {
      const e = await t.get('entries', id);
      if (e) await t.put('entries', { ...e, remoteRev: null, localVersion: e.localVersion + 1 });
    });
  }

  async setAttachmentRemote(id, fileId, uploaded) {
    await this.store.tx('readwrite', async (t) => {
      const a = await t.get('attachments', id);
      if (a) await t.put('attachments', { ...a, remoteFileId: fileId, uploaded });
    });
  }

  async dropAttachment(id) {
    const name = await this.store.tx('readwrite', async (t) => {
      const a = await t.get('attachments', id);
      if (!a) return null;
      await t.delete('attachments', id);
      return a.fileName;
    });
    if (name) await this.#deleteUnreferenced([name]);
  }

  async deleteEntryCompletely(id, expectedVersion) {
    const names = await this.store.tx('readwrite', async (t) => {
      const e = await t.get('entries', id);
      if (!e || e.localVersion !== expectedVersion) return null;
      const atts = await t.byIndex('attachments', 'entryId', id);
      for (const a of atts) await t.delete('attachments', a.id);
      await t.delete('entries', id);
      return atts.map((a) => a.fileName);
    });
    if (names == null) return false;
    await this.#deleteUnreferenced(names);
    this.#changed(false);
    return true;
  }

  async #deleteUnreferenced(fileNames) {
    for (const name of new Set(fileNames)) {
      await this.store.tx('readwrite', async (t) => {
        if ((await t.count('attachments', 'fileName', name)) === 0) await t.delete('blobs', name);
      });
    }
  }
}
