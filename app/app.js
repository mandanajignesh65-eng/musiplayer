import { isSignedIn, signIn, finishSignIn, signOut, SignedOut } from './auth.js';
import { readJson, writeJson } from './drive.js';
import { CLIENT_ID } from './config.js';

const $ = (id) => document.getElementById(id);
const audio = $('audio');
const view = $('view');

const state = {
  tab: 'songs',
  playlistId: null,
  query: '',
  tracks: [], // every song, newest first
  byId: new Map(),
  playlists: [],
  linkInfo: new Map(), // link id -> its playlist in library.json
  links: [], // sources.json: the links you saved
  status: {}, // sync-status.json, written by the PC
  request: null, // when Sync was last pressed in the app
};
const queue = { ids: [], order: [], pos: -1, shuffle: false, repeat: 'off', failures: 0 };

// ---------- small helpers ----------

const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function fmt(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  const m = Math.floor(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${(m % 60).toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function ago(iso) {
  const min = Math.round((Date.now() - new Date(iso)) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.round(min / 60)} h ago`;
  return new Date(iso).toLocaleDateString();
}

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- loading data from Drive ----------

async function loadLibrary() {
  const lib = await readJson('library.json', { tracks: {}, playlists: [] });
  state.tracks = Object.values(lib.tracks).sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
  state.byId = new Map(state.tracks.map((t) => [t.id, t]));
  const known = (ids) => ids.filter((id) => state.byId.has(id));
  state.playlists = lib.playlists.filter((p) => !p.single).map((p) => ({ id: p.sourceId, name: p.name, tracks: known(p.tracks) }));
  // Links to single songs are grouped by name: "Singles", or the name you typed above them, like "# Focus".
  const groups = new Map();
  for (const p of lib.playlists.filter((x) => x.single)) groups.set(p.name, [...(groups.get(p.name) ?? []), ...known(p.tracks)]);
  for (const [name, ids] of groups) state.playlists.push({ id: `group:${name}`, name, tracks: [...new Set(ids)] });
  state.linkInfo = new Map(lib.playlists.map((p) => [p.sourceId, p]));
}

async function loadSync() {
  const [status, request, links] = await Promise.all([
    readJson('sync-status.json', {}),
    readJson('sync-request.json', {}),
    readJson('sources.json', []),
  ]);
  state.status = status;
  state.request = request.requestedAt ?? null;
  state.links = links;
}

const pcOnline = () => state.status.pcSeenAt && Date.now() - new Date(state.status.pcSeenAt) < 6 * 60000;
const syncPending = () => state.request && state.request !== state.status.handledRequest;
const syncRunning = () => state.status.state === 'running' && pcOnline();

let pollTimer;
function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, syncRunning() || syncPending() ? 8000 : 60000);
}

async function poll() {
  if (document.visibilityState === 'visible') {
    try {
      const before = JSON.stringify([state.status.added, state.status.finishedAt]);
      await loadSync();
      if (JSON.stringify([state.status.added, state.status.finishedAt]) !== before) {
        await loadLibrary();
        if (state.tab !== 'add') render();
      }
      if (state.tab === 'add') renderSync();
    } catch (err) {
      if (err instanceof SignedOut) return showSignin(err.message);
    }
  }
  schedulePoll();
}

// ---------- screens ----------

function songRows(ids) {
  const current = currentTrack()?.id;
  return ids.map((id, i) => {
    const t = state.byId.get(id);
    return `<li><button class="row${id === current ? ' playing' : ''}" data-play="${i}">
      <img loading="lazy" src="${esc(t.cover)}" alt="">
      <span class="meta"><b>${esc(t.title)}</b><small>${esc(t.artist)}</small></span>
      <span class="dur">${fmt(t.duration)}</span></button></li>`;
  }).join('');
}

function visibleIds() {
  const q = state.query.trim().toLowerCase();
  if (q) return state.tracks.filter((t) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q)).map((t) => t.id);
  if (state.tab === 'playlists' && state.playlistId) return state.playlists.find((p) => p.id === state.playlistId)?.tracks ?? [];
  return state.tracks.map((t) => t.id);
}

function render() {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === state.tab && !state.query));
  if (state.query) return renderSongs(`Results for “${esc(state.query)}”`);
  if (state.tab === 'add') return renderAdd();
  if (state.tab === 'playlists') return state.playlistId ? renderPlaylist() : renderPlaylists();
  return renderSongs('All songs');
}

function renderSongs(title) {
  const ids = visibleIds();
  if (!ids.length) {
    view.innerHTML = state.query
      ? `<p class="empty">No songs match “${esc(state.query)}”.</p>`
      : `<div class="empty"><h2>No songs yet</h2><p>Open <b>Add songs</b>, paste a Spotify or YouTube playlist link, then press <b>Sync now</b>.</p>
         <button class="primary" data-tab="add">Add songs</button></div>`;
    return;
  }
  view.innerHTML = `<div class="list-head"><div><h2>${title}</h2><small>${ids.length} songs</small></div>
    <button class="pill" data-action="shuffle"><svg><use href="#i-shuffle"/></svg>Shuffle</button></div>
    <ul class="list">${songRows(ids)}</ul>`;
}

function renderPlaylists() {
  if (!state.playlists.length) {
    view.innerHTML = `<div class="empty"><h2>No playlists yet</h2><p>Each playlist link you save in <b>Add songs</b> shows up here after a sync.</p></div>`;
    return;
  }
  view.innerHTML = `<div class="list-head"><div><h2>Playlists</h2><small>${state.playlists.length} playlists</small></div></div>
    <ul class="list">${state.playlists.map((p) => `<li><button class="row" data-open="${esc(p.id)}">
      <img loading="lazy" src="${esc(state.byId.get(p.tracks[0])?.cover ?? 'icon-192.png')}" alt="">
      <span class="meta"><b>${esc(p.name)}</b><small>${p.tracks.length} songs</small></span></button></li>`).join('')}</ul>`;
}

function renderPlaylist() {
  const p = state.playlists.find((x) => x.id === state.playlistId);
  if (!p) { state.playlistId = null; return renderPlaylists(); }
  view.innerHTML = `<button class="back" data-action="back"><svg><use href="#i-back"/></svg>Playlists</button>
    <div class="list-head"><div><h2>${esc(p.name)}</h2><small>${p.tracks.length} songs</small></div>
      <div class="head-actions"><button class="pill" data-action="shuffle"><svg><use href="#i-shuffle"/></svg>Shuffle</button>
      <button class="pill solid" data-action="play-all"><svg><use href="#i-play"/></svg>Play</button></div></div>
    <ul class="list">${songRows(p.tracks)}</ul>`;
}

function renderAdd() {
  view.innerHTML = `<section class="card">
      <h2>Add songs</h2>
      <p>Paste Spotify, YouTube or YouTube Music links, one per line. Playlists, albums and single songs all work.
      To group single songs, put a line like <b># Focus</b> above them.
      A saved playlist stays linked: songs you add to it later download on the next sync.</p>
      <textarea id="links-input" rows="4" placeholder="https://open.spotify.com/playlist/…" aria-label="Links to add"></textarea>
      <button class="primary" data-action="add-links">Save links</button>
    </section>
    <section class="card" id="sync-card"></section>
    <section><h2 class="section-title">Saved links</h2><ul class="links" id="links-list"></ul></section>
    <p class="foot">Songs download on your PC and appear here as they finish. <button class="link" data-action="signout">Sign out</button></p>`;
  renderSync();
}

function renderSync() {
  const card = $('sync-card');
  if (!card) return;
  const s = state.status;
  let text;
  if (syncRunning()) text = `Downloading ${s.done} of ${s.total}${s.current ? ` · ${esc(s.current)}` : ''}`;
  else if (syncPending()) {
    text = pcOnline() ? 'Sync asked. Your PC starts within a minute.'
      : `Sync asked. It starts when your PC is on${s.pcSeenAt ? ` (PC last seen ${ago(s.pcSeenAt)})` : ''}.`;
  } else if (s.state === 'running') text = `Your PC stopped while syncing (last seen ${ago(s.pcSeenAt)}). It continues when the PC is back on.`;
  else if (s.state === 'failed') text = `Last sync failed ${ago(s.finishedAt)}: ${esc(s.message)}`;
  else if (s.finishedAt) text = `Last sync ${ago(s.finishedAt)}: ${s.added} new song${s.added === 1 ? '' : 's'}${s.errors?.length ? `, ${s.errors.length} failed` : ''}.`;
  else text = 'Not synced yet. Save your links, then press Sync now.';
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  const busy = syncRunning() || syncPending();
  card.innerHTML = `<div class="sync-row"><div><h2>Sync</h2><p>${text}</p></div>
      <button class="primary" data-action="sync" ${busy ? 'disabled' : ''}><svg class="${busy ? 'spin' : ''}"><use href="#i-sync"/></svg>${busy ? 'Syncing' : 'Sync now'}</button></div>
    ${syncRunning() ? `<div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>` : ''}
    ${s.errors?.length && !busy ? `<details><summary>${s.errors.length} could not download</summary><ul class="errors">${s.errors.map((e) =>
      `<li><b>${esc(e.song || e.link)}</b><small>${esc(e.error)}</small></li>`).join('')}</ul></details>` : ''}`;

  $('links-list').innerHTML = state.links.length ? state.links.map((l) => {
    const info = state.linkInfo.get(l.id);
    const label = info ? (info.single ? `Song · ${esc(info.name)}` : `${esc(info.name)} · ${info.tracks.length} songs`) : 'Waiting for sync';
    return `<li><div><b>${label}</b><small>${esc(l.url)}</small></div>
      <button class="icon" data-remove="${esc(l.id)}" aria-label="Remove link"><svg><use href="#i-x"/></svg></button></li>`;
  }).join('') : '<li class="none">No links saved yet.</li>';
}

// ---------- actions ----------

const LINK = /^https?:\/\/([a-z0-9-]+\.)*(spotify\.com|youtube\.com|youtu\.be)\//i;

async function addLinks() {
  const input = $('links-input');
  // A line like "# Focus" puts the single-song links below it into a playlist called Focus.
  const entries = [];
  let group = null;
  for (const line of input.value.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (line.startsWith('#')) group = line.replace(/^#+/, '').trim() || null;
    else for (const url of line.split(/\s+/)) entries.push({ url, group });
  }
  const bad = entries.filter((e) => !LINK.test(e.url));
  if (!entries.length) return toast('Paste at least one link first.');
  if (bad.length) return toast(`Not a Spotify or YouTube link: ${bad[0].url}`);
  const links = await readJson('sources.json', []); // newest copy, in case another device changed it
  const have = new Set(links.map((l) => l.url));
  const fresh = [];
  for (const { url, group: g } of entries) {
    if (have.has(url)) continue;
    have.add(url);
    fresh.push({ id: crypto.randomUUID(), url, ...(g && { group: g }), addedAt: new Date().toISOString() });
  }
  await writeJson('sources.json', [...links, ...fresh]);
  state.links = [...links, ...fresh];
  input.value = '';
  toast(fresh.length ? `Saved ${fresh.length} link${fresh.length === 1 ? '' : 's'}. Press Sync now to download.` : 'Those links are already saved.');
  renderSync();
}

async function removeLink(id) {
  const links = (await readJson('sources.json', [])).filter((l) => l.id !== id);
  await writeJson('sources.json', links);
  state.links = links;
  toast('Link removed. Songs already downloaded stay in your library.');
  renderSync();
}

async function requestSync() {
  state.request = new Date().toISOString();
  renderSync();
  await writeJson('sync-request.json', { requestedAt: state.request });
  schedulePoll();
}

async function run(action) {
  try {
    await action();
  } catch (err) {
    if (err instanceof SignedOut) return showSignin(err.message);
    console.error(err);
    toast(err.message);
  }
}

view.addEventListener('click', (e) => {
  const el = e.target.closest('button');
  if (!el) return;
  if (el.dataset.play) return playList(visibleIds(), Number(el.dataset.play));
  if (el.dataset.open) { state.playlistId = el.dataset.open; history.pushState({ screen: 'playlist' }, ''); render(); scrollTo(0, 0); return; }
  if (el.dataset.remove) return run(() => removeLink(el.dataset.remove));
  if (el.dataset.tab) return switchTab(el.dataset.tab);
  switch (el.dataset.action) {
    case 'shuffle': return playList(visibleIds(), null, true);
    case 'play-all': return playList(visibleIds(), 0, false);
    case 'back': return history.back();
    case 'add-links': return run(addLinks);
    case 'sync': return run(requestSync);
    case 'signout': return run(async () => { audio.pause(); await signOut(); showSignin(); });
  }
});

function switchTab(tab) {
  state.tab = tab;
  state.playlistId = null;
  state.query = '';
  $('search').value = '';
  render();
  scrollTo(0, 0);
}

document.querySelector('.tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('button')?.dataset.tab;
  if (tab) switchTab(tab);
});

$('search').addEventListener('input', (e) => { state.query = e.target.value; render(); });

// ---------- player ----------

const currentTrack = () => state.byId.get(queue.ids[queue.order[queue.pos]]);

function playList(ids, start, shuffle = queue.shuffle) {
  if (!ids.length) return;
  queue.ids = [...ids];
  queue.shuffle = shuffle;
  const all = ids.map((_, i) => i);
  if (shuffle) queue.order = start == null ? shuffled(all) : [start, ...shuffled(all.filter((i) => i !== start))];
  else queue.order = all;
  queue.pos = shuffle ? 0 : (start ?? 0);
  startCurrent();
}

async function waitForServiceWorker() {
  if (navigator.serviceWorker.controller) return;
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  }
}

async function startCurrent() {
  const t = currentTrack();
  if (!t) return;
  await waitForServiceWorker();
  audio.src = `stream/${t.fileId}`;
  audio.play().catch(() => {}); // a real failure arrives as the audio "error" event
  showTrack(t);
}

function next(auto = false) {
  if (!queue.ids.length) return;
  if (auto && queue.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  if (queue.pos + 1 < queue.order.length) queue.pos++;
  else if (queue.repeat === 'all' || !auto) {
    if (queue.shuffle) queue.order = shuffled(queue.order);
    queue.pos = 0;
  } else return; // end of the list
  startCurrent();
}

function prev() {
  if (audio.currentTime > 3 || queue.pos === 0) { audio.currentTime = 0; return; }
  queue.pos--;
  startCurrent();
}

function togglePlay() {
  if (!currentTrack()) return playList(visibleIds().length ? visibleIds() : state.tracks.map((t) => t.id), 0);
  audio.paused ? audio.play() : audio.pause();
}

function setShuffle(on) {
  const at = queue.order[queue.pos];
  queue.shuffle = on;
  const all = queue.ids.map((_, i) => i);
  queue.order = on && at != null ? [at, ...shuffled(all.filter((i) => i !== at))] : all;
  queue.pos = on ? 0 : (at ?? 0);
  showModes();
}

function cycleRepeat() {
  queue.repeat = { off: 'all', all: 'one', one: 'off' }[queue.repeat];
  showModes();
}

function showModes() {
  $('btn-shuffle').setAttribute('aria-pressed', queue.shuffle);
  $('btn-repeat').setAttribute('aria-pressed', queue.repeat !== 'off');
  $('btn-repeat').setAttribute('aria-label', `Repeat: ${{ off: 'off', all: 'all songs', one: 'this song' }[queue.repeat]}`);
  $('repeat-one').hidden = queue.repeat !== 'one';
}

function showTrack(t) {
  $('mini').hidden = false;
  document.body.classList.add('has-mini');
  $('mini-cover').src = $('now-cover').src = t.cover;
  $('mini-title').textContent = $('now-title').textContent = t.title;
  $('mini-artist').textContent = $('now-artist').textContent = t.artist;
  $('t-total').textContent = fmt(t.duration);
  document.title = `${t.title} · ${t.artist}`;
  document.querySelectorAll('.row.playing').forEach((r) => r.classList.remove('playing'));
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album || '',
      artwork: [{ src: t.cover, sizes: '512x512', type: 'image/jpeg' }],
    });
  }
  if (state.tab !== 'add') render();
}

function showPlaying() {
  const icon = audio.paused ? '#i-play' : '#i-pause';
  for (const id of ['mini-play', 'btn-play']) {
    $(id).querySelector('use').setAttribute('href', icon);
    $(id).setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
  }
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
}

let seeking = false;
audio.addEventListener('timeupdate', () => {
  const d = audio.duration;
  if (!Number.isFinite(d) || !d) return;
  $('mini-bar').style.width = `${(audio.currentTime / d) * 100}%`;
  if (!seeking) $('seek').value = (audio.currentTime / d) * 100;
  $('t-now').textContent = fmt(audio.currentTime);
  $('t-total').textContent = fmt(d);
  if ('mediaSession' in navigator && navigator.mediaSession.setPositionState) {
    navigator.mediaSession.setPositionState({ duration: d, position: Math.min(audio.currentTime, d), playbackRate: 1 });
  }
});
audio.addEventListener('play', showPlaying);
audio.addEventListener('pause', showPlaying);
audio.addEventListener('playing', () => { queue.failures = 0; });
audio.addEventListener('ended', () => next(true));
audio.addEventListener('error', async () => {
  if (!audio.src) return;
  if (!(await isSignedIn())) return showSignin('Your Google sign-in has ended. Please sign in again.');
  queue.failures++;
  const t = currentTrack();
  if (queue.failures >= 3) { toast('Songs are not loading. Check your internet connection.'); return; }
  toast(`Could not play “${t?.title}”. Skipping to the next song.`);
  setTimeout(() => next(true), 1500);
});

$('seek').addEventListener('input', () => { seeking = true; $('t-now').textContent = fmt((audio.duration * $('seek').value) / 100); });
$('seek').addEventListener('change', () => { seeking = false; if (audio.duration) audio.currentTime = (audio.duration * $('seek').value) / 100; });
$('mini-play').addEventListener('click', togglePlay);
$('btn-play').addEventListener('click', togglePlay);
$('mini-next').addEventListener('click', () => next());
$('btn-next').addEventListener('click', () => next());
$('btn-prev').addEventListener('click', prev);
$('btn-shuffle').addEventListener('click', () => setShuffle(!queue.shuffle));
$('btn-repeat').addEventListener('click', cycleRepeat);
$('mini-open').addEventListener('click', () => { $('now').hidden = false; history.pushState({ screen: 'now' }, ''); });
$('now-close').addEventListener('click', () => history.back());

// Android's back button: close the full player or the open playlist instead of leaving the app.
addEventListener('popstate', () => {
  if (!$('now').hidden) { $('now').hidden = true; return; }
  if (state.playlistId) { state.playlistId = null; render(); }
});

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => audio.play());
  ms.setActionHandler('pause', () => audio.pause());
  ms.setActionHandler('nexttrack', () => next());
  ms.setActionHandler('previoustrack', prev);
  ms.setActionHandler('seekto', (d) => { audio.currentTime = d.seekTime; });
}

addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.target.closest('input, textarea, button')) return;
  e.preventDefault();
  togglePlay();
});

// ---------- start ----------

function showSignin(message = '') {
  $('app').hidden = true;
  $('now').hidden = true;
  $('signin').hidden = false;
  $('signin-msg').textContent = message;
}

$('signin-btn').addEventListener('click', () => signIn());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); });

async function boot() {
  if (!CLIENT_ID) {
    showSignin('Setup needed: add your Google client ID to config.js (see SETUP.md, step 3).');
    $('signin-btn').disabled = true;
    return;
  }
  navigator.serviceWorker.register('sw.js', { type: 'module' });
  try {
    await finishSignIn();
  } catch (err) {
    return showSignin(err.message);
  }
  if (!(await isSignedIn())) return showSignin();
  $('signin').hidden = true;
  $('app').hidden = false;
  view.innerHTML = '<p class="empty">Loading your songs…</p>';
  try {
    await Promise.all([loadLibrary(), loadSync()]);
    render();
    schedulePoll();
  } catch (err) {
    if (err instanceof SignedOut) return showSignin(err.message);
    view.innerHTML = `<div class="empty"><h2>Could not load your songs</h2><p>${esc(err.message)}</p>
      <button class="primary" onclick="location.reload()">Try again</button></div>`;
  }
}

boot();
