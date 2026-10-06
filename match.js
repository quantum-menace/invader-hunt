'use strict';

// Image matching shared by the app and tools/eval.html.
//
// Each image gets two fingerprints:
//  - a MobileNet embedding, which captures shape and texture but mostly ignores colour
//  - a colour histogram of the saturated pixels, which captures the tile colours
// The match score blends both: (1 - colorWeight) * embedding + colorWeight * colour.
const Matcher = (() => {
  const SIZE = 224;
  const ZOOMS = [1, 0.7, 0.5];        // crops tried for each photo
  const HUE_BINS = 12, SAT_BINS = 3;  // colour histogram layout
  const MIN_SAT = 0.25, MIN_VAL = 0.2; // below this a pixel counts as grey (wall, grout)
  const MIN_CHROMA_SHARE = 0.02;      // fewer coloured pixels than this: colour says nothing

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not load image ' + src));
      img.src = src;
    });
  }

  // Centered square crop (zoom = fraction of the short side) scaled to size x size.
  function cropToCanvas(img, zoom = 1, size = SIZE) {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const side = Math.min(w, h) * zoom;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d').drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
    return c;
  }

  function cosine(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  // Hue/saturation histogram of the coloured pixels only, so grey walls and
  // grout do not make every photo look alike. Hue is split softly between
  // neighbouring bins so small colour casts from lighting do not jump bins.
  function colorHist(canvas) {
    const small = document.createElement('canvas');
    small.width = small.height = 64;
    const ctx = small.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, 64, 64);
    const px = ctx.getImageData(0, 0, 64, 64).data;
    const hist = new Float32Array(HUE_BINS * SAT_BINS);
    let chroma = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      const s = max ? d / max : 0;
      if (s < MIN_SAT || max < MIN_VAL) continue;
      let h;
      if (max === r) h = ((g - b) / d + 6) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      const hf = (h / 6) * HUE_BINS - 0.5;
      const h0 = Math.floor(hf), t = hf - h0;
      const sb = Math.min(SAT_BINS - 1, Math.floor(((s - MIN_SAT) / (1 - MIN_SAT)) * SAT_BINS));
      hist[((h0 + HUE_BINS) % HUE_BINS) * SAT_BINS + sb] += 1 - t;
      hist[((h0 + 1) % HUE_BINS) * SAT_BINS + sb] += t;
      chroma++;
    }
    if (chroma) for (let i = 0; i < hist.length; i++) hist[i] /= chroma;
    return { hist, share: chroma / (px.length / 4) };
  }

  // 0..1 overlap of two colour histograms; 0.5 (neutral) if either is grey.
  function colorSim(a, b) {
    if (a.share < MIN_CHROMA_SHARE || b.share < MIN_CHROMA_SHARE) return 0.5;
    let s = 0;
    for (let i = 0; i < a.hist.length; i++) s += Math.min(a.hist[i], b.hist[i]);
    return s;
  }

  async function create(modelUrl) {
    const model = await mobilenet.load({ version: 2, alpha: 1.0, modelUrl, inputRange: [0, 1] });

    async function embed(canvas) {
      const t = tf.tidy(() => {
        const v = model.infer(canvas, true).flatten();
        return v.div(v.norm());
      });
      try { return await t.data(); } finally { t.dispose(); }
    }

    // Fingerprint of one crop: { emb, color }.
    async function fingerprint(canvas) {
      return { emb: await embed(canvas), color: colorHist(canvas) };
    }

    // Reference photos are framed by hand, so one full crop is enough.
    async function fingerprintRef(img) {
      return fingerprint(cropToCanvas(img, 1));
    }

    // Photos from the camera may show the invader small, so try several crops.
    async function fingerprintPhoto(img) {
      const out = [];
      for (const z of ZOOMS) out.push(await fingerprint(cropToCanvas(img, z)));
      return out;
    }

    // Best blended score of a photo against one invader's reference fingerprints.
    function score(shots, refs, colorWeight) {
      let best = { score: -1, emb: 0, color: 0 };
      for (const r of refs) {
        for (const s of shots) {
          const e = cosine(r.emb, s.emb), c = colorSim(r.color, s.color);
          const v = (1 - colorWeight) * e + colorWeight * c;
          if (v > best.score) best = { score: v, emb: e, color: c };
        }
      }
      return best;
    }

    return { fingerprintRef, fingerprintPhoto, score };
  }

  return { create, loadImage, cropToCanvas };
})();
