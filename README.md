<div align="center">

# OrchestraTeX

**Local-first LaTeX editor with Overleaf-style live preview and a multi-agent workspace**

[![License: MIT](https://img.shields.io/badge/License-MIT-f0c000?style=flat-square)](LICENSE)
[![macOS](https://img.shields.io/badge/-macOS-111111?style=flat-square&logo=apple&logoColor=white)](https://github.com/sdotvenk/OrchestraTeX/releases)
[![Windows](https://img.shields.io/badge/-Windows-0078D4?style=flat-square&logo=windows11&logoColor=white)](https://github.com/sdotvenk/OrchestraTeX/releases)
[![Linux](https://img.shields.io/badge/-Linux-333333?style=flat-square&logo=linux&logoColor=white)](https://github.com/sdotvenk/OrchestraTeX/releases)
[![Tauri](https://img.shields.io/badge/Tauri-v2-24C8D8?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D24-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Rust](https://img.shields.io/badge/Rust-2021-DEA584?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)

[Developer Guide](docs/dev.md) · [Design C](docs/design-c/README.md) · [Based on LMMs-Lab Writer](archive/lmms-lab-writer/README_ORIGINAL.md)

</div>

<div align="center">
<img src="docs/imgs/dock.png" alt="Source beside a docked Claude Code thread, with a command approval card" width="900">
</div>

---

Claude Code, OpenAI Codex, Antigravity and any ACP agent work on your paper like Overleaf collaborators. Their edits show up in the source with Keep and Undo, the PDF rebuilds as they work, and every turn lands in Git history. Everything runs on your machine through the CLIs you're already signed in to.

## Write with agents in the document

Agent edits are attributed in the gutter and can be kept or undone one at a time. The PDF shows when it's behind, and SyncTeX jumps in both directions. The Score drawer plots what each thread read, edited, compiled and waited on.

<div align="center">
<img src="docs/imgs/write.png" alt="Write view with source, live PDF and the Score drawer" width="900">
</div>

## Orchestrate threads across harnesses

Threads are grouped by project, with filters for running and waiting work. One Model · Effort chip opens the harness, model, effort, Build/Plan mode, access and workspace settings. Threads can delegate to other harnesses as child threads, and the inspector shows checkout, working changes, the last build and the delegation tree.

<div align="center">
<img src="docs/imgs/agents.png" alt="Agents workspace with thread list, transcript and project inspector" width="900">
</div>

## Build, diagnose, fix

Recompile and the engine menu live on the preview: latexmk, pdfLaTeX, XeLaTeX, LuaLaTeX and Tectonic. Problems link to the line and can be handed to an agent. Renaming a file offers to update its `\input` references.

<div align="center">
<img src="docs/imgs/build.png" alt="Engine menu and Problems drawer with Fix with Claude" width="900">
</div>

## History you can restore

Every agent turn is a checkpoint you can diff, restore or revert hunk by hunk. Stage and commit with an AI-written message and agent trailers, label versions, and push.

<div align="center">
<img src="docs/imgs/history.png" alt="History with checkpoint timeline, inline diff and commit panel" width="900">
</div>

## Usage across harnesses

Limit windows, tokens by harness and model, cache share and the heaviest threads. Quotas a provider doesn't report are shown as unknown, not zero.

<div align="center">
<img src="docs/imgs/usage-limits.png" alt="Usage and limits across Claude Code, Codex, Antigravity and Custom ACP" width="900">
</div>

## Set up in one place

Home lists recent projects with their thread state, detects or installs a LaTeX distribution (TinyTeX, Tectonic, BasicTeX, MacTeX, MiKTeX, TeX Live) and checks each agent CLI.

<div align="center">
<img src="docs/imgs/home.png" alt="Home with recent projects and machine setup" width="900">
</div>

## Lux and Nocturne

<div align="center">
<table>
<tr>
<td align="center"><strong>Lux</strong></td>
<td align="center"><strong>Nocturne</strong></td>
</tr>
<tr>
<td><img src="docs/imgs/write.png" alt="Lux theme"></td>
<td><img src="docs/imgs/nocturne.png" alt="Nocturne theme with three-pane source, thread and PDF"></td>
</tr>
</table>
</div>

Auto follows the system appearance. Wide windows can show source, thread and PDF side by side.

---

## Agent runtime

The Rust backend (`apps/desktop/src-tauri/src/commands/agent/`) talks to locally installed, signed-in CLIs over stdin/stdout, so your own subscriptions and limits apply.

1. **Claude Code (`claude.rs`)**: `claude -p --input-format stream-json --output-format stream-json …`. Live model and permission changes, streaming, slash commands, question, plan and tool approval cards, cost and context tracking, rate-limit windows, forking and `/compact`.
2. **OpenAI Codex (`codex.rs`)**: a persistent `codex app-server --stdio` JSON-RPC 2.0 process. Model list, reasoning effort, thread start/resume/fork/compact, turn steer and interrupt, input and approval cards, token usage and rate-limit windows.
3. **Antigravity and Custom ACP (`acp.rs`)**: `agy acp --stdio`, or any ACP stdio server set in **Settings → Agents**. Sessions, modes, models, streaming updates, permission requests, usage, and project-scoped `fs/*` and `terminal/*` handlers.

## Quick start

```bash
git clone https://github.com/sdotvenk/OrchestraTeX.git
cd OrchestraTeX
pnpm install
pnpm tauri:dev
```

1. Sign in to the CLIs you use, or use **Sign in in Terminal** in the agent panel:
   - Claude Code: `claude auth login`
   - OpenAI Codex: `codex login`
   - Antigravity: `agy acp --login`
2. Install a TeX engine from Home if none is detected. Tectonic is the smallest and fetches packages on demand.
3. Open a LaTeX folder. `Cmd/Ctrl+Enter` compiles, `Cmd/Ctrl+P` toggles the PDF, and `Cmd/Ctrl+L` opens the agent panel.

## Build from source

Installers are on the [Releases](https://github.com/sdotvenk/OrchestraTeX/releases) page. To build your own, use Node.js 24+, pnpm and stable Rust, plus:

- **macOS:** Xcode Command Line Tools (`xcode-select --install`)
- **Windows:** Visual Studio Build Tools with "Desktop development with C++", and WebView2 (included in Windows 11)
- **Linux:** `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf` (Debian/Ubuntu names)

```bash
pnpm install
pnpm tauri:build
```

The app and installers for your platform are written to `apps/desktop/src-tauri/target/release/bundle/`: `.app` and `.dmg` on macOS, `-setup.exe` and `.msi` on Windows, `.AppImage`, `.deb` and `.rpm` on Linux. Local builds are unsigned, so macOS asks you to right-click → Open the first time.

See **[docs/dev.md](docs/dev.md)** for architecture, the Rust IPC command reference and verification commands.

## License

MIT. See [LICENSE](LICENSE). OrchestraTeX is derived from [LMMs-Lab Writer](https://github.com/EvolvingLMMs-Lab/lmms-lab-writer) by LMMs-Lab; their original README is preserved in [archive/lmms-lab-writer/](archive/lmms-lab-writer/README_ORIGINAL.md).
