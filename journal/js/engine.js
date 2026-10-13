// Two-way sync with Drive's appDataFolder. A direct port of the Android app's SyncEngine.kt;
// both must follow the same rules (see that file for the full explanation):
//  - a Drive version is applied only to an entry with no unsynced changes (version re-checked);
//  - if both sides changed, both are kept (the local version becomes a "conflict copy");
//  - an edit beats a deletion; permanent deletions leave a tombstone;
//  - a Drive file that vanishes without a tombstone is re-uploaded, never treated as a deletion;
//  - attachments upload before their entry, and every upload is checked against Drive's MD5;
//  - file ids are reserved before uploading so retries never duplicate files.

import * as codec from './codec.js';
import { md5Blob, md5Text } from './md5.js';

export const P_TYPE = 't', P_ENTRY = 'entryId', P_ATT = 'attId', P_REV = 'rev';
export const T_ENTRY = 'entry', T_ATT = 'att';
const JSON_MIME = 'application/json';
const MAX_PASSES = 3;

export const isDirty = (e) => e.localVersion !== e.syncedVersion;
export const entryName = (id) => `entry-${id}.json`;
export const entryProps = (id, rev) => ({ [P_TYPE]: T_ENTRY, [P_ENTRY]: id, [P_REV]: rev });
export const attName = (a) => `att-${codec.archiveName(a)}`;
export const attProps = (a) => ({ [P_TYPE]: T_ATT, [P_ATT]: a.id, [P_ENTRY]: a.entryId });
export const newRev = () => crypto.randomUUID();

export class AuthRequiredError extends Error {
  constructor() { super('Google Drive access needs to be granted again'); this.name = 'AuthRequiredError'; }
}
/** Thrown by the remote store when the network is unavailable: stop and retry later. */
export class OfflineError extends Error {
  constructor(msg = 'Offline') { super(msg); this.name = 'OfflineError'; }
}

export class SyncEngine {
  constructor(local, remote, clock = () => Date.now()) {
    this.local = local;
    this.remote = remote;
    this.clock = clock;
    this.running = null;
  }

  /** Runs a sync; concurrent callers share the running one. */
  sync() {
    if (!this.running) this.running = this.#run().finally(() => { this.running = null; });
    return this.running;
  }

  async #run() {
    const total = { pulled: 0, pushed: 0, conflicts: 0, errors: [], warnings: [] };
    for (let i = 0; i < MAX_PASSES; i++) {
      const r = await this.#pass();
      for (const k of ['pulled', 'pushed', 'conflicts']) total[k] += r[k];
      total.errors.push(...r.errors);
      total.warnings.push(...r.warnings);
      if (r.errors.length || (await this.local.dirtyEntries()).length === 0) break;
    }
    total.warnings = [...new Set(total.warnings)];
    return total;
  }

  async #guard(errors, what, fn) {
    try {
      await fn();
    } catch (e) {
      if (e instanceof AuthRequiredError || e instanceof OfflineError) throw e;
      errors.push(`${what}: ${e.message || e}`);
    }
  }

  async #pass() {
    const errors = [], warnings = [];
    let pulled = 0, pushed = 0, conflicts = 0;
    const { local, remote } = this;

    const listing = await remote.listAll();
    const remoteEntries = new Map(), remoteAtts = new Map();
    for (const f of listing) {
      if (f.props[P_TYPE] === T_ENTRY && f.props[P_ENTRY]) {
        const prev = remoteEntries.get(f.props[P_ENTRY]);
        if (!prev || (f.modifiedTime ?? '') > (prev.modifiedTime ?? '')) remoteEntries.set(f.props[P_ENTRY], f);
      } else if (f.props[P_TYPE] === T_ATT && f.props[P_ATT]) {
        remoteAtts.set(f.props[P_ATT], f);
      }
    }

    // 1. Bring in changes made on other devices.
    for (const [id, rf] of remoteEntries) {
      await this.#guard(errors, "Couldn't download an entry", async () => {
        const r = await this.#pullEntry(id, rf);
        if (r === 'applied') pulled++;
        if (r === 'conflict') { pulled++; conflicts++; }
      });
    }

    // 2. Drive copies that disappeared without a tombstone.
    const remoteFileIds = new Set(listing.map((f) => f.id));
    for (const e of await local.allEntries()) {
      if (!e.remoteFileId || e.remoteRev == null || e.purgedAt != null || remoteFileIds.has(e.remoteFileId) || remoteEntries.has(e.id)) continue;
      await this.#guard(errors, "Couldn't check an entry on Drive", async () => {
        if ((await remote.get(e.remoteFileId)) == null) await local.forgetRemote(e.id);
      });
    }
    for (const a of await local.allAttachments()) {
      if (!a.uploaded || a.removedAt != null || remoteAtts.has(a.id)) continue;
      await this.#guard(errors, "Couldn't check an attachment on Drive", async () => {
        const still = a.remoteFileId ? await remote.get(a.remoteFileId) : null;
        if (still) remoteAtts.set(a.id, still);
        else if (await local.hasBlob(a.fileName)) await local.setAttachmentRemote(a.id, null, false);
      });
    }

    // 3. Send local changes.
    for (const e of await local.dirtyEntries()) {
      await this.#guard(errors, "Couldn't upload an entry", async () => {
        if (await this.#push(e.id, remoteAtts, warnings)) pushed++;
      });
    }

    // 4. Download attachment files this device doesn't have yet.
    for (const a of await local.allAttachments()) {
      if (a.removedAt != null || (await local.hasBlob(a.fileName))) continue;
      await this.#guard(errors, "Couldn't download an attachment", async () => {
        const rf = remoteAtts.get(a.id) ?? (a.remoteFileId ? await remote.get(a.remoteFileId) : null);
        if (!rf) {
          warnings.push(`An attachment (${codec.archiveName(a)}) is missing from both this device and Drive.`);
          return;
        }
        const blob = await remote.downloadBlob(rf.id, a.mimeType);
        if (rf.md5 && (await md5Blob(blob)) !== rf.md5.toLowerCase()) throw new Error(`Downloaded ${rf.name} didn't match Drive's checksum`);
        await local.saveBlob(a.fileName, blob);
        await local.setAttachmentRemote(a.id, rf.id, true);
      });
    }

    return { pulled, pushed, conflicts, errors, warnings };
  }

  async #pullEntry(id, rf) {
    const { local, remote } = this;
    const known = await local.entry(id);
    if (known && known.remoteRev != null && known.remoteRev === rf.props[P_REV]) {
      if (known.remoteFileId !== rf.id) await local.setEntryFileId(id, rf.id);
      return 'none';
    }
    const doc = codec.decode(await remote.downloadText(rf.id));
    if (doc.id !== id) throw new Error(`Drive file ${rf.name} holds a different entry`);

    const e = await local.entry(id);
    if (!e) return !doc.purged && (await local.insertRemote(doc, rf.id)) ? 'applied' : 'none';
    if (!isDirty(e)) {
      if (doc.purged) return (await local.deleteEntryCompletely(id, e.localVersion)) ? 'applied' : 'none';
      return (await local.applyRemote(doc, rf.id, e.localVersion)) ? 'applied' : 'none';
    }
    // Both sides changed since the last sync.
    if (doc.purged) {
      await local.adoptRemote(id, rf.id, doc.rev, e.localVersion, false); // edit beats deletion elsewhere
      return 'none';
    }
    if (e.purgedAt != null) return (await local.applyRemote(doc, rf.id, e.localVersion)) ? 'applied' : 'none';
    const snap = await local.snapshot(id);
    if (codec.sameContent(e, snap ? snap.attachments : [], doc)) {
      await local.adoptRemote(id, rf.id, doc.rev, e.localVersion, true);
      return 'none';
    }
    return (await local.resolveConflict(doc, rf.id, e.localVersion)) != null ? 'conflict' : 'none';
  }

  async #push(id, remoteAtts, warnings) {
    const { local, remote } = this;
    const snap = await local.snapshot(id);
    if (!snap || !isDirty(snap.entry)) return false;
    const { entry: e, attachments: atts } = snap;

    const fileId0 = e.remoteFileId;
    if (fileId0 && e.remoteRev != null) {
      const current = await remote.get(fileId0);
      if (current && current.props[P_REV] !== e.remoteRev) return false; // merge first, next pass
    }

    const remoteIdOf = (a) => a.remoteFileId ?? remoteAtts.get(a.id)?.id ?? null;

    if (e.purgedAt != null) {
      if (fileId0) {
        const rev = newRev();
        const text = codec.encode(codec.tombstone(e, rev, this.clock()));
        const stored = await remote.put(fileId0, entryName(id), entryProps(id, rev), JSON_MIME, new Blob([text]), e.remoteRev != null);
        await this.#verify(stored, md5Text(text), entryName(id));
      }
      for (const a of atts) { const rid = remoteIdOf(a); if (rid) await remote.delete(rid); }
      return local.deleteEntryCompletely(id, e.localVersion);
    }

    for (const a of atts) {
      if (a.removedAt != null || a.uploaded) continue;
      const blob = await local.getBlob(a.fileName);
      if (!blob) {
        warnings.push(`An attachment (${codec.archiveName(a)}) is missing on this device and can't be uploaded.`);
        continue;
      }
      let reserved = a.remoteFileId;
      if (!reserved) { reserved = await remote.newFileId(); await local.setAttachmentRemote(a.id, reserved, false); }
      const stored = await remote.put(reserved, attName(a), attProps(a), a.mimeType, blob, false);
      await this.#verify(stored, a.md5, attName(a));
      await local.setAttachmentRemote(a.id, stored.id, true);
    }

    const rev = newRev();
    const text = codec.encode(codec.fromLocal(e, atts, rev));
    let fileId = fileId0;
    if (!fileId) { fileId = await remote.newFileId(); await local.setEntryFileId(id, fileId); }
    const stored = await remote.put(fileId, entryName(id), entryProps(id, rev), JSON_MIME, new Blob([text]), e.remoteRev != null);
    await this.#verify(stored, md5Text(text), entryName(id));
    await local.markSynced(id, e.localVersion, stored.id, rev);

    for (const a of atts) {
      if (a.removedAt == null) continue;
      const rid = remoteIdOf(a);
      if (rid) await remote.delete(rid);
      await local.dropAttachment(a.id);
    }
    return true;
  }

  async #verify(stored, expectedMd5, name) {
    const md5 = stored.md5 ?? (await this.remote.get(stored.id))?.md5;
    if (md5 && md5.toLowerCase() !== expectedMd5.toLowerCase()) throw new Error(`Drive's copy of ${name} didn't match what was sent`);
  }
}
