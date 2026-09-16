# Beacon — UI revamp & auto-update plan

Status: planning document. Items marked **done** have shipped.

---

## 1. Visual direction: dot-grid backdrop — **done**

An interactive canvas dot grid ([React Bits](https://reactbits.dev/backgrounds/dot-grid), MIT)
now sits behind every page.

- `src/components/DotGrid.tsx` — vendored component. Diverges from upstream in three ways:
  idle frames are skipped (repaint only when the pointer moved or a dot is mid-tween),
  painting stops while the window is hidden, and `prefers-reduced-motion` gets a static grid
  with no gsap wiring. Upstream repaints ~500 dots at 60fps forever, which is the wrong
  trade for an app that sits open all day streaming logs.
- `src/components/AppBackground.tsx` — fixed, `pointer-events-none` layer plus a gradient
  scrim so text never fights the grid. Mounted once in `App.tsx`, so it covers the lock
  screen, Sessions, Workspace and Settings.
- Surfaces above it moved to `bg-surface/60–80`; the log viewport deliberately stays opaque
  (`bg-bg`) for contrast and to keep compositing off the hot path.
- Settings → Appearance → **Animated background** unmounts the canvas entirely.
- Cost: `gsap` adds ~33 KB gzipped to the bundle.

Tuning knobs live in `AppBackground.tsx`: `dotSize`, `gap`, `proximity`, `shockRadius`,
`shockStrength`, and the scrim opacity.

---

## 2. Component-library revamp — planned

Moved to its own document: **[ui-overhaul.md](ui-overhaul.md)** — audit of what is wrong
today, design-system foundation, library decisions, screen-by-screen redesign, motion and
keyboard specs, performance budget, architecture refactor, and a ten-phase delivery plan.

---

## 3. Auto-update — **done**

Shipped with `tauri-plugin-updater` + `tauri-plugin-process`.

- **Signing** — a minisign keypair lives at `~/.tauri/beacon-updater.key` (passwordless).
  The public half is in `plugins.updater.pubkey` in `tauri.conf.json`.
  **Action required:** add the private key to the repo as the secret
  `TAURI_SIGNING_PRIVATE_KEY`, and an empty `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
  Back the private key up — losing it means no client can ever accept an update again.
- **Endpoint** — `https://github.com/PSNAppz/Beacon/releases/latest/download/latest.json`,
  with `bundle.createUpdaterArtifacts: true`.
- **CI** — `release.yml` now exports both signing variables, sets
  `includeUpdaterJson: true`, and `releaseDraft: false` (the endpoint skips drafts).
- **Client** — `src/lib/updaterStore.ts` holds the state machine
  (idle / checking / available / downloading / ready / uptodate / error), a check on
  launch after unlock, then every 6 hours, and preferences for auto-check and
  auto-install. Settings → Updates has the manual control, progress bar and release
  notes; the header shows an "Update x.y.z" chip, then "Restart to update" once staged.

Verified locally: a signed build produces `Beacon.app.tar.gz` + `.sig`, and the key id in
the signature matches the pubkey embedded in the app (`d0a9dd0cd713d74f`).

### Platform notes

- **macOS — minimal, no Apple Developer account.** Only the minisign key is needed;
  updates do not require Apple code signing. The trade-off lands on *first install*:
  a browser-downloaded build carries `com.apple.quarantine`, so users see
  "Beacon cannot be verified" and must right-click → Open, or run
  `xattr -dr com.apple.quarantine /Applications/Beacon.app`. Builds already carry an
  ad-hoc linker signature, which is what the updater needs to preserve.
  *Still to verify on the first real release:* that an unsigned `.app` relaunches
  cleanly after the updater swaps it on Apple Silicon.
- **Windows** — NSIS, `installMode: "passive"`. SmartScreen warns on first install only.
- **Linux** — AppImage only. `.deb`/`.rpm` cannot self-update.

### Releasing

```
npm version patch          # bump package.json + tauri.conf.json
git tag v0.2.1 && git push --tags
```

CI builds all four targets, signs them, and publishes a non-draft release with
`latest.json`. Running clients pick it up within 6 hours, or immediately via
Settings → Check now.

---

## 4. User guide — **done**

`src/content/user-guide.md` is the single source of truth. It is compiled into the app
and rendered on the **Guide** tab (`src/app/HelpPage.tsx`, react-markdown + remark-gfm),
with the diagrams in `src/content/images/*.svg` resolved through `import.meta.glob`.

`npm run docs:sync` — which also runs as part of `npm run build` — mirrors the guide and
its diagrams into `docs/user-guide.md` so the same content is readable on GitHub. Edit the
source under `src/content/`, never the copy in `docs/`.
