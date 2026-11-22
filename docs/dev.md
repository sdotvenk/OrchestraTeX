# Developer Guide

Technical documentation for **LMMs-Lab Writer** (modified local-first multi-provider agent & OverLeaf-grade LaTeX workspace).

## Architecture Overview

LMMs-Lab Writer is a `pnpm` + Turbo monorepo containing a Tauri v2 desktop app, Next.js website, and shared packages.

```
lmms-lab-writer/
├── apps/
│   ├── desktop/                     # Tauri v2 desktop app
│   │   ├── src/                     # Next.js 16 frontend (React 19, static export)
│   │   │   ├── app/page.tsx         # Main workspace layout (Editor + Live PDF + Agent + Terminal)
│   │   │   ├── components/
│   │   │   │   ├── agent/           # Multi-provider T3Code-style agent chat, cards, usage/limits
│   │   │   │   ├── editor/          # Monaco editor, LivePdfPreview, PdfViewer, Outline, FileTree, Git, Terminal
│   │   │   │   ├── latex/           # Settings dialog (Build/Editor/Agents/Account), compiler/synctex setup
│   │   │   │   └── ui/              # Tabs, dialogs, toast, scroll
│   │   │   └── lib/
│   │   │       ├── agent/           # useAgent hook, rAF delta reducer, provider & thread settings
│   │   │       ├── latex/           # useLatexCompiler, useLatexSettings, outline, word count, BibTeX parser
│   │   │       ├── monaco/          # LaTeX language tokens, snippets, theme definitions
│   │   │       └── tauri/           # useTauriDaemon (filesystem, watcher, Git, GitHub CLI)
│   │   └── src-tauri/               # Rust backend
│   │       ├── src/commands/
│   │       │   ├── agent/           # Native CLI/protocol bridges (Claude stream-json, Codex app-server, ACP)
│   │       │   ├── fs.rs            # File operations, binary reads, external imports, watcher
│   │       │   ├── git.rs           # Git + GitHub CLI operations
│   │       │   ├── latex.rs         # Local compilation (latexmk/pdflatex/xelatex/lualatex/tectonic) + SyncTeX
│   │       │   ├── terminal.rs      # PTY spawn, write, resize, kill
│   │       │   ├── auth.rs          # OAuth callback server
│   │       │   └── util.rs          # Windows CREATE_NO_WINDOW helper
│   │       ├── capabilities/default.json
│   │       └── tauri.conf.json
│   └── web/                         # Marketing website (Next.js)
├── packages/shared/                 # Shared TypeScript types & utilities
└── docs/
    ├── dev.md                       # This file
    └── DESIGN.md                    # Design system (retro-terminal monochrome + orange)
```

---

## Architectural Decisions & Performance Overrides

In updating LMMs-Lab Writer to replace the legacy embedded OpenCode daemon with a direct multi-provider CLI runtime and OverLeaf-style live PDF workspace, several architectural choices intentionally supersede guidelines from the original `docs/dev.md`:

1. **Domain-Split IPC Hooks Instead of Monolithic `useTauriDaemon`**:
   - *Original guideline*: Route every IPC call through `useTauriDaemon`.
   - *Why overridden*: High-frequency streaming tokens (`agent-event`), compilation stdout lines (`latex-compile-output`), and local thread state would force full-tree re-renders across the file tree, git status, and Monaco editor on every frame.
   - *How implemented*: Workspace filesystem/Git remains in `useTauriDaemon`, while agent streaming lives in `useAgent` ([apps/desktop/src/lib/agent/use-agent.ts](../apps/desktop/src/lib/agent/use-agent.ts)) and LaTeX build state lives in `useLatexCompiler` ([apps/desktop/src/lib/latex/use-latex-compiler.ts](../apps/desktop/src/lib/latex/use-latex-compiler.ts)).

2. **Dual-Layer Streaming Throttling + `React.memo` Isolation**:
   - *Original guideline*: Throttle high-frequency backend IPC events only.
   - *How implemented*: Agent `partDelta` chunks and `latex-compile-output` log lines are buffered in refs and flushed once per browser animation frame (`requestAnimationFrame`), paired with `React.memo` on `MessageTimeline`, `AssistantMessageItem`, `MarkdownText`, `ToolDisplay`, `LivePdfPreview`, `PdfViewer`, `MonacoEditor`, and `SidebarOutlinePanel`. All callbacks crossed into memoized boundaries are stabilized via `useCallback`, `MarkdownText` hoists remark/rehype plugin arrays and memoizes custom renderers, and `useAgent` probes CLIs only when `settings.customProviders` changes (debounced 500ms) rather than on every model/mode toggle.

3. **In-Memory Cached `ThreadStore` With Zero-Disk Streaming Deltas**:
   - *How implemented*: `ThreadStore` ([store.rs](../apps/desktop/src-tauri/src/commands/agent/store.rs)) caches per-project threads in memory and exposes `mutate_thread_memory` for high-frequency `PartDelta` updates (Claude, Codex, and ACP) with zero disk I/O during streaming, flushing compact JSON atomically on item/turn completion, interaction transitions, and thread lifecycle mutations. ACP terminal handlers use exclusive child ownership (`tokio::select!` with `oneshot` kill + `watch` exit channels) and spawn `terminal/wait_for_exit` off the JSON-RPC stdout reader so long-running commands never stall the stream or deadlock `terminal/kill`.

4. **Zero-Cache Binary IPC PDF Reload Without Remounting `<Document>`**:
   - *Original design*: Load PDFs via `convertFileSrc(path)` URLs and bump `key={refreshKey}` on `<Document>`.
   - *Why overridden*: `convertFileSrc` suffers from asset/WebView cache staleness after rapid recompiles, and changing `key={refreshKey}` tears down pdf.js, flashing blank and resetting zoom and scroll position.
   - *How implemented*: `LivePdfPreview` reads freshly written PDF bytes via `read_file_bytes` (`tauri::ipc::Response`), passes a fresh cloned `Uint8Array` copy to a persistently mounted `<Document>`, and restores `scrollTop` after `onLoadSuccess`. `latex_compile` tracks `(generation, Child)` ownership so cancelled older compiles cannot steal a newer compile's process handle, and Monaco uses a singleton `\cite{}`/`\ref{}` completion provider to prevent duplicate suggestions in split panes.

5. **Direct CLI Protocol Adapters Instead of Embedded Daemon Server**:
   - *Original design*: Spawn `opencode serve` on localhost port 4096 and communicate over HTTP + SSE.
   - *How implemented*: Rust backend speaks directly over stdin/stdout to official TOS-compliant agent transports:
     - **Claude Code**: `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio --forward-subagent-text` (live session controls, step-isolated multi-turn block IDs, `AskUserQuestion` cards, `ExitPlanMode` approvals, tool approvals, model cost & rate-limit snapshots).
     - **OpenAI Codex**: Persistent `codex app-server --stdio` JSON-RPC 2.0 daemon (multi-thread, turn steer/interrupt/fork/compact, `requestUserInput` cards, command/file approvals, token usage & rate-limit windows).
     - **Antigravity & Custom ACP**: `agy acp --stdio` (or custom ACP binary) over JSON-RPC 2.0 ACP (models, modes, usage updates, permission cards, bounded async `fs/*` & `terminal/*` client handlers).

6. **macOS Version-Agnostic Packaging**:
   - Removed the hardcoded `"minimumSystemVersion": "10.15"` from [tauri.conf.json](../apps/desktop/src-tauri/tauri.conf.json) and `<volume-check>` OS version gating from [scripts/build-pkg.sh](../scripts/build-pkg.sh).

---

## Rust Command Modules

### `commands/agent/` (13 commands)

| Command | Purpose |
| --- | --- |
| `agent_list_providers` | Detect `claude`, `codex`, `agy`, and Custom ACP availability, auth, models, commands |
| `agent_refresh_rate_limits` | Refresh provider quota/rate-limit windows |
| `agent_list_threads` | List persisted threads for a project |
| `agent_load_thread` | Load thread transcript, usage snapshot, tasks, and pending interaction |
| `agent_create_thread` | Create a new thread with provider/model/effort/interaction/runtime modes |
| `agent_update_thread` | Update title, pin/archive state, provider, model, effort, or modes |
| `agent_delete_thread` | Terminate any active session process and delete persisted thread |
| `agent_fork_thread` | Fork an existing thread (native fork on Codex/Claude, snapshot copy on ACP) |
| `agent_send_message` | Send prompt + image attachments to the selected provider |
| `agent_steer_turn` | Steer a running turn (`Codex` native steer / `Claude` stdin message) |
| `agent_interrupt_turn` | Cancel active generation cleanly |
| `agent_compact_thread` | Trigger context compaction |
| `agent_respond_interaction` | Submit answers to Question cards, Approval cards, or Plan Approval cards |
| `agent_one_shot_prompt` | Single-shot non-interactive prompt (used for AI Git commit messages) |
| `agent_shutdown_all` | Cleanly terminate all child CLI processes on app exit |

Event stream: `agent-event` (`threadUpdated`, `messageAdded`, `partUpdated`, `partDelta`, `turnStatus`, `tokenUsageUpdated`, `rateLimitsUpdated`, `planUpdated`, `interactionRequested`, `interactionResolved`, `commandsUpdated`, `providerLog`).

### `commands/fs.rs` (13 commands)
Includes `set_project_path`, `read_file`, `write_file`, `read_file_bytes` (raw binary `tauri::ipc::Response`), `copy_file_to_path`, `import_external_file`, `get_file_tree`, `watch_directory`, `stop_watch`, `create_file`, `create_directory`, `rename_path`, `delete_path`. All project paths are canonicalized against project root (`validate_path_within_project`).

### `commands/latex.rs` (10 commands)
- `latex_detect_compilers`: detects `pdflatex`, `xelatex`, `lualatex`, `latexmk`, and `tectonic`.
- `latex_compile`: generation-tracked cancellation, subdirectory main `.tex` resolution, `-synctex=1` + `-interaction=nonstopmode` + `-file-line-error`, real-time `latex-compile-output` stream, and structured `LatexDiagnostic[]` (`errors`, `warnings`, `duration_ms`).
- `latex_synctex_view` & `latex_synctex_edit`: bidirectional source <-> PDF SyncTeX navigation.
- `latex_stop_compilation`, `latex_clean_aux_files`, `latex_detect_main_file`, `latex_install`, `latex_get_distributions` (including TinyTeX and Tectonic), `latex_open_download_page`, `latex_install_synctex`.

---

## Development & Verification Commands

```bash
# Development
pnpm tauri:dev                              # Desktop app with hot reload
pnpm --filter @lmms-lab/writer-web dev      # Marketing website

# Build & Typecheck
pnpm --filter @lmms-lab/writer-shared build
cd apps/desktop && pnpm tsc --noEmit
cd apps/desktop && pnpm test
pnpm --filter @lmms-lab/writer-desktop build
cd apps/desktop/src-tauri && cargo check --all-targets && cargo test --lib

# Lint & Format
pnpm exec biome check .
pnpm lint:fix
pnpm format
```

## Conventions

- **TypeScript**: `strict: true` + `noUncheckedIndexedAccess: true`; never use `as any` or `@ts-ignore`.
- **Biome**: Keep `biome.json` `recommended: true`. Always add explicit `type="button"`, `aria-hidden="true"` on decorative SVGs, stable React keys, and accessible control labels.
- **Design System**: Retro-terminal monochrome + accent design (`--background`, `--foreground`, `--border`, `--surface-secondary`, `--accent-dark`). **Zero rounded corners** (`rounded-none` / sharp borders).
- **Async Rust**: Never call blocking `std::fs`, `std::thread::sleep`, or `std::process::Command` directly inside `async fn`; always use `tokio::fs`, `tokio::time::sleep`, and `tokio::process::Command`.
