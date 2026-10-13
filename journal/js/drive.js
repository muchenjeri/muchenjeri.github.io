// Drive v3 REST client limited to the hidden appDataFolder (same files the Android app uses).
import { AuthRequiredError, OfflineError } from './engine.js';

const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FIELDS = 'id,name,appProperties,md5Checksum,size,modifiedTime';
const MULTIPART_LIMIT = 4 * 1024 * 1024;

export class DriveHttpError extends Error {
  constructor(status, body) { super(`Google Drive error ${status}: ${body.slice(0, 300)}`); this.status = status; }
}

const parse = (f) => ({
  id: f.id, name: f.name ?? '', props: f.appProperties ?? {}, md5: f.md5Checksum ?? null,
  size: Number(f.size ?? 0), modifiedTime: f.modifiedTime ?? null,
});

export class DriveClient {
  /** getToken(): returns a valid access token or throws AuthRequiredError. onUnauthorized(token): token was rejected. */
  constructor(getToken, onUnauthorized) {
    this.getToken = getToken;
    this.onUnauthorized = onUnauthorized;
    this.idPool = [];
  }

  async #fetch(url, init = {}, attempt = 0) {
    const token = await this.getToken();
    let resp;
    try {
      resp = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
    } catch (e) {
      throw new OfflineError(navigator.onLine === false ? 'Offline' : `Network error: ${e.message}`);
    }
    if (resp.ok) return resp;
    const body = await resp.text().catch(() => '');
    if (resp.status === 401) {
      this.onUnauthorized(token);
      throw new AuthRequiredError();
    }
    const retryable = resp.status === 429 || resp.status >= 500 ||
      (resp.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(body));
    if (retryable && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return this.#fetch(url, init, attempt + 1);
    }
    throw new DriveHttpError(resp.status, body);
  }

  async listAll() {
    const out = [];
    let page = null;
    do {
      const u = new URL(FILES);
      u.searchParams.set('spaces', 'appDataFolder');
      u.searchParams.set('q', 'trashed = false');
      u.searchParams.set('fields', `nextPageToken,files(${FIELDS})`);
      u.searchParams.set('pageSize', '1000');
      if (page) u.searchParams.set('pageToken', page);
      const j = await (await this.#fetch(u)).json();
      out.push(...(j.files ?? []).map(parse));
      page = j.nextPageToken ?? null;
    } while (page);
    return out;
  }

  async newFileId() {
    if (!this.idPool.length) {
      const j = await (await this.#fetch(`${FILES}/generateIds?count=20&space=appDataFolder&type=files`)).json();
      this.idPool.push(...j.ids);
    }
    return this.idPool.shift();
  }

  async get(id) {
    try {
      return parse(await (await this.#fetch(`${FILES}/${id}?fields=${FIELDS}`)).json());
    } catch (e) {
      if (e instanceof DriveHttpError && e.status === 404) return null;
      throw e;
    }
  }

  async downloadText(id) { return (await this.#fetch(`${FILES}/${id}?alt=media`)).text(); }

  async downloadBlob(id, mimeType) {
    const blob = await (await this.#fetch(`${FILES}/${id}?alt=media`)).blob();
    return mimeType ? new Blob([blob], { type: mimeType }) : blob;
  }

  async delete(id) {
    try {
      await this.#fetch(`${FILES}/${id}`, { method: 'DELETE' });
    } catch (e) {
      if (!(e instanceof DriveHttpError && e.status === 404)) throw e;
    }
  }

  /** Create-or-update with a reserved id; falls back to a fresh id if the reserved one can't be used. */
  async put(id, name, props, mimeType, blob, mayExist) {
    const upload = (fid, create) => (blob.size <= MULTIPART_LIMIT
      ? this.#multipart(fid, create, name, props, mimeType, blob)
      : this.#resumable(fid, create, name, props, mimeType, blob));
    if (mayExist) {
      try { return await upload(id, false); } catch (e) { if (!(e instanceof DriveHttpError && e.status === 404)) throw e; }
    }
    try {
      return await upload(id, true);
    } catch (e) {
      if (!(e instanceof DriveHttpError) || e.status < 400 || e.status > 499 || e.status === 429) throw e;
      // Already created by an earlier, interrupted attempt? Then replace it.
      return (await this.get(id)) ? upload(id, false) : upload(await this.newFileId(), true);
    }
  }

  #metadata(id, create, name, props, mimeType) {
    const meta = { name, mimeType, appProperties: props };
    if (create) Object.assign(meta, { id, parents: ['appDataFolder'] });
    return JSON.stringify(meta);
  }

  async #multipart(id, create, name, props, mimeType, blob) {
    const boundary = `mj${crypto.randomUUID().replace(/-/g, '')}`;
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${this.#metadata(id, create, name, props, mimeType)}\r\n`,
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, blob, `\r\n--${boundary}--`,
    ]);
    const url = create ? `${UPLOAD}?uploadType=multipart&fields=${FIELDS}` : `${UPLOAD}/${id}?uploadType=multipart&fields=${FIELDS}`;
    const resp = await this.#fetch(url, {
      method: create ? 'POST' : 'PATCH', body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    });
    return parse(await resp.json());
  }

  async #resumable(id, create, name, props, mimeType, blob) {
    const url = create ? `${UPLOAD}?uploadType=resumable&fields=${FIELDS}` : `${UPLOAD}/${id}?uploadType=resumable&fields=${FIELDS}`;
    const init = await this.#fetch(url, {
      method: create ? 'POST' : 'PATCH',
      body: this.#metadata(id, create, name, props, mimeType),
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mimeType, 'X-Upload-Content-Length': String(blob.size) },
    });
    const session = init.headers.get('Location');
    if (!session) throw new Error("Drive didn't start the upload");
    const resp = await this.#fetch(session, { method: 'PUT', body: blob, headers: { 'Content-Type': mimeType } });
    return parse(await resp.json());
  }
}
