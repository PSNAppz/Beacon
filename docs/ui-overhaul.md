# Beacon — UI overhaul

A plan for rebuilding Beacon's interface. It assumes the reader has the repo open
and has not memorised it; every claim about the current UI points at real code.

Companion documents: [plan-ui-and-auto-update.md](plan-ui-and-auto-update.md) covers the
dot-grid backdrop and auto-update. [user-guide.md](user-guide.md) is the end-user guide.

---

## 0. What's wrong today

Not "it looks dated" — specific, fixable problems found by reading the code. Items struck
through have since been fixed.

**Shell**

- `src/app/App.tsx` is text tabs and a Lock button. `decorations: true` in
  `tauri.conf.json` means a native title bar sits directly above our own header —
  two stacked bars, ~70px of chrome before any content.
- The Workspace never says which host you are looking at above the sidebar.

**Sessions page** (`src/app/HomePage.tsx`)

- No search, no sort, no filter. Fine at 6 hosts, unusable at 60.
- ~~Delete uses `window.confirm()`.~~ Fixed.
- A second, local toast implementation (`useState` + `setTimeout`) duplicating the global
  `toastStore` used everywhere else.
- Timestamps are raw `toLocaleString()`; "Last seen 16/09/2026, 14:22:03" reads worse than
  "Last seen 2h ago".

**Workspace** (`src/app/WorkspacePage.tsx`)

- One file holds the page, the host tree, the tab bar, the log pane, the stats strip, the
  density scrubber and the JSON viewer. Nothing is individually testable.
- ~~The log toolbar carries ~12 controls in a `flex-wrap` row … the direct cause of
  "I have to widen the window."~~ Fixed.
- ~~The sidebar is a hardcoded `w-64`. The split pane is a fixed 50/50.~~ Fixed.
- Tabs cannot be reordered, middle-click does not close, and overflow just scrolls with no
  affordance that there is more.
- Log rows are a fixed 18px with no wrap, no line numbers, no copy-line, no timestamp
  toggle, and the timestamp gutter scrolls away horizontally.
- The status footer is a monospace sentence rather than a real status bar.

**Overlays** (`src/components/ui.tsx`)

- ~~`Modal` has no focus trap, no ESC handler, no scroll lock, and closes on any
  backdrop click — losing a half-filled `SessionWizard`.~~ Fixed.
- `SessionWizard` is ~395 lines of one flat form despite being called a wizard.

**Foundation**

- Dark-only. `darkMode: "class"` is configured in `tailwind.config.ts` and never used.
- Loading states are the literal string "Loading…".
- ~~Icons are inline SVG path data, duplicated across files.~~ Fixed (lucide).
- ~~No `focus-visible` styling anywhere.~~ Added to the shared controls.

---

## 1. Principles

1. **The logs are the product.** Chrome shrinks, log area grows. Every control that is not
   used more than once a minute moves behind a menu.
2. **Density is a setting, not a taste.** Comfortable and compact modes.
3. **Nothing animates inside the log list.** Ever.
4. **Keyboard first.** Every action reachable without the mouse, and visibly focused.
5. **Copy in, don't depend out.** Component code lives in the repo (shadcn model).

---

## 2. Foundation

### Tokens

Move to Tailwind v4's CSS-first config. One `@theme` block replaces `tailwind.config.ts`;
the current `rgb(var(--x) / <alpha-value>)` indirection goes away.

- **Colour** — the palette is now monochrome by design: greyscale chrome, with
  `danger`/`warn`/`ok` as the only colour left so state carries all the signal. Split the
  roles further: `bg`, `surface`, `raised`, `overlay`, `border`, `border-strong`, `fg`,
  `fg-muted`, `fg-subtle`. The log viewer also needs a stable ANSI ramp.
- **Type** — one scale: 11/12/13/15/18/24. The code uses `text-[9px]` through
  `text-[15px]` with arbitrary values in ~40 places.
- **Spacing** — 4px base, plus a `--density` multiplier driving row height and padding.
- **Radius** — 6/10/14. **Elevation** — three shadow steps.

### Theming

`data-theme="dark|light|system"` on `<html>`, persisted in `src/lib/prefsStore.ts`.
Light mode is real work: the dot-grid backdrop, the log severity colours and the diff
highlighting all need a second set of values.

---

## 3. Library decisions

| Concern | Now | Choose | Why |
|---|---|---|---|
| CSS engine | Tailwind v3 | **Tailwind v4** | CSS-first tokens, much faster rebuilds |
| Primitives | ~~hand-rolled~~ | **Radix UI** ✅ | Focus traps, ESC, ARIA |
| Variants | ~~template strings~~ | **cva** + `tailwind-merge` ✅ | |
| Icons | ~~inline SVG~~ | **lucide-react** ✅ | |
| Toasts | `toastStore` + two impls | **sonner** | Stacking, actions, promise states |
| Palette | `CommandPalette.tsx` | **cmdk** | Fuzzy scoring, groups, nested pages |
| Panels | ~~fixed flex~~ | **react-resizable-panels** ✅ | |
| Virtual | `@tanstack/react-virtual` | **keep** | Already correct |
| Motion | none | **motion** v12 | Overlays and layout only, never log rows |
| Forms | manual `useState` | **react-hook-form** + zod | `SessionWizard` has 20+ fields, no validation |

**Rejected:** MUI / Mantine / Chakra — runtime theming engines fighting Tailwind, and
bundle cost a desktop log viewer cannot justify. **Base UI** — still stabilising.
**Ark UI** — fine, but Radix has the larger copy-in ecosystem via shadcn.

> **API note.** `react-resizable-panels` v4 is not what older guides describe. It exports
> `Group` / `Panel` / `Separator`, takes `orientation` rather than `direction`, uses
> percentage strings for sizes, and has no `order` prop. Conditional panels are handled
> with `useDefaultLayout({ id, panelIds, storage })`.

---

## 4. Screen by screen

### 4.1 App shell

- Custom title bar: `decorations: false` plus `data-tauri-drag-region`, reclaiming a full
  bar of vertical space. Traffic-light inset on macOS, custom controls elsewhere.
- Left rail replaces the top tabs: icons with tooltips, a connection-count badge on
  Workspace, lock pinned to the bottom.
- Global status line in the title bar: active host, connection state, update chip.

### 4.2 Sessions

- **List, not a card grid.** A virtualised table: status, name, `user@host:port`,
  category, auth kind, last seen (relative), row actions.
- Toolbar: fuzzy search over name/host/user, category filter, sort, density toggle.
- Row menu: Edit, Duplicate, Export, Pin to workspace, Delete.
- Multi-select for bulk export and delete. Skeleton rows while loading, and a distinct
  error state for "vault unlocked but list failed", which today renders as empty.

### 4.3 Workspace

**Layout.** ✅ Resizable regions via `react-resizable-panels`, widths persisted. Still to
do: collapse the host tree to an icon rail rather than hiding it outright.

**Host tree.** Active-plus-pinned filtering is in. Still to do: drag to reorder pins,
a per-host context menu, and a container search box past ~10 containers.

**Tab bar.** Still to do: drag reorder, middle-click close, overflow dropdown, and
`Cmd/Ctrl+1–9`.

**Log toolbar.** ✅ Four zones that never wrap:

```
[ ●  container-name · a1b2c3d4 · Up 3 days ]  [ filter ]  [ ⏸ ⇊ ⌫ ]  [ ⋯ ]
   identity (truncates)                        always      hot        overflow
```

**Log surface.** Still to do, and the biggest remaining win:

- Sticky timestamp gutter, frozen while the body scrolls horizontally.
- Line numbers; per-line copy, copy-JSON, filter-to-pattern, pin.
- **Wrap toggle** — the hard one: variable row heights mean moving the virtualiser to
  `measureElement`, which interacts with auto-scroll and the diff line-up.
- In-buffer search separate from the filter, with match count and n/N navigation.
  Filtering and finding are different tasks; one input conflates them.
- Severity inferred per line driving a 2px left border, so user highlights stay legible.
- ANSI colour parsing — container logs are full of escape codes rendered raw today.

**Right inspector** replacing the stats strip and JSON panel, both of which steal height
from the log. Tabbed Stats / JSON / Line detail, collapsed by default.

**Status bar** with real zones, each clickable to the relevant control.

### 4.4 Modals and the wizard

- ✅ Radix `Dialog` everywhere, with `dismissable={false}` for dirty forms.
- `SessionWizard` becomes a three-step flow: Identity → Auth → Advanced, with zod
  validation per step and an inline connection test.

### 4.5 Settings

Sectioned two-column layout with a sticky section nav and search. The page is already
long and will only grow.

---

## 5. Motion

Durations 120ms (micro), 180ms (overlay), 240ms (layout); easing
`cubic-bezier(0.2, 0, 0, 1)`.

Animate: dialog and popover enter/exit, toast stack, panel resize settle, tab reorder,
sidebar collapse. Do **not** animate anything inside the log list, status dots, or route
changes. Respect `prefers-reduced-motion`, as `DotGrid` already does.

---

## 6. Keyboard and accessibility

| Key | Action |
|---|---|
| `Cmd/Ctrl+K` | Command palette (exists) |
| `Cmd/Ctrl+F` | Search in buffer |
| `Cmd/Ctrl+1–9` | Jump to tab |
| `Cmd/Ctrl+W` | Close tab |
| `Cmd/Ctrl+\` | Toggle split |
| `Cmd/Ctrl+B` | Toggle sidebar |
| `Cmd/Ctrl+L` | Lock vault |
| `Space` | Pause/resume stream |
| `G` then `H`/`W`/`S` | Go to Sessions / Workspace / Settings |

Plus a `?` shortcut overlay, `aria-label` on every icon-only button, live-region
announcements for connection state, and a contrast pass targeting WCAG AA —
`text-muted` passes for body text but fails at the `text-[9px]`/`text-[10px]` sizes used
throughout the sidebar.

---

## 7. Performance budget

- Log rows stay virtualised and memoised; no context reads inside a row.
- Keep the 400ms batch tick and the paused-buffer path.
- Interaction to paint under 100ms; no layout thrash on resize.
- Idle CPU under 1% with a live stream and the dot grid on. Measure before and after each
  phase — Radix and motion both add mount-time work.
- Bundle ceiling 260 KB gzipped. Route-split Settings, the Guide and the wizard if
  approached.

---

## 8. Architecture refactor

The oversized `WorkspacePage.tsx` is the main obstacle to everything above.

```
src/
  components/ui/        Button, Input, Select, Dialog, DropdownMenu, Tooltip, …
  features/
    sessions/           list, row, wizard steps, import/export
    workspace/
      HostTree/
      TabBar/
      LogPane/          LogPane, LogRow, LogToolbar, LogSearch, useLogStream
      Inspector/
    upgrades/           (already exists)
  lib/                  stores, ipc, hooks
```

`LogPane` splits into a `useLogStream` hook (stream lifecycle, batching, archive flush,
alert rules) and a presentational component. That hook is ~200 lines inlined today.

---

## 9. Delivery

| # | Phase | Scope | Effort | Risk |
|---|---|---|---|---|
| 1 | Foundation | Tailwind v4, tokens, light/dark, density var | 1–2 d | Medium — touches every file |
| 2 | Primitives — **done** | cva + lucide + shared controls | 1 d | Low |
| 3 | Overlays — **done** | Radix Dialog + AlertDialog; `confirm()` gone | 1–2 d | Low, high payoff |
| 4 | Shell | Custom title bar, left rail, status bar | 1 d | Medium — per-platform fiddly |
| 5 | Workspace layout — **mostly done** | Resizable panels ✅, toolbar ✅, tab bar ⬜ | 2 d | Medium |
| 6 | Log surface | Sticky gutter, ANSI, severity, line actions, in-buffer search | 2–3 d | Medium |
| 7 | Sessions | Virtualised table, search/sort/filter, bulk actions | 1–2 d | Low |
| 8 | Wizard + forms | react-hook-form + zod, three-step flow | 1–2 d | Medium |
| 9 | Palette + toasts | cmdk, sonner, shortcut overlay | 1 d | Low |
| 10 | Wrap toggle | Dynamic row measurement | 1 d | **High** — do last, behind a flag |

**Shipped so far:** phases 2, 3 and most of 5, plus the monochrome palette and the
user guide.

**Next, in order of value:** phase 6 (the log surface — ANSI colour and in-buffer search
are felt daily), then the phase 5 remainder, then 7.

**Phase 1 caveat:** the Tailwind v4 migration is breaking, touches every file, and has no
visible payoff of its own. Do it when someone can watch the screen; the token work it
enables can be done on v3 first.
