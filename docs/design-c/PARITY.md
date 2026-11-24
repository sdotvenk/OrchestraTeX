# Design C Render Parity Record

**Branch:** `feat/design-c-v1`  
**Screens verified:** Home (`Home.dc.html`), Write (`Main.dc.html`), Build & Files (`Build.dc.html`), Dock (`Dock.dc.html`), Agents (`Threads.dc.html`), History (`Review.dc.html`), Usage & limits (`Usage.dc.html`), Nocturne (`Night.dc.html`).

All screens use semantic CSS tokens in `apps/desktop/src/app/globals.css` (Lux and Nocturne), real harness brand marks (`ProviderIcon`), and live backend data only (no synthetic fixtures or mock annotations).

## Parity Table

| Screen | Element | Status | Justification |
| --- | --- | --- | --- |
| Global Shell | Top bar ThemePicker & Settings buttons | Functional addition | Needed so users can switch Lux/Nocturne/Auto and open Build/Editor/Agents settings from any workspace view. |
| Global Shell | Top bar voice avatars | Matched (brand marks) | Uses real `ProviderIcon` marks (Claude, Codex, Antigravity, Custom ACP) instead of single-letter mock placeholders. |
| Global Shell | Bottom status bar `Sync → PDF` button | Removed | Matches Design C renders; forward SyncTeX lives in the PDF pane header instead. |
| Global Shell | Nocturne `"Three-pane layout: source · thread · PDF (wide windows)"` text | Omitted | Mock-only annotation excluded from shipping UI. |
| Home | Two-column layout (`1.45fr 1fr`), wordmark, action bar, Recent projects, `Set up this Mac` | Matched | Matches `Home.dc.html` geometry, tokens, miniature thumbnails, and `⌘P` search focus. |
| Home | Recent project row Git branch/dirty & `Initialise Git` inline action | Backend-limited | `RecentProject` persistence stores path/name/lastOpened without probing unopened folders' Git repos on mount; thread counts and voice dots render when present. |
| Home | LaTeX ready state (`✓ Ready · Tectonic`) + `Detect again` | Functional addition | Shows live compiler detection when a TeX engine is already installed; falls back to the radio installer card (`LaTeXInstallPrompt`) when none is detected. |
| Home | Agents checklist `Detect again` & `Configure…` footer | Functional addition | Lets users re-detect CLIs or jump directly to the Agents settings tab. |
| Write | Stacked left sidebar (`FILES`, `OUTLINE`, `THREADS`, `Usage today`) | Matched | Replaces the old 4-tab sidebar; Git controls live exclusively in History. |
| Write | `Usage today` footer metric | Honest metric | Displays real logged token count (e.g. `933.3k`) and stacked per-provider bar instead of an invented percentage when providers do not report unified quota percentages. |
| Write | Formatting toolbar (`Code \| Visual`, `B I \ref \cite Σ Figure Table`, relative breadcrumb) | Matched | Matches `Main.dc.html`; inserts LaTeX snippets via Monaco `pendingSnippet`. |
| Write | Single-row 44px PDF header (`[Recompile \| ▾]`, `Auto`, `< 1 / N >`, `Fit width`, SyncTeX, Download) | Matched | Eliminates the duplicate PDF toolbar; unavailable compilers appear disabled as `not found` in the `.ox-popover` menu. |
| Write | Forward sync icon in PDF header | Functional addition | Preserves one-click editor-to-PDF SyncTeX jump after removing `Sync → PDF` from the status bar. |
| Write | Collapsed `▸ Score` strip & expanded Score / Problems / Build log / Terminal drawer | Matched | Matches `Main.dc.html` & `Build.dc.html` with voice tracks, SVG marks, and dense Problems rows. |
| Build & Files | Tree `ContextMenu` (`.ox-popover`, shortcuts, voice dots) & inline rename `\input` prompt | Matched | Matches `Build.dc.html`; `Reveal in Finder` / `Open terminal here` / `Ask an agent about this file` wired to existing handlers. |
| Build & Files | Build error state (dimmed PDF + banner + Problems rows + `Build failed` pill) | Matched | Hides `< 1 / N >` while in error state so `Build failed · N error` never collides at 440px pane width. |
| Dock | 2-pane docked thread (`PDF` + thread tabs + `Open in Agents` + metadata row) | Matched | Defaults to `380px` width in 2-pane dock mode so tab bar, raised `ApprovalCard`, and `⌘Y · ⌘N` shortcuts stay single-line. |
| Dock | Floating select-lines popover (`L39–44`, `Ask <Provider>`, `New thread…`, `Explain`) | Matched | Triggered on multi-line Monaco selection; opens/steers the docked thread with line range context. |
| Dock | Raised `ApprovalCard` (`--decision-*`) & flowing transcript with inline tool rows | Matched | Tool calls render inline without collapsing behind a `N tool calls` summary; user turns render as plain left-aligned prose. |
| Dock / Agents | Composer card & Thread Settings `.ox-popover` (`HARNESS`, collapsible `Model`/`Access`, inline `Mode`/`Effort`, `Workspace`, `Compact context`) | Matched | Includes queued-message inline strip (`Steer now`, `Edit`, `✕`), voice-tinted selection chip, and toggleable `build log` chip. |
| Agents | 3-column layout (`OrchestrationSidebar`, `AgentPanel`, `ProjectInspector`) | Matched | Includes `Last build` inset card, voice-dotted `Working changes`, dashed `Delegate a task…` + `Schedule…`, and colored `Usage & limits` bar. |
| History | 3-column layout (`Timeline/Commits/Labels`, full-bleed diff sheet, `Changes / Commit message / Label this version / Publish`) | Matched | Matches `Review.dc.html` with `Restore before this`, `Revert hunk N`, and `Add agent trailers for staged threads`. |
| History | `PDF` diff toggle next to `Split \| Inline` | Omitted (backend-limited) | Visual PDF-to-PDF diffing is not implemented in the Rust backend; omitted rather than rendering a non-functional stub. |
| Usage & limits | 34px Instrument Serif title, 4 ordered quota cards, `Tokens by harness and model`, 7-day chart, `Heaviest threads`, `Export CSV` | Matched | Unreported quotas render diagonal hatched meters (`— quota not reported`) and `Custom ACP` renders `Measured zero, not missing`; empty days stay empty rather than showing synthetic bars. |
| Nocturne | Dark 3-pane `Source \| Thread \| PDF` layout | Matched | All tokens flip cleanly under `:root.dark`; `LivePdfPreview` sits as a direct `<main>` sibling after the persistent `AgentPanel` so 2-pane and 3-pane modes never clip. |

## Verification Artifacts (Local, Untracked)

- `output/v1-verification/parity-home.png`
- `output/v1-verification/parity-write.png`
- `output/v1-verification/parity-build.png`
- `output/v1-verification/parity-dock.png`
- `output/v1-verification/parity-agents.png`
- `output/v1-verification/parity-history.png`
- `output/v1-verification/parity-usage.png`
- `output/v1-verification/parity-nocturne.png`
