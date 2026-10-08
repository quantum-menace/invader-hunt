'use strict';

const STORE_KEY = 'invader-hunt.found.v1';
const LOC_KEY = 'invader-hunt.location';   // 'real', 'any', or a city name
const OLD_TEST_KEY = 'invader-hunt.testmode';
const PLAYER_KEY = 'invader-hunt.player';  // { id, display_name } when logged in
const $ = (id) => document.getElementById(id);

let data = null;          // contents of data.json
let matcher = null;       // see match.js
const refs = {};          // invader id -> array of reference fingerprints
let found = loadFound();  // invader id -> { at, score, thumb }
let lastFix = null;       // most recent real GeolocationPosition
let watchId = null;       // id of the running watchPosition
let gpsState = { kind: '', text: 'Location is off', button: true }; // real GPS status

// ---------- storage ----------
function loadFound() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function saveFound() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(found)); } catch (e) { console.warn(e); }
}
function loadPlayer() {
  try { return JSON.parse(localStorage.getItem(PLAYER_KEY)); } catch { return null; }
}
function savePlayer(p) {
  try { p ? localStorage.setItem(PLAYER_KEY, JSON.stringify(p)) : localStorage.removeItem(PLAYER_KEY); } catch {}
}
let player = loadPlayer();

// ---------- accounts & sync ----------
// Finds are kept on the phone first and copied to Supabase when a player is
// logged in, so a flash is never lost to a bad connection.
async function syncFinds() {
  if (!Cloud.enabled || !player) return;
  for (const [id, f] of Object.entries(found)) {
    if (f.synced || !data.invaders.some((i) => i.id === id)) continue;
    try { await Cloud.saveFind(player.id, id, f); f.synced = true; } catch (e) { console.warn('[ih] sync failed', e); }
  }
  saveFound();
}

const ADMIN_ID = 'admin';
const isAdminName = (name) => name.trim().toLowerCase() === ADMIN_ID;

async function login(name, password) {
  // "admin" signs in to a Supabase user behind the scenes; the database
  // checks that user before allowing edits to invaders and photos.
  if (isAdminName(name)) await Cloud.adminSignIn((window.INVADER_CONFIG || {}).adminEmail, password);
  const p = await Cloud.join(name);
  const remote = await Cloud.loadFinds(p.id);
  // Keep finds made on this phone before logging in, then upload them.
  for (const [id, f] of Object.entries(found)) if (!remote[id]) remote[id] = { ...f, synced: false };
  found = remote;
  player = p;
  savePlayer(p);
  saveFound();
  await syncFinds();
  render();
  renderPlayer();
  renderBoard();
  showAdminPanel();
}

async function logout() {
  if (player && player.id === ADMIN_ID) await Cloud.adminSignOut().catch(() => {});
  player = null;
  savePlayer(null);
  found = {};
  saveFound();
  render();
  renderPlayer();
  showAdminPanel();
}

function renderPlayer() {
  if (!Cloud.enabled) return;
  $('player-btn').hidden = !player;
  if (player) $('player-btn').textContent = player.display_name + ' ✕';
  $('login').hidden = !!player;
}

async function renderBoard() {
  if (!Cloud.enabled) return;
  try {
    const rows = await Cloud.leaderboard();
    const ol = $('board');
    ol.innerHTML = '';
    for (const r of rows.filter((x) => x.id !== ADMIN_ID)) {
      const li = el('li', player && r.id === player.id ? 'me' : '');
      li.append(el('span', 'who', r.display_name), el('span', 'what', `${r.found} · ${r.points} pts`));
      ol.append(li);
    }
    if (!ol.children.length) ol.append(el('li', 'empty', 'No players yet'));
    $('board-wrap').hidden = false;
  } catch (e) {
    console.warn('[ih] leaderboard failed', e);
  }
}

function setupAccounts() {
  if (!Cloud.enabled) return;
  renderPlayer();
  $('player-btn').addEventListener('click', () => {
    if (!$('player-btn').dataset.confirm) {
      $('player-btn').dataset.confirm = '1';
      $('player-btn').textContent = 'Log out?';
      setTimeout(() => { delete $('player-btn').dataset.confirm; renderPlayer(); }, 3000);
      return;
    }
    delete $('player-btn').dataset.confirm;
    logout();
  });
  // The password field only appears for the name "admin".
  $('login-name').addEventListener('input', () => {
    if (!isAdminName($('login-name').value)) $('login-pass').hidden = true;
  });
  $('login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = $('login-msg');
    const name = $('login-name').value;
    msg.hidden = false;
    if (isAdminName(name) && $('login-pass').hidden) {
      $('login-pass').hidden = false;
      $('login-pass').focus();
      msg.textContent = 'Enter the admin password.';
      return;
    }
    msg.textContent = 'Logging in…';
    try {
      await login(name, $('login-pass').value);
      $('login-pass').value = '';
      $('login-pass').hidden = true;
      msg.hidden = true;
    } catch (e) {
      msg.textContent = 'Could not log in: ' + e.message;
    }
  });
}

// Where the app thinks you are: real GPS, a pretend city, or anywhere.
function locMode() {
  try {
    const v = localStorage.getItem(LOC_KEY);
    if (v) return v;
    if (localStorage.getItem(OLD_TEST_KEY) === '1') return 'any';
  } catch {}
  return 'real';
}
function setLocMode(v) {
  try { localStorage.setItem(LOC_KEY, v); localStorage.removeItem(OLD_TEST_KEY); } catch {}
  paintGps();
}

// Pretend position: the middle of a city's invaders.
function fakePosition(city) {
  const invs = data.invaders.filter((i) => i.city === city);
  if (!invs.length) return null;
  const lat = invs.reduce((s, i) => s + i.lat, 0) / invs.length;
  const lng = invs.reduce((s, i) => s + i.lng, 0) / invs.length;
  return { coords: { latitude: lat, longitude: lng, accuracy: 5 }, timestamp: Date.now() };
}

// ---------- geo ----------
function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Geolocation not supported'));
    navigator.geolocation.getCurrentPosition(resolve, reject,
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 15000 });
  });
}
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function setGps(kind, text, button) {
  gpsState = { kind, text, button };
  paintGps();
}

// The status bar shows the pretend location when one is set, otherwise real GPS.
function paintGps() {
  const mode = locMode();
  const bar = $('gps');
  if (mode !== 'real') {
    bar.className = 'gps sim';
    $('gps-text').textContent = mode === 'any' ? 'Test: location ignored' : `Test: pretending to be in ${mode}`;
    $('gps-btn').hidden = true;
    $('gps-help').hidden = true;
    return;
  }
  const { kind, text, button } = gpsState;
  bar.className = 'gps ' + kind;
  $('gps-text').textContent = text;
  $('gps-btn').hidden = !button;
  $('gps-btn').textContent = kind === 'bad' ? 'Try again' : 'Enable location';
  $('gps-help').hidden = kind !== 'bad';
}

function gpsFailed(e) {
  if (e && e.code === 1) setGps('bad', 'Location is off for this app', true);
  else if (lastFix) return; // keep the last good fix on a transient error
  else if (e && e.code === 3) setGps('warn', 'No GPS fix yet', true);
  // Code 2 usually means location is switched off for the whole device
  // (Firefox reports it this way instead of as a permission error).
  else setGps('bad', 'Location is off on this device', true);
}

function onFix(p) {
  lastFix = p;
  setGps('ok', `Location on · ±${Math.round(p.coords.accuracy)} m`, false);
}

function startWatch() {
  if (watchId != null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(onFix, gpsFailed,
    { enableHighAccuracy: true, timeout: 30000, maximumAge: 10000 });
}

// Must be called from a tap so iOS shows the permission prompt.
function requestLocation() {
  setGps('busy', 'Getting location…', false);
  return getPosition().then((p) => { onFix(p); startWatch(); return p; },
    (e) => { gpsFailed(e); throw e; });
}

// Short "where to turn location on" steps for this device and browser.
function locationHelp() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document);
  const firefox = /Firefox|FxiOS/.test(ua);
  const browser = firefox ? 'Firefox' : /CriOS|Chrome/.test(ua) && !/Edg/.test(ua) ? 'Chrome' : /Edg/.test(ua) ? 'Edge' : 'Safari';
  if (ios) {
    const app = browser === 'Safari' ? 'Safari Websites' : browser;
    return ['iPhone', `Settings › Privacy & Security › Location Services › ${app} › <i>While Using the App</i>`];
  }
  if (/Android/.test(ua)) {
    return firefox
      ? ['Android', 'Settings › Location › on. Then Settings › Apps › Firefox › Permissions › Location › <i>Allow</i>. In Firefox tap the lock next to the address › Location › <i>Allow</i>']
      : ['Android', 'Settings › Location › on. Then in Chrome tap ⓘ next to the address › Permissions › Location › <i>Allow</i>'];
  }
  return ['Computer', `Turn on location in your system settings (Windows: Settings › Privacy & security › Location). Then click the icon left of the address in ${browser} and <i>allow</i> location. For testing you can also pretend a location under Tools.`];
}

// Check location as soon as the page opens. If it is switched off on the
// device, iOS fails instantly without a prompt, and we show how to fix it.
function setupLocation() {
  const [label, steps] = locationHelp();
  $('help-steps').innerHTML = `<b>${label}</b> ${steps}`;
  $('gps-btn').addEventListener('click', () => requestLocation().catch(() => {}));
  paintGps();
  if (!navigator.geolocation) return setGps('bad', 'No location support in this browser', false);

  const check = () => requestLocation().catch(() => {});
  if (!(navigator.permissions && navigator.permissions.query)) return check();
  navigator.permissions.query({ name: 'geolocation' })
    .then((s) => {
      if (s.state === 'denied') setGps('bad', 'Location is off for this app', true);
      else check();
      s.onchange = () => { if (s.state !== 'denied') check(); };
    })
    .catch(check);
}

function fmtDist(m) { return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`; }

function thumbnail(img) {
  return Matcher.cropToCanvas(img, 1, 240).toDataURL('image/jpeg', 0.7);
}

// ---------- UI ----------
function esc(s) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s).replace(/[&<>"']/g, (c) => map[c]);
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

// Cities that have invaders: the order from data.json first, then any others.
function cityList() {
  const cities = [...(data.cities || [])];
  for (const inv of data.invaders) if (!cities.includes(inv.city)) cities.push(inv.city);
  return cities.filter((c) => data.invaders.some((i) => i.city === c));
}

// Collection grouped by city, in the order given by data.cities.
function render() {
  const root = $('collection');
  root.innerHTML = '';
  let pts = 0, n = 0;
  for (const city of cityList()) {
    const invs = data.invaders.filter((i) => i.city === city);
    if (!invs.length) continue;
    const got = invs.filter((i) => found[i.id]).length;
    const section = el('section', 'city' + (got === invs.length ? ' complete' : ''));
    const head = el('div', 'city-head');
    head.append(el('h3', null, city), el('span', 'count', `${got}/${invs.length}`));
    const grid = el('div', 'grid');
    section.append(head, grid);
    root.append(section);

    for (const inv of invs) {
      const f = found[inv.id];
      if (f) { pts += inv.points || 0; n++; }
      grid.append(card(inv, f));
    }
  }
  $('score').textContent = `${pts} pts · ${n}/${data.invaders.length}`;
}

function card(inv, f) {
  const c = el('div', 'card' + (f ? '' : ' locked'));
  const img = el('img');
  const src = f && f.thumb ? f.thumb : inv.refs[0];
  if (src) {
    if (!/^(data|blob):/.test(src)) img.crossOrigin = 'anonymous';
    img.src = src;
  }
  img.alt = inv.name;
  const meta = el('div', 'meta');
  meta.append(
    el('div', 'name', inv.name),
    el('div', 'sub', f ? `${new Date(f.at).toLocaleDateString()} · ${inv.points || 0} pts` : `${inv.points || 0} pts`),
  );
  c.append(img, meta);
  return c;
}

function showResult(previewUrl, html) {
  $('result').hidden = false;
  if (previewUrl) $('preview').src = previewUrl;
  $('result-text').innerHTML = html;
}

// ---------- the flash ----------
async function handlePhoto(file) {
  const url = URL.createObjectURL(file);
  showResult(url, '<strong>Analyzing…</strong><span class="small">Checking location and image</span>');
  try {
    const img = await Matcher.loadImage(url);
    const mode = locMode();
    const threshold = data.similarityThreshold;
    const colorWeight = data.colorWeight ?? 0.4;
    const minMargin = data.minMargin ?? 0.05;

    // 1. Where are we?
    let pos = null, gpsError = null;
    if (mode === 'real') {
      // Use the watched fix if it is recent, otherwise ask once more.
      if (lastFix && Date.now() - lastFix.timestamp < 60000) pos = lastFix;
      else {
        try { pos = await getPosition(); onFix(pos); } catch (e) { gpsError = e; pos = lastFix; }
      }
    } else if (mode !== 'any') {
      pos = fakePosition(mode);
    }
    const modeTxt = mode === 'any' ? ' · location ignored' : mode !== 'real' ? ` · pretending ${esc(mode)}` : '';

    // 2. Keep only invaders near that position
    let candidates = data.invaders.map((inv) => ({
      inv,
      dist: pos ? distanceMeters(pos.coords.latitude, pos.coords.longitude, inv.lat, inv.lng) : null,
    }));
    if (mode !== 'any') {
      if (!pos) {
        return showResult(null, `<strong class="bad">Location needed</strong>
          <span class="small">Allow location access for this site and try again. (${esc(gpsError ? gpsError.message : 'unknown error')})</span>`);
      }
      const slack = Math.min(pos.coords.accuracy || 0, 150);
      const near = candidates.filter((c) => c.dist <= data.radiusMeters + slack);
      if (!near.length) {
        const nearest = candidates.sort((a, b) => a.dist - b.dist)[0];
        return showResult(null, `<strong class="warn">No invader here</strong>
          <span class="small">Nearest is ${esc(nearest.inv.name)}, about ${fmtDist(nearest.dist)} away${modeTxt}.</span>`);
      }
      candidates = near;
    }

    // 3. Compare the photo with the remaining candidates
    const shots = await matcher.fingerprintPhoto(img);
    for (const c of candidates) {
      c.m = matcher.score(shots, refs[c.inv.id], colorWeight);
      c.score = c.m.score;
    }
    candidates.sort((a, b) => b.score - a.score);
    const [best, second] = candidates;
    const scoreTxt = `score ${best.score.toFixed(2)} of ${threshold} needed; shape ${best.m.emb.toFixed(2)}, colour ${best.m.color.toFixed(2)}`;
    const distTxt = best.dist != null ? ` · ${fmtDist(best.dist)} away` : '';

    if (best.score < threshold) {
      return showResult(null, `<strong class="bad">No match</strong>
        <span class="small">Closest was ${esc(best.inv.name)} (${scoreTxt}${distTxt}${modeTxt}). Try a straight-on shot that fills the frame.</span>`);
    }
    // Two candidates nearly tied: better to ask again than to credit the wrong one.
    if (second && best.score - second.score < minMargin) {
      return showResult(null, `<strong class="warn">Not sure which one</strong>
        <span class="small">Could be ${esc(best.inv.name)} (${best.score.toFixed(2)}) or ${esc(second.inv.name)} (${second.score.toFixed(2)})${modeTxt}. Get closer and shoot straight on so the invader fills the frame.</span>`);
    }
    if (found[best.inv.id]) {
      return showResult(null, `<strong class="warn">Already flashed</strong>
        <span class="small">${esc(best.inv.name)} is already in your collection (${scoreTxt}).</span>`);
    }
    found[best.inv.id] = {
      at: Date.now(),
      score: +best.score.toFixed(3),
      thumb: thumbnail(img),
      lat: pos ? pos.coords.latitude : null,
      lng: pos ? pos.coords.longitude : null,
      simulated: mode !== 'real',
      synced: false,
    };
    saveFound();
    render();
    syncFinds().then(renderBoard);
    showResult(null, `<strong class="ok">Flashed! +${best.inv.points || 0} pts</strong>
      <span class="small">${esc(best.inv.name)} (${scoreTxt}${distTxt}${modeTxt})</span>`);
  } catch (e) {
    console.error(e);
    showResult(null, `<strong class="bad">Something went wrong</strong><span class="small">${esc(e.message)}</span>`);
  }
}

// ---------- tools ----------
function setupTools() {
  let lastPos = '';
  $('getpos').addEventListener('click', async () => {
    const out = $('posout');
    out.hidden = false;
    out.textContent = 'Getting location…';
    try {
      const p = await getPosition();
      const { latitude, longitude, accuracy } = p.coords;
      lastPos = `"lat": ${latitude.toFixed(6)}, "lng": ${longitude.toFixed(6)}`;
      out.textContent = `${lastPos}\naccuracy: ±${Math.round(accuracy)} m`;
      $('copypos').hidden = false;
    } catch (e) {
      out.textContent = 'Error: ' + e.message;
    }
  });
  $('copypos').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(lastPos); $('copypos').textContent = 'Copied'; } catch {}
  });

  $('reset').addEventListener('click', () => { $('reset-confirm').hidden = false; });
  $('reset-yes').addEventListener('click', async () => {
    $('reset-confirm').hidden = true;
    if (Cloud.enabled && player) {
      try { await Cloud.deleteFinds(player.id); } catch (e) { return showFatal('Reset failed: ' + e.message); }
    }
    found = {};
    saveFound();
    render();
    renderBoard();
  });
}

// Fill the location picker once the city list is known.
function setupLocationPicker() {
  const sel = $('locmode');
  sel.innerHTML = '';
  sel.append(new Option('Real GPS', 'real'));
  for (const city of cityList()) sel.append(new Option(`Pretend: ${city}`, city));
  sel.append(new Option('Ignore location (all invaders)', 'any'));
  const mode = locMode();
  sel.value = [...sel.options].some((o) => o.value === mode) ? mode : 'real';
  if (sel.value !== mode) setLocMode(sel.value);
  sel.onchange = () => setLocMode(sel.value); // property, so rebuilding does not stack listeners
  paintGps();
}

// ---------- admin: invaders and reference photos ----------
const NEW_INVADER = '__new__';

// Shrink a camera photo to at most 1024 px for upload.
async function shrinkPhoto(file) {
  const img = await Matcher.loadImage(URL.createObjectURL(file));
  const w = img.naturalWidth, h = img.naturalHeight, s = Math.min(1, 1024 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * s);
  c.height = Math.round(h * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.85));
}

// Admin actions always use the real GPS, never a pretend location.
async function realPosition() {
  if (lastFix && Date.now() - lastFix.timestamp < 30000) return lastFix;
  return requestLocation();
}

function adminMsg(text) { $('admin-msg').textContent = text; }

// Reads "48.1374, 11.5755", "48.1374 11.5755", or a Google Maps link
// (…/@48.1374,11.5755,17z or …?q=48.1374,11.5755). Returns null if invalid.
function parseCoords(text) {
  const s = (text || '').trim();
  const m = s.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/)
    || s.match(/[?&](?:q|query|ll)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/)
    || s.match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) return null;
  return { lat, lng };
}

const fmtCoords = (lat, lng) => `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

function showCoords(inv) {
  $('inv-coords').value = fmtCoords(inv.lat, inv.lng);
  $('coords-map').href = `https://www.google.com/maps/search/?api=1&query=${inv.lat},${inv.lng}`;
}

async function setInvaderLocation(inv, lat, lng, how) {
  await Cloud.moveInvader(inv.id, lat, lng);
  inv.lat = lat;
  inv.lng = lng;
  showCoords(inv);
  adminMsg(`${inv.name} now sits at ${fmtCoords(lat, lng)}${how}.`);
}

function fillAdminInvaders(selectId) {
  const sel = $('admin-inv');
  sel.innerHTML = '';
  for (const city of cityList()) {
    const group = document.createElement('optgroup');
    group.label = city;
    for (const inv of data.invaders.filter((i) => i.city === city)) {
      group.append(new Option(`${inv.name} (${inv.refs.length} photo${inv.refs.length === 1 ? '' : 's'})`, inv.id));
    }
    sel.append(group);
  }
  sel.append(new Option('+ New invader…', NEW_INVADER));
  if (selectId) sel.value = selectId;
  $('city-list').innerHTML = '';
  for (const city of cityList()) $('city-list').append(new Option(city));
  showAdminInvader();
}

function showAdminInvader() {
  const id = $('admin-inv').value;
  const isNew = id === NEW_INVADER;
  $('admin-new').hidden = !isNew;
  $('admin-existing').hidden = isNew;
  const strip = $('admin-refs');
  strip.innerHTML = '';
  const inv = data.invaders.find((i) => i.id === id);
  if (!inv) return;
  showCoords(inv);
  $('inv-points').value = inv.points || 0;
  inv.refs.forEach((src, i) => {
    // A card with the photo on the front and a red cross on the back.
    const card = el('button', 'ref-card');
    card.type = 'button';
    card.setAttribute('aria-label', `Reference photo ${i + 1}: tap to delete`);
    const inner = el('span', 'ref-inner');
    const img = el('img', 'ref-front');
    if (!/^(data|blob):/.test(src)) img.crossOrigin = 'anonymous';
    img.src = src;
    img.alt = '';
    const back = el('span', 'ref-back');
    back.append(el('span', 'ref-x', '✕'), el('span', 'ref-label', 'Delete'));
    inner.append(img, back);
    card.append(inner);
    card.addEventListener('click', () => deleteRefPhoto(inv, i, card));
    strip.append(card);
  });
}

// First tap flips the photo to show a red cross; a second tap deletes it.
// It flips back by itself after 4 seconds or when another photo is tapped.
async function deleteRefPhoto(inv, i, card) {
  if (!card.classList.contains('flipped')) {
    for (const other of document.querySelectorAll('.ref-card.flipped')) other.classList.remove('flipped');
    card.classList.add('flipped');
    clearTimeout(card._unflip);
    card._unflip = setTimeout(() => card.classList.remove('flipped'), 4000);
    return;
  }
  clearTimeout(card._unflip);
  card.disabled = true;
  const row = inv.refRows && inv.refRows[i];
  const restore = () => { card.disabled = false; card.classList.remove('flipped'); };
  if (!row) { restore(); return adminMsg('This photo is built into the app and cannot be deleted here.'); }
  try {
    adminMsg('Deleting…');
    await Cloud.deleteRef(row);
    inv.refs.splice(i, 1);
    inv.refRows.splice(i, 1);
    if (refs[inv.id]) refs[inv.id].splice(i, 1);
    fillAdminInvaders(inv.id);
    render();
    adminMsg(`Deleted. ${inv.name} has ${inv.refs.length} reference photo${inv.refs.length === 1 ? '' : 's'} left.`);
  } catch (e) {
    restore();
    adminMsg('Could not delete: ' + e.message);
  }
}

let adminReady = false; // set once the recognizer is loaded and the buttons work

// The admin tools show only while logged in as "admin" with a valid Supabase sign-in.
async function showAdminPanel() {
  if (!Cloud.enabled || !adminReady) return;
  const ok = !!(player && player.id === ADMIN_ID && (await Cloud.adminSession())
    && (await Cloud.isAdmin().catch(() => false)));
  $('admin-tool').hidden = !ok;
  if (ok) {
    $('admin-who').textContent = 'Logged in as admin';
    fillAdminInvaders($('admin-inv').value);
  }
}

function setupAdmin() {
  if (!Cloud.enabled) return;
  $('admin-inv').addEventListener('change', showAdminInvader);

  $('new-create').addEventListener('click', async () => {
    const name = $('new-name').value.trim().toUpperCase().replace(/\s+/g, '_');
    const city = $('new-city').value.trim();
    const points = Math.max(0, parseInt($('new-points').value, 10) || 0);
    if (!/^[A-Z0-9_\-]{2,20}$/.test(name)) return adminMsg('Use 2 to 20 letters, digits or _ for the name.');
    if (!city) return adminMsg('Enter a city.');
    if (data.invaders.some((i) => i.id === name)) return adminMsg(name + ' already exists.');
    const typed = $('new-coords').value.trim();
    const coords = typed ? parseCoords(typed) : null;
    if (typed && !coords) return adminMsg('Could not read those coordinates. Use "48.13740, 11.57550".');
    try {
      let lat, lng, where;
      if (coords) {
        ({ lat, lng } = coords);
        where = fmtCoords(lat, lng);
      } else {
        adminMsg('Getting your position…');
        const p = await realPosition();
        lat = p.coords.latitude;
        lng = p.coords.longitude;
        where = `your position (±${Math.round(p.coords.accuracy)} m)`;
      }
      const inv = { id: name, name, city, lat, lng, points };
      await Cloud.createInvader(inv);
      data.invaders.push({ ...inv, refs: [], refRows: [] });
      refs[name] = [];
      $('new-coords').value = '';
      render();
      setupLocationPicker();
      fillAdminInvaders(name);
      adminMsg(`Created ${name} at ${where}. Now add reference photos.`);
    } catch (e) {
      adminMsg('Could not create it: ' + e.message);
    }
  });

  $('admin-move').addEventListener('click', async () => {
    const inv = data.invaders.find((i) => i.id === $('admin-inv').value);
    if (!inv) return;
    try {
      adminMsg('Getting your position…');
      const p = await realPosition();
      await setInvaderLocation(inv, p.coords.latitude, p.coords.longitude, ` (your GPS, ±${Math.round(p.coords.accuracy)} m)`);
    } catch (e) {
      adminMsg('Could not move it: ' + e.message);
    }
  });

  // Two taps: the first one says what will be lost, the second deletes.
  $('inv-delete').addEventListener('click', async () => {
    const btn = $('inv-delete');
    const inv = data.invaders.find((i) => i.id === $('admin-inv').value);
    if (!inv) return;
    if (btn.dataset.armed !== inv.id) {
      btn.dataset.armed = inv.id;
      btn.textContent = `Tap again to delete ${inv.name}`;
      const n = inv.refs.length;
      adminMsg(`This deletes ${inv.name}, its ${n} reference photo${n === 1 ? '' : 's'}, and every player's find of it. It cannot be undone.`);
      setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Delete this invader'; }, 4000);
      return;
    }
    delete btn.dataset.armed;
    btn.textContent = 'Delete this invader';
    try {
      adminMsg('Deleting…');
      await Cloud.deleteInvader(inv);
      data.invaders = data.invaders.filter((i) => i.id !== inv.id);
      delete refs[inv.id];
      if (found[inv.id]) { delete found[inv.id]; saveFound(); }
      render();
      setupLocationPicker();
      fillAdminInvaders();
      renderBoard();
      adminMsg(`Deleted ${inv.name}.`);
    } catch (e) {
      adminMsg('Could not delete: ' + e.message);
    }
  });

  $('points-save').addEventListener('click', async () => {
    const inv = data.invaders.find((i) => i.id === $('admin-inv').value);
    if (!inv) return;
    const points = parseInt($('inv-points').value, 10);
    if (!(points >= 0)) return adminMsg('Points must be 0 or more.');
    try {
      await Cloud.setPoints(inv.id, points);
      inv.points = points;
      render();
      renderBoard();
      adminMsg(`${inv.name} is now worth ${points} points. Leaderboard totals update for everyone.`);
    } catch (e) {
      adminMsg('Could not save points: ' + e.message);
    }
  });

  $('coords-save').addEventListener('click', async () => {
    const inv = data.invaders.find((i) => i.id === $('admin-inv').value);
    if (!inv) return;
    const c = parseCoords($('inv-coords').value);
    if (!c) return adminMsg('Could not read those coordinates. Use "48.13740, 11.57550".');
    try {
      await setInvaderLocation(inv, c.lat, c.lng, '');
    } catch (e) {
      adminMsg('Could not save: ' + e.message);
    }
  });

  $('ref-camera').addEventListener('change', async () => {
    const input = $('ref-camera');
    const file = input.files && input.files[0];
    input.value = '';
    const inv = data.invaders.find((i) => i.id === $('admin-inv').value);
    if (!file || !inv) return;
    try {
      adminMsg('Uploading…');
      const blob = await shrinkPhoto(file);
      const { row, url } = await Cloud.uploadRef(inv.id, blob);
      inv.refs.push(url);
      (inv.refRows = inv.refRows || []).push(row);
      // Use the new photo for matching right away on this phone.
      (refs[inv.id] = refs[inv.id] || []).push(await matcher.fingerprintRef(await Matcher.loadImage(URL.createObjectURL(blob))));
      fillAdminInvaders(inv.id);
      render();
      adminMsg(`Saved. ${inv.name} now has ${inv.refs.length} reference photo${inv.refs.length === 1 ? '' : 's'}.`);
    } catch (e) {
      adminMsg('Upload failed: ' + e.message);
    }
  });

  adminReady = true;
  showAdminPanel();
}

// Open with ?selftest to print how similar the reference images are to each other.
function selfTest() {
  const ids = data.invaders.filter((i) => refs[i.id] && refs[i.id].length).map((i) => i.id);
  const w = data.colorWeight ?? 0.4;
  const lines = ['        ' + ids.map((i) => i.padStart(7)).join('')];
  for (const a of ids) {
    const first = refs[a].find(Boolean);
    lines.push(a.padEnd(8) + ids.map((b) => (first ? matcher.score([first], refs[b], w).score : 0).toFixed(2).padStart(7)).join(''));
  }
  const out = $('selftest');
  out.hidden = false;
  out.textContent = 'SELFTEST OK\n' + lines.join('\n');
  console.info(out.textContent);
  $('tools').open = true;
}

// ---------- startup ----------
async function init() {
  setupTools();
  setupLocation();
  data = await (await fetch('data.json', { cache: 'no-cache' })).json();
  // With Supabase set up, the invader list lives there; data.json keeps the
  // settings and serves as a fallback when the database cannot be reached.
  if (Cloud.enabled) {
    try {
      data.invaders = await Cloud.loadInvaders();
    } catch (e) {
      console.warn('[ih] using built-in invader list', e);
    }
    if (player) {
      try {
        const remote = await Cloud.loadFinds(player.id);
        for (const [id, f] of Object.entries(found)) if (!f.synced) remote[id] = f;
        found = remote;
        saveFound();
      } catch (e) {
        console.warn('[ih] could not load finds', e);
      }
    }
  }
  console.info('[ih] data loaded');
  setupAccounts();
  render();
  setupLocationPicker();
  renderBoard();
  syncFinds();

  matcher = await Matcher.create('model/model.json');
  console.info('[ih] model loaded, backend', tf.getBackend());
  for (const inv of data.invaders) {
    refs[inv.id] = [];
    // Keep one entry per photo (null if it failed) so the list lines up with
    // inv.refs and a deleted photo can be removed by position.
    for (const src of inv.refs) {
      try {
        refs[inv.id].push(await matcher.fingerprintRef(await Matcher.loadImage(src)));
      } catch (e) {
        refs[inv.id].push(null);
        console.warn('[ih] skipped reference photo', src, e);
      }
    }
  }
  setupAdmin();

  console.info('[ih] references ready');
  const input = $('camera');
  const flash = $('flash');
  input.disabled = false;
  flash.classList.remove('disabled');
  $('flash-text').textContent = 'Flash an invader';
  // iOS often drops the location prompt if it fires while the camera opens,
  // so location must be granted first, in its own tap.
  flash.addEventListener('click', (ev) => {
    if (locMode() !== 'real' || lastFix) return;
    ev.preventDefault();
    requestLocation().catch(() => {});
  });
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (file) handlePhoto(file);
  });

  if (new URLSearchParams(location.search).has('selftest')) selfTest();
}

// Show unexpected errors on the page, since phones have no visible console.
function showFatal(msg) {
  console.error('[ih] error', msg);
  $('selftest').hidden = false;
  $('selftest').textContent = 'ERROR ' + msg;
  $('tools').open = true;
}
window.addEventListener('error', (e) => showFatal(e.message + ' @ ' + e.filename + ':' + e.lineno));
window.addEventListener('unhandledrejection', (e) => showFatal(String(e.reason && (e.reason.stack || e.reason.message) || e.reason)));

init().catch((e) => {
  console.error('[ih] init failed', e && (e.stack || e.message), e);
  $('flash-text').textContent = 'Failed to load: ' + e.message;
  $('selftest').hidden = false;
  $('selftest').textContent = 'SELFTEST FAIL ' + e.message;
});
