# Invader Hunt

A Flash Invaders-style game for a group of friends. Players photograph street-art invaders; the app checks their GPS position and compares the photo with reference photos, then credits the find. Runs as a web app (PWA) on iOS and Android.

- Live app: https://quantum-menace.github.io/invader-hunt/
- Repo: https://github.com/quantum-menace/invader-hunt (public, GitHub account `quantum-menace`)
- Hosting: GitHub Pages from `main`, root folder. Every push deploys in about a minute; phones may keep a cached copy for up to ~10 minutes.
- Backend: Supabase project `shpjtjsjinejatcklijv` (free plan, Frankfurt/Zürich region). URL and publishable key are in `config.js`; both are public by design.

## Files

- `index.html`, `style.css` — single page; pixel look (Press Start 2P + VT323 fonts, bundled in `fonts/`).
- `app.js` — UI, GPS, flashing, collection grouped by city, login, leaderboard, admin tools.
- `match.js` — image matching shared by the app and `tools/eval.html`.
- `cloud.js` — every Supabase call. With empty values in `config.js` the app runs device-only.
- `data.json` — settings (`radiusMeters`, `similarityThreshold`, `colorWeight`, `minMargin`, city order) plus a fallback invader list used only if Supabase is unreachable.
- `supabase/schema.sql` — tables, access rules, storage bucket, seed data. Safe to re-run in the Supabase SQL editor.
- `tools/eval.html` — builds fake photos from the reference images and reports match quality per colour weight. Use it to tune `data.json` settings.
- `vendor/` (tfjs 4.22.0, mobilenet 2.1.1, supabase-js 2.117.3) and `model/` (MobileNet v2 weights) are bundled so nothing loads from a CDN.
- `.github/workflows/keep-supabase-awake.yml` — reads one row every 3 days so the free Supabase project does not pause.

## How matching works

No training. Pretrained MobileNet v2 turns each image into an embedding; a hue histogram of the saturated pixels captures tile colours. Score = (1 - colorWeight) × embedding cosine + colorWeight × colour overlap. Photos are tried at three centre crops. A flash counts if the best nearby candidate scores at least `similarityThreshold` and beats the runner-up by `minMargin`; otherwise the app asks for a better shot. Current settings: radius 500 m, threshold 0.6, colorWeight 0.4, minMargin 0.05. Hue-only colour bins were chosen after testing: saturation bins made matches fragile under lighting changes.

## Accounts and data

- Players log in with just a name (no password). Same name on another phone continues the same collection. Finds are stored on the phone first and synced to Supabase.
- Finds made with a pretend location are flagged `simulated` and do not count on the leaderboard.
- Admin: log in with the name `admin` and the admin password. The app signs in to Supabase user `admin@invader-hunt.local` behind the scenes; that address is in the `admins` table, and row-level security only lets admins edit invaders, reference photos and the photo bucket. The admin player is hidden from the leaderboard.
- Admin tools (under Tools): create invaders (typed/pasted coordinates or GPS), move them, edit points, add reference photos, delete photos (tap to flip, tap again), delete invaders (two taps; cascades to photos and finds).
- Players cannot be deleted from the app; remove them in the Supabase Table Editor.

## Decisions the user made

- Light security is fine for this friends game: name-only login, scores editable by anyone with the key.
- An attempt to let anyone edit invaders/photos (no admin check in the database) was blocked by the safety check; the admin check stays in the database.
- Two Munich invaders are in the same apartment, so GPS cannot separate them; image matching must.

## Working on this project

- Never test writes or deletes against the user's real invaders or photos. Create a throwaway invader (e.g. `TEST_98` in city `Testcity`), test on it, delete it, and verify the real data is unchanged. Never pick records by position.
- This PC's connection to github.io and some CDNs drops intermittently; Supabase and the GitHub API are reliable. For browser tests, serve the repo locally (a small PowerShell HttpListener works) and drive headless Firefox over WebDriver BiDi. Chrome's `--virtual-time-budget` aborts the large model downloads.
- `gh` is installed at `C:\Program Files\GitHub CLI` and may need adding to PATH in Bash.
- Commit messages end with a Co-Authored-By line for Claude.

## Open items

- User is adding the real invaders (coordinates, 3–5 reference photos each) and will then delete the placeholder SVG references.
- After a real test round, tune `similarityThreshold` / `colorWeight` / `minMargin` from the scores the app shows.
- Optional: "new version available" banner; show undiscovered invaders as silhouettes instead of a darkened reference photo.
