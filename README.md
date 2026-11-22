<div align="center">

# OrchestraTeX

**Local-First Multi-Provider AI Agent & Overleaf-Grade Live LaTeX Workspace**

*A standalone overhaul originating from [LMMs-Lab Writer](https://github.com/EvolvingLMMs-Lab/lmms-lab-writer) — preserving the original upstream README verbatim in [README_ORIGINAL.md](README_ORIGINAL.md).*

[![License: MIT](https://img.shields.io/badge/License-MIT-f0c000?style=flat-square)](LICENSE)
[![macOS](https://img.shields.io/badge/-macOS-111111?style=flat-square&logo=apple&logoColor=white)](#cross-platform-packaging)
[![Windows](https://img.shields.io/badge/-Windows-0078D4?style=flat-square&logo=windows11&logoColor=white)](#cross-platform-packaging)
[![Tauri](https://img.shields.io/badge/Tauri-v2-24C8D8?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D24-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Rust](https://img.shields.io/badge/Rust-2021-DEA584?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)

English | [Original README](README_ORIGINAL.md) | [Developer Guide](docs/dev.md) | [中文](README_zh.md) | [日本語](README_ja.md)

</div>

---

## What Changed in OrchestraTeX (vs. Original LMMs-Lab Writer)

OrchestraTeX is a major standalone overhaul of [LMMs-Lab Writer](https://github.com/EvolvingLMMs-Lab/lmms-lab-writer) that replaces the legacy embedded OpenCode daemon with a **direct multi-provider CLI/protocol runtime**, introduces an **Overleaf-grade live LaTeX authoring & PDF preview pipeline**, refactors the **performance architecture**, and cleans up **cross-platform packaging** — while preserving the retro-terminal monochrome + orange aesthetic and local-first Git/terminal capabilities.

| Area | Original LMMs-Lab Writer | OrchestraTeX |
| --- | --- | --- |
| **Agent Backend** | Embedded `opencode serve` daemon on `localhost:4096` (HTTP + SSE) | **Direct TOS-compliant native CLI/protocol bridges** in Rust: **Claude Code** (`stream-json` stdio), **OpenAI Codex** (`codex app-server --stdio` JSON-RPC 2.0), **Antigravity** (`agy acp --stdio` ACP), and **Custom ACP** binaries |
| **Chat & Thread UX** | Single OpenCode session pane | **Full T3Code-style workspace**: persistent per-project threads (pin, rename, search, filter, fork, delete), model & reasoning effort selectors, **Default / Plan** interaction modes, **Ask / Auto-Edit / Full Access** permission policies, `/` slash commands, `@` file mentions, image paste/drop/lightbox, message queueing with **Steer / Edit / Remove**, and one-click terminal login |
| **Interactive Agent Cards** | OpenCode question wizard only | **Question Cards** (single/multi-select, custom "Other", secret masking, keyboard `1-9`/`Enter`/`Esc`), **Tool/Command Approval Cards** (Allow Once / Allow Session / Deny), and **Plan Approval Cards** (`ExitPlanMode` approve or request revisions) |
| **Usage & Quotas** | Basic session info | **Usage & Rate Limits Popover**: live context window meter, input/output/cache/reasoning token breakdown, per-model cost USD, provider rate-limit quota windows with reset countdowns, **Compact**, and **Refresh** |
| **LaTeX Live Preview** | Manual compile + `convertFileSrc` PDF reload (flashes blank, loses scroll) | **Overleaf-grade live preview**: debounced auto-compile on editor/split-pane/AI edits, zero-cache binary IPC PDF reload (`read_file_bytes`) without remounting `<Document>`, preserved scroll/zoom, Fit Width/Page, page jump, PDF export, and **Tectonic** support alongside `latexmk`/`pdflatex`/`xelatex`/`lualatex` |
| **Diagnostics & Authoring** | Raw terminal/log inspection | Collapsible **Issues / Raw Log** drawer with jump-to-line and **"Fix with AI"**, inline Monaco error/warning markers, bidirectional **SyncTeX** (forward highlight + inverse click), dynamic `\cite{}` (BibTeX) & `\ref{}` completion, `Cmd/Ctrl+B` / `Cmd/Ctrl+I` / `Cmd/Ctrl+Enter` shortcuts, **"Ask Agent about Selection"**, sidebar **Outline** tab, external **File Upload**, and bottom status bar with live **body word count** |
| **Performance** | Monolithic `useTauriDaemon` IPC + per-event React updates | Domain-split hooks (`useAgent`, `useLatexCompiler`, `useTauriDaemon`), `requestAnimationFrame` delta/log batching, `React.memo` isolation with stabilized callbacks, in-memory cached `ThreadStore` with zero-disk streaming deltas, non-blocking ACP terminal wait/kill, and generation-scoped compile cancellation |
| **macOS / Windows Packaging** | Hardcoded macOS `10.15` (Catalina) checks in `tauri.conf.json` & `build-pkg.sh` | Removed hardcoded OS version gates (`minimumSystemVersion` & `<volume-check>`); Windows `.cmd`/`.exe` resolution and `CREATE_NO_WINDOW` process handling |

---

## Agent Runtime Architecture

Instead of bundling or proxying through an OpenCode daemon, the Rust backend (`apps/desktop/src-tauri/src/commands/agent/`) communicates directly over stdin/stdout with locally installed, user-authenticated CLIs so your own subscriptions, logins, and usage limits apply natively:

1. **Claude Code (`claude.rs`)** — `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio --forward-subagent-text`
   - Supports live model & permission mode switching, multi-step streaming with isolated block IDs, slash commands, `AskUserQuestion` cards, `ExitPlanMode` plan approvals, tool approvals, per-model cost/context tracking, `rate_limit_event` windows, thread forking, and `/compact`.
2. **OpenAI Codex (`codex.rs`)** — persistent `codex app-server --stdio` JSON-RPC 2.0 daemon
   - Supports `model/list`, reasoning effort selection, `thread/{start,resume,fork,compact/start}`, `turn/{start,steer,interrupt}`, `item/tool/requestUserInput` cards, command/file approval cards, token/context usage, and live `account/rateLimits/read` quota windows.
3. **Antigravity & Custom ACP (`acp.rs`)** — `agy acp --stdio` (or any custom ACP stdio server configured in **Settings → Agents**)
   - Supports ACP `initialize`, `session/{new,load,prompt,cancel,set_mode,set_model,set_config_option}`, `session/update` streaming, `session/request_permission` approval cards, `usage_update` context tracking, and project-scoped `fs/*` and `terminal/*` client handlers.

## Overleaf-Style Live LaTeX Workspace

- **Live Auto-Compile**: Debounced recompilation after edits in primary or split editors and after external/AI file modifications, with generation-tracked cancellation of superseded builds.
- **Flicker-Free PDF Preview**: Reads compiled PDFs directly over binary Tauri IPC (`read_file_bytes`), preserving zoom level and scroll position across rapid rebuilds.
- **Bidirectional SyncTeX**: Jump from source line to highlighted PDF location (`Sync -> PDF` or Monaco context menu) and double-click or `Cmd/Ctrl+Click` in the PDF to jump back to source.
- **Authoring Tools**: Collapsible **Issues / Raw Log** drawer with one-click **Fix with AI**, inline Monaco diagnostics, dynamic `\cite{}` and `\ref{}` completion, document **Outline** sidebar, external file import/upload, PDF export, aux-file cleanup, and live body word count.

## Cross-Platform Packaging

- **macOS (Apple Silicon & Intel)**: Removed hardcoded Catalina (`10.15`) checks from `apps/desktop/src-tauri/tauri.conf.json` and `scripts/build-pkg.sh`.
- **Windows (64-bit)**: Resolves `.exe`/`.cmd`/`.bat` CLI wrappers automatically and hides console windows via `CREATE_NO_WINDOW`.

## Quick Start

```bash
git clone https://github.com/sdotvenk/OrchestraTeX.git
cd OrchestraTeX
pnpm install
pnpm tauri:dev
```

1. **Authenticate your preferred local CLI(s)** (or click **Sign in in Terminal** directly from the Agent panel):
   - Claude Code: `claude auth login`
   - OpenAI Codex: `codex login`
   - Antigravity (ACP): `agy acp --login`
2. **Install a TeX compiler** (if not already present): use the in-app installer for **TinyTeX**, **Tectonic**, **BasicTeX/MacTeX**, **MiKTeX**, or **TeX Live**.
3. **Open a LaTeX folder** and press `Cmd/Ctrl+P` for Live PDF Preview, `Cmd/Ctrl+L` for the Agent panel, and `Cmd/Ctrl+Enter` (or `Cmd/Ctrl+Shift+B`) to compile.

See **[docs/dev.md](docs/dev.md)** for full architecture, Rust IPC command reference, performance notes, and verification commands.

---

## Original Project Overview

> The sections below preserve the original upstream LMMs-Lab Writer README for full context and attribution. The complete verbatim original file is also archived at **[README_ORIGINAL.md](README_ORIGINAL.md)**.

[![](imgs/demo.webp)](https://youtu.be/rX0FdCEqw0s?si=dXxYfSUVPemeBAOs)

### Why LMMs-Lab Writer?

As a researcher, your time belongs to breakthroughs—not wrestling with LaTeX boilerplate, resolving package conflicts, or the endless copy-paste loop between Overleaf and ChatGPT.

LMMs-Lab Writer is a **local-first, AI-native** LaTeX editor. Your files remain secure on your machine. AI agents assist with editing directly. Compile, review, and publish—all within a single, unified environment.

### One-Click LaTeX Setup

Say goodbye to hour-long TeX Live installations. LMMs-Lab Writer **automatically detects and installs a lightweight LaTeX distribution**. If a package is missing, it's installed on the fly during compilation. Zero manual configuration required—just open the app and start writing.

Supports **TinyTeX**, **Tectonic**, **MiKTeX**, **MacTeX**, and **TeX Live**—with streamlined, one-click management.

<div align="center">
<img src="imgs/latex.png" alt="One-click LaTeX setup with auto package installation" width="720">
</div>

### Built for Every Language

Write effortlessly in **English, Chinese, Japanese, Korean, Arabic, or any other language**. XeLaTeX and LuaLaTeX are supported out of the box with full Unicode and system font compatibility. CJK documents work instantly with `ctex`, `xeCJK`, and other multilingual packages—no extra setup needed.

<div align="center">
<img src="imgs/compile-cn.png" alt="Full CJK and Unicode support with XeLaTeX">
</div>

### Git Integration for Modern Collaboration

Git isn't just an add-on; it's **deeply integrated into the sidebar**:

- **Stage, commit, diff, push, pull**—entirely via the UI
- **AI-generated commit messages** based on your staged changes (now powered by `agent_one_shot_prompt` via your configured local agent CLI)
- **Side-by-side diff viewer** for reviewing AI suggestions before committing
- **One-click GitHub publishing**—create and push repositories without touching the terminal
- **Seamless GitHub CLI integration** for effortless authentication

<div align="center">
<img src="imgs/git-support.png" alt="Git integration — stage, commit, diff, push from the sidebar" width="720">
</div>

### Fully Open Source & Local-First

MIT licensed. No vendor lock-in, no telemetry, no hidden costs.

- Your files **never leave your local machine**
- AI agents run via your own local CLI logins / API keys
- Fully functional **offline** (editing, compilation, Git)

<div align="center">
<table>
<tr>
<td align="center"><strong>Light Mode</strong></td>
<td align="center"><strong>Dark Mode</strong></td>
</tr>
<tr>
<td><img src="imgs/light.png" alt="Light mode"></td>
<td><img src="imgs/dark.png" alt="Dark mode"></td>
</tr>
</table>
</div>

### License

MIT — Original project built by **[LMMs-Lab](https://lmms-lab.com)**.
