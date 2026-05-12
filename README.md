# Beacon

A modern, cross-platform desktop app for SSH-based observability of remote Docker hosts.

Browse `docker ps` on any host you can SSH into, stream container logs into a searchable IDE-style workspace, run commands in an embedded terminal, and do it all from a single window that works the same on Windows, macOS, and Linux.

> **Status:** early development. Phase 1 (shell + theming) and Phase 2 (vault + SSH session CRUD + test connect) are complete. Live log streaming and the IDE workspace are next.

---

## Concept

The day-to-day problem Beacon solves:

> "I have a dozen EC2 hosts. Each runs a handful of containers. When something breaks I want to see *all* the relevant logs side-by-side, filter them, jump to a moment in time, and occasionally `restart` a container — without juggling six terminals."

Beacon is one window that:

- Stores a list of SSH session profiles (host, port, user, key/password, optional bastion).
- Connects on demand, lists containers via `docker ps`, and streams `docker logs -f` into a virtualized log viewer with regex search, saved filters, and JSON pretty-printing.
- Supports multi-pane layouts so you can watch many containers at once.
- Ships an embedded `xterm.js` terminal for the same SSH session.
- Lets you `start` / `stop` / `restart` / `exec` containers from the UI (or marks a session **read-only** to prevent that on production hosts).
- Stores everything locally in an encrypted vault. Sensitive material (key passphrases, passwords) is encrypted with a key derived from a master password you set on first launch.

Beacon is **local-only**. There is no cloud, no telemetry, no account.

---

## Architecture

```
┌───────────────────────────── Tauri App ─────────────────────────────┐
│  Frontend (system webview)                Rust core (tokio)         │
│  ┌──────────────────────────┐   invoke    ┌──────────────────────┐  │
│  │ React + TypeScript       │ ──────────▶ │ Tauri command        │  │
│  │  • Session picker (cards)│             │  handlers            │  │
│  │  • Master-password lock  │ ◀────────── │                      │  │
│  │  • Session wizard        │   events    └──────┬───────────────┘  │
│  │  • Workspace (planned)   │                    │                  │
│  │    - virtualized logs    │            ┌───────▼───────────────┐  │
│  │    - xterm.js terminal   │            │ Session manager       │  │
│  │    - command palette     │            │  • russh clients      │  │
│  └──────────────────────────┘            │  • ProxyJump bastion  │  │
│                                          │  • auto-reconnect     │  │
│                                          └───────┬───────────────┘  │
│                                          ┌───────▼───────────────┐  │
│                                          │ Subsystems            │  │
│                                          │  • LogStream          │  │
│                                          │    (docker logs -f)   │  │
│                                          │  • Docker actions     │  │
│                                          │  • Stats poller       │  │
│                                          │  • Audit logger       │  │
│                                          │  • Log archiver       │  │
│                                          └───────┬───────────────┘  │
│                                          ┌───────▼───────────────┐  │
│                                          │ Vault                 │  │
│                                          │  • SQLite (rusqlite)  │  │
│                                          │  • Argon2id KDF       │  │
│                                          │  • ChaCha20-Poly1305  │  │
│                                          │    AEAD on secrets    │  │
│                                          └───────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### Tech stack

| Layer        | Choice                                                    |
| ------------ | --------------------------------------------------------- |
| Shell        | Tauri 2 (Rust core + system webview, ~10 MB binaries)     |
| Backend lang | Rust (tokio async runtime)                                |
| SSH          | `russh` + `russh-keys` (PEM/OpenSSH, password, ProxyJump) |
| Storage      | SQLite via `rusqlite` (bundled), no system dep            |
| Crypto       | Argon2id (KDF) + ChaCha20-Poly1305 (AEAD) on secret fields |
| Frontend     | React 18 + TypeScript + Vite                              |
| Styling      | Tailwind CSS (dark-first, custom token palette)           |
| Fonts        | Inter (UI) + JetBrains Mono (logs / terminal)             |
| Terminal     | `xterm.js` (planned for Phase 5)                          |
| Log list     | `@tanstack/react-virtual` (planned for Phase 3)           |
| State        | Zustand                                                   |

### Vault & security model

- On first launch you set a **master password**. It never touches disk.
- A 32-byte vault key is derived with **Argon2id** (m=64MiB, t=3, p=1) over a random 16-byte salt stored in the DB.
- Secret fields on each session (key passphrase or password) are encrypted with **ChaCha20-Poly1305** (`nonce ‖ ciphertext+tag`, base64). Non-secret metadata (host, user, key file path) is stored as plaintext in the SQLite row.
- A short "verifier" blob is encrypted with the derived key on vault creation. Unlock decrypts it; AEAD failure means a wrong password — we surface that without leaking timing info.
- "Read-only" sessions are enforced **both** in the UI and in the Rust command layer — defense in depth.

The DB lives at the platform's app-data directory:

| OS      | Path                                            |
| ------- | ----------------------------------------------- |
| Windows | `%APPDATA%\Beacon\vault.db`                     |
| macOS   | `~/Library/Application Support/Beacon/vault.db` |
| Linux   | `~/.local/share/Beacon/vault.db`                |

Delete the file to reset the vault.

### Repository layout

```
Beacon/
├── src-tauri/                # Rust core
│   ├── src/
│   │   ├── main.rs           # binary entry
│   │   ├── lib.rs            # Tauri builder + command registry
│   │   ├── error.rs          # AppError + AppResult
│   │   ├── crypto.rs         # Argon2id KDF + ChaCha20-Poly1305 AEAD
│   │   ├── commands.rs       # #[tauri::command] handlers exposed to JS
│   │   ├── storage/
│   │   │   ├── db.rs         # Vault open/create/unlock + migrations
│   │   │   └── sessions.rs   # session CRUD
│   │   └── ssh/
│   │       └── client.rs     # russh wrapper + ProxyJump test connect
│   ├── capabilities/         # Tauri permission scopes
│   ├── icons/                # generated by `tauri icon`
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                      # React frontend
│   ├── main.tsx              # router entry
│   ├── app/
│   │   ├── App.tsx           # shell, lock gate, header
│   │   ├── LockScreen.tsx    # create / unlock vault
│   │   ├── HomePage.tsx      # session cards
│   │   ├── WorkspacePage.tsx # log workspace (shell only for now)
│   │   └── SettingsPage.tsx
│   ├── features/
│   │   └── sessions/SessionWizard.tsx
│   ├── components/ui.tsx     # Button, Input, Modal, Toast primitives
│   ├── lib/
│   │   ├── ipc.ts            # typed wrappers around invoke()
│   │   └── store.ts          # Zustand app state
│   └── styles/globals.css    # Tailwind + theme tokens
├── package.json
├── vite.config.ts
└── tailwind.config.ts
```

---

## Running Beacon locally

You need a working **Rust toolchain**, **Node.js 20+**, and your OS's webview / build prereqs. First Rust compile takes a few minutes; subsequent runs are fast (hot-reload for the frontend, incremental compile for the backend).

### 1. Common prerequisites (all OSes)

- **Rust** ≥ 1.77 — install via [rustup](https://rustup.rs/)
- **Node.js** ≥ 20 LTS — install via [nodejs.org](https://nodejs.org/) or your package manager

### 2. Windows

System prereqs:

- **WebView2 Runtime** — preinstalled on Windows 11; for Windows 10 grab the [Evergreen installer](https://developer.microsoft.com/microsoft-edge/webview2/).
- **MSVC build tools** — install "Desktop development with C++" via the Visual Studio Build Tools, or run `rustup default stable-msvc`.

Then, from the project root:

```powershell
npm install
npm run tauri dev
```

The first build compiles the full Rust dependency tree (3–6 min). On subsequent runs only your changes recompile.

### 3. macOS

System prereqs:

- **Xcode Command Line Tools** — `xcode-select --install`

Then:

```bash
npm install
npm run tauri dev
```

To build a signed `.app` for distribution, see the [Tauri macOS bundling docs](https://v2.tauri.app/distribute/macos-application/).

### 4. Linux (Ubuntu / Debian)

System prereqs (Ubuntu 22.04+):

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

For other distributions see the [Tauri Linux prereqs](https://v2.tauri.app/start/prerequisites/#linux).

Then:

```bash
npm install
npm run tauri dev
```

### 5. Production builds

```bash
npm run tauri build
```

Outputs land under `src-tauri/target/release/bundle/`:

- Windows: `.msi` and `.exe` installer
- macOS: `.app` and `.dmg`
- Linux: `.deb`, `.rpm`, and `.AppImage`

---

## Roadmap

The full plan lives in [`.claude/plans/`](https://claude.ai) in this repo's parent state. Headline phases:

- [x] **Phase 1** — Bootstrap, theming, routing
- [x] **Phase 2** — Vault (Argon2id + AEAD), SSH session CRUD, test connect, ProxyJump
- [ ] **Phase 3** — Docker container listing + live log streaming + virtualized log pane
- [ ] **Phase 4** — Workspace shell: tabs, splits, host tree, ⌘/Ctrl-K command palette, session restore
- [ ] **Phase 5** — Embedded `xterm.js` terminal, container start/stop/restart/exec, audit log
- [ ] **Phase 6** — Saved filters, highlight rules, JSON pretty-print, regex alerts → desktop notifications
- [ ] **Phase 7** — `docker stats`, rolling log archive, time-range scrubber, two-stream diff, export
- [ ] **Phase 8** — Auto-reconnect polish, known_hosts/TOFU prompt, signed installers via GitHub Actions

Post-MVP candidates: Kubernetes pods alongside `docker ps`, plugin/extension API, optional cloud-sync.

---

## License

TBD.
