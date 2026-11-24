# Design C · Score

Agents are voices. You conduct.

Canvas with all nine boards: https://claude.ai/artifact/461mLmjFXGvphdB8UkwTyy (private until shared)

Design C is a separate direction from Paper (Design A) and Studio (Design B). The layout follows Overleaf: a file tree, source, and a PDF with Recompile on it. T3Code-style orchestration is built into those surfaces. It does not live in a separate review mode.

## Principles

1. **Colour means who.** Each harness has one ink and a tint: Claude Code `#D9541A`, Codex `#2F5BD3`, Antigravity `#0E8597`, Custom ACP `#8E4CC4`, and you in ink `#1B1F33`. A harness's ink marks its thread, its gutter edits, its PDF changes, and its lane in the Score. States never borrow a voice colour. Waiting is amber with a lock glyph, and errors are red with a text label.
2. **Work happens in the document.** Agent edits appear in the source as a tinted range and gutter bar with the agent's name, like an Overleaf collaborator. Keep and Undo sit next to the change. The preview shows how many edits it is behind.
3. **The Score shows the ensemble.** The bottom drawer has one lane per active thread, plus one for you. Reads, edits, compiles, and waits are plotted over time, and clicking a mark opens the file or diff. Problems, the build log, and the terminal share the drawer.
4. **Chat flows, decisions stand.** The transcript is one reading column with a thin voice line, and tool activity hangs off that line as small marks. Only permission requests get a raised card: compact and amber, showing the exact command and cwd.
5. **Overleaf where it already works.** File operations sit beside the tree. Recompile and the engine menu live on the preview. SyncTeX jumps in both directions. History holds labelled versions.
6. **Depth from print.** A warm frame (`#ECE7DC`) holds inset sheets (`#FCFAF5`) with hairline rules (`#DCD4C4`). Each view has one primary action: solid ink with a 2 px offset tangerine shadow.

Type: Geist for the interface, Geist Mono for source, paths, and metrics, Instrument Serif for brand moments only. Source Serif stands in for the PDF in the mocks.

## Boards

| # | Board | Shows |
| --- | --- | --- |
| 0 | Visual language | Principles, stock and voice palettes, type, components |
| 1 | Write | Tree with voice dots, Threads in the sidebar, agent presence in source, stale-preview chip, Score drawer |
| 2 | Docked thread | Thread replaces the PDF slot, select lines and Ask Codex, inline permission, queued steer, composer chips |
| 3 | Agents workspace | T3-style orchestration plane (threads across projects, worktrees, cross-harness delegation, scheduled threads, PR status). Slim header and a compact composer: one Model · Effort chip that opens harness, mode, access, workspace and compact settings. Compact project inspector with an orchestration tree |
| 4 | History | Timeline of every turn by author, inline diff, restore, staged commit with AI message, labels |
| 5 | Files and build | Tree context menu, inline rename, drag to move, compile menu, error with suggested fix and Fix with Claude, Problems drawer |
| 6 | Usage | Per-harness limit windows, tokens by harness and model, cache share vs hit rate, unreported vs zero |
| 7 | Home and setup | Recent projects with thread state, LaTeX distribution install, agent CLI detection |
| 8 | Nocturne | Dark palette, three-pane source, thread, and PDF |

## Built vs proposed

Checked against `apps/desktop/src` and `src-tauri/src/commands` on 2026-11-23.

**Already built:** file tree operations (new, rename, duplicate, delete, copy path, reveal, open in terminal, drag-and-drop, import), Monaco with `\cite`/`\ref` completion, auto-compile with a delay, all five engines, shell escape, clean aux files, SyncTeX, binary PDF reload, Issues + raw log + Fix with AI. On the agent side: threads (search, pin, rename, fork), model, effort, Plan and permission selectors, Compact, queue + steer, approval, question and plan cards, `@` files, `/` commands, and images. Also the per-thread usage popover with rate-limit windows, Git with an AI commit message, GitHub publish, LaTeX install, and provider detection.

**Proposed by these mocks:**

- Agent presence ranges in the source (from streamed Edit tool input plus the file watcher), and per-edit Keep / Undo. `ChangesReviewPanel` exists but isn't wired into `page.tsx`.
- The Score drawer, built from tool-event timestamps.
- A Code / Visual toggle. There is no Visual editor yet, and it's required for Overleaf parity.
- A full T3Code-style orchestration plane: per-thread worktrees, delegation across harnesses into child threads, scheduled threads, PR status on threads, and ⌘K thread search.
- Select lines → Ask agent, with a line-range chip in the composer.
- The project inspector and sub-agent lineage.
- Per-turn checkpoints with restore, labels as Git tags, and hunk revert.
- Rename that updates `\input` references, a "did you mean" fix for missing files, and Set as main document from the tree.
- Cross-harness usage history, which needs a local usage log.
- Clone on Home, the Nocturne palette, and the three-pane wide layout.
