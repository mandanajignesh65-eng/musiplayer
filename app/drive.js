// Google Drive calls the page needs: find the "Music Player" folder and read or write its small JSON files.
// Songs themselves stream through the service worker (sw.js).
import { getToken } from './auth.js';

const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';
const folders = new Map();

async function call(url, options = {}) {
  let res;
  for (const force of [false, true]) {
    const token = await getToken({ force });
    res = await fetch(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } });
    if (res.status !== 401) break;
  }
  if (!res.ok) throw new Error(`Google Drive error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

const quote = (text) => text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function find(name, parent, folder = false) {
  let q = `name = '${quote(name)}' and '${parent}' in parents and trashed = false`;
  if (folder) q += ` and mimeType = '${FOLDER}'`;
  const res = await call(`${API}?${new URLSearchParams({ q, fields: 'files(id)', pageSize: '1', spaces: 'drive' })}`);
  return (await res.json()).files[0]?.id ?? null;
}

async function folder(name, parent = 'root') {
  const key = `${parent}/${name}`;
  if (!folders.has(key)) {
    let id = await find(name, parent, true);
    if (!id) {
      const res = await call(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
      });
      id = (await res.json()).id;
    }
    folders.set(key, id);
  }
  return folders.get(key);
}

const appDir = async () => folder('_app', await folder('Music Player'));

export async function readJson(name, fallback) {
  const id = await find(name, await appDir());
  if (!id) return fallback;
  return (await call(`${API}/${id}?alt=media`, { cache: 'no-store' })).json();
}

export async function writeJson(name, data) {
  const parent = await appDir();
  const body = JSON.stringify(data, null, 1);
  const id = await find(name, parent);
  if (id) {
    await call(`${UPLOAD}/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
    return;
  }
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ name, parents: [parent] })], { type: 'application/json' }));
  form.append('file', new Blob([body], { type: 'application/json' }));
  await call(`${UPLOAD}?uploadType=multipart`, { method: 'POST', body: form });
}
