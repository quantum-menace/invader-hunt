'use strict';

const STORE_KEY = 'invader-hunt.found.v1';
const TEST_KEY = 'invader-hunt.testmode';
const $ = (id) => document.getElementById(id);

let data = null;          // contents of data.json
let model = null;         // MobileNet feature extractor
const refEmb = {};        // invader id -> array of reference embeddings
let found = loadFound();  // invader id -> { at, score, thumb }
let lastFix = null;       // most recent GeolocationPosition
let watchId = null;       // id of the running watchPosition

// ---------- storage ----------
function loadFound() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function saveFound() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(found)); } catch (e) { console.warn(e); }
}
function testMode() {
  try { return localStorage.getItem(TEST_KEY) === '1'; } catch { return false; }
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
function setGps(kind, text, showButton) {
  const el = $('gps');
  el.className = 'gps ' + kind;
  $('gps-text').textContent = text;
  $('gps-btn').hidden = !showButton;
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
  return ['Computer', `Turn on location in your system settings (Windows: Settings › Privacy & security › Location). Then click the icon left of the address in ${browser} and <i>allow</i> location. At home you can also use Test mode under Tools.`];
}

// Check location as soon as the page opens. If it is switched off on the
// device, iOS fails instantly without a prompt, and we show how to fix it.
function setupLocation() {
  const [label, steps] = locationHelp();
  $('help-steps').innerHTML = `<b>${label}</b> ${steps}`;
  $('gps-btn').addEventListener('click', () => requestLocation().catch(() => {}));
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

// ---------- images & embeddings ----------
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image ' + src));
    img.src = src;
  });
}

// Draw a centered square crop (zoom = fraction of the short side) to a 224x224 canvas.
function cropToCanvas(img, zoom = 1) {
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const side = Math.min(w, h) * zoom;
  const c = document.createElement('canvas');
  c.width = c.height = 224;
  c.getContext('2d').drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, 224, 224);
  return c;
}

function embed(canvas) {
  const t = tf.tidy(() => {
    const v = model.infer(canvas, true).flatten();
    return v.div(v.norm());
  });
  return t.data().finally(() => t.dispose()); // resolves to a unit-length Float32Array
}

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Several crops of the photo, so a small invader in a wide shot still matches.
async function embedPhoto(img) {
  const out = [];
  for (const z of [1, 0.7, 0.5]) out.push(await embed(cropToCanvas(img, z)));
  return out;
}

function thumbnail(img) {
  const c = cropToCanvas(img, 1);
  const t = document.createElement('canvas');
  t.width = t.height = 240;
  t.getContext('2d').drawImage(c, 0, 0, 240, 240);
  return t.toDataURL('image/jpeg', 0.7);
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

// Collection grouped by city, in the order given by data.cities.
function render() {
  const root = $('collection');
  root.innerHTML = '';
  const cities = [...(data.cities || [])];
  for (const inv of data.invaders) if (!cities.includes(inv.city)) cities.push(inv.city);

  let pts = 0, n = 0;
  for (const city of cities) {
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
  img.src = f ? f.thumb : inv.refs[0];
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
    const img = await loadImage(url);
    const test = testMode();

    // Use the watched fix if it is recent, otherwise ask once more.
    let pos = null, gpsError = null;
    if (lastFix && Date.now() - lastFix.timestamp < 60000) pos = lastFix;
    else {
      try { pos = await getPosition(); onFix(pos); } catch (e) { gpsError = e; pos = lastFix; }
    }

    // 1. Location filter
    let candidates = data.invaders.map((inv) => ({
      inv,
      dist: pos ? distanceMeters(pos.coords.latitude, pos.coords.longitude, inv.lat, inv.lng) : null,
    }));
    if (!test) {
      if (!pos) {
        return showResult(null, `<strong class="bad">Location needed</strong>
          <span class="small">Allow location access for this site and try again. (${esc(gpsError ? gpsError.message : 'unknown error')})</span>`);
      }
      const slack = Math.min(pos.coords.accuracy || 0, 150);
      const near = candidates.filter((c) => c.dist <= data.radiusMeters + slack);
      if (!near.length) {
        const nearest = candidates.sort((a, b) => a.dist - b.dist)[0];
        return showResult(null, `<strong class="warn">No invader here</strong>
          <span class="small">Nearest is ${esc(nearest.inv.name)}, about ${fmtDist(nearest.dist)} away.</span>`);
      }
      candidates = near;
    }

    // 2. Image match against the remaining candidates
    const shots = await embedPhoto(img);
    for (const c of candidates) {
      c.score = -1;
      for (const r of refEmb[c.inv.id]) for (const s of shots) c.score = Math.max(c.score, cosine(r, s));
    }
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const scoreTxt = `match score ${best.score.toFixed(2)}, needed ${data.similarityThreshold}`;
    const distTxt = best.dist != null ? ` · ${fmtDist(best.dist)} away` : '';
    const testTxt = test ? ' · test mode' : '';

    if (best.score < data.similarityThreshold) {
      return showResult(null, `<strong class="bad">No match</strong>
        <span class="small">Closest was ${esc(best.inv.name)} (${scoreTxt}${distTxt}${testTxt}). Try a straight-on shot that fills the frame.</span>`);
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
    };
    saveFound();
    render();
    showResult(null, `<strong class="ok">Flashed! +${best.inv.points || 0} pts</strong>
      <span class="small">${esc(best.inv.name)} (${scoreTxt}${distTxt}${testTxt})</span>`);
  } catch (e) {
    console.error(e);
    showResult(null, `<strong class="bad">Something went wrong</strong><span class="small">${esc(e.message)}</span>`);
  }
}

// ---------- tools ----------
function setupTools() {
  const tm = $('testmode');
  tm.checked = testMode();
  tm.addEventListener('change', () => {
    try { localStorage.setItem(TEST_KEY, tm.checked ? '1' : '0'); } catch {}
  });

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
  $('reset-yes').addEventListener('click', () => {
    found = {};
    saveFound();
    render();
    $('reset-confirm').hidden = true;
  });
}

// Open with ?selftest to print how similar the reference images are to each other.
function selfTest() {
  const ids = data.invaders.map((i) => i.id);
  const lines = ['      ' + ids.map((i) => i.slice(-2).padStart(6)).join('')];
  for (const a of ids) {
    lines.push(a.slice(-2).padStart(6) + ids.map((b) => cosine(refEmb[a][0], refEmb[b][0]).toFixed(2).padStart(6)).join(''));
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
  console.info('[ih] data loaded');
  render();

  model = await mobilenet.load({ version: 2, alpha: 1.0, modelUrl: 'model/model.json', inputRange: [0, 1] });
  console.info('[ih] model loaded, backend', tf.getBackend());
  for (const inv of data.invaders) {
    refEmb[inv.id] = [];
    for (const src of inv.refs) refEmb[inv.id].push(await embed(cropToCanvas(await loadImage(src), 1)));
  }

  console.info('[ih] references ready');
  const input = $('camera');
  const flash = $('flash');
  input.disabled = false;
  flash.classList.remove('disabled');
  $('flash-text').textContent = 'Flash an invader';
  // iOS often drops the location prompt if it fires while the camera opens,
  // so location must be granted first, in its own tap.
  flash.addEventListener('click', (ev) => {
    if (testMode() || lastFix) return;
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
