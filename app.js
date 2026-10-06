'use strict';

const STORE_KEY = 'invader-hunt.found.v1';
const LOC_KEY = 'invader-hunt.location';   // 'real', 'any', or a city name
const OLD_TEST_KEY = 'invader-hunt.testmode';
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

function cityList() {
  const cities = [...(data.cities || [])];
  for (const inv of data.invaders) if (!cities.includes(inv.city)) cities.push(inv.city);
  return cities;
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
    };
    saveFound();
    render();
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
  $('reset-yes').addEventListener('click', () => {
    found = {};
    saveFound();
    render();
    $('reset-confirm').hidden = true;
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
  sel.addEventListener('change', () => setLocMode(sel.value));
  paintGps();
}

// Open with ?selftest to print how similar the reference images are to each other.
function selfTest() {
  const ids = data.invaders.map((i) => i.id);
  const w = data.colorWeight ?? 0.4;
  const lines = ['        ' + ids.map((i) => i.padStart(7)).join('')];
  for (const a of ids) {
    lines.push(a.padEnd(8) + ids.map((b) => matcher.score([refs[a][0]], refs[b], w).score.toFixed(2).padStart(7)).join(''));
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
  setupLocationPicker();

  matcher = await Matcher.create('model/model.json');
  console.info('[ih] model loaded, backend', tf.getBackend());
  for (const inv of data.invaders) {
    refs[inv.id] = [];
    for (const src of inv.refs) refs[inv.id].push(await matcher.fingerprintRef(await Matcher.loadImage(src)));
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
