# Design A · OrchestraTeX

Approved visual direction for a local-first, multi-provider LaTeX IDE. These five desktop studies are the visual baseline. Each PNG is 2160 × 1350 and represents a 1440 × 900 logical viewport. The manuscript, activity, usage values and Git history are illustrative.

| Screen | Working task |
| --- | --- |
| [Writing and live PDF](screens/writing.png) | Navigate a nested project and the active file’s outline, edit tabbed source, compile, navigate or export the typeset PDF. |
| [Files and build diagnostics](screens/files-and-build.png) | Create and import from the tree header. Rename, duplicate, reveal, copy a path or open a terminal from the selected item. Follow a compiler issue to its line or bibliography. |
| [Agent orchestration](screens/agent-session.png) | Switch project threads, distinguish running and waiting providers, inspect tool actions, grant permission, steer a queued turn and inspect workspace edits and usage. |
| [Git and terminal](screens/git-and-terminal.png) | Inspect the working tree and index, compare source side by side, stage, commit, pull or push, and run commands at the project root. |
| [Toolchain setup](screens/latex-setup.png) | Detect a missing compiler, choose a distribution and main document, install, then detect again. The example shows macOS. Windows and Linux use platform-appropriate choices. |

## Workspace principles

- Treat the local project as the unit of work. File and folder operations, project-wide search, bibliography, assets, open tabs and unsaved buffers all need first-class surfaces. Keep common actions discoverable beside their targets.
- Anchor the window with an activity rail, project-aware toolbar and status bar. Give writing a resizable tree, source and PDF split. Preserve the active document, cursor and proof position when opening tools or recompiling.
- Put build controls on the proof, file controls on the tree, diagnostics in a resizable drawer and shell commands in the project terminal. Keep filename, line, compiler output and recovery action together.
- Give orchestration a dedicated workspace for persistent threads, providers, model and reasoning controls, queues, approvals and changed files. Identify the session, working directory and requested action wherever permission is involved. Show supported controls per provider.
- Let a single edit stay in writing context. A sustained reading pass may use more space. Reviewing suggestions is secondary to creating and building the document.
- Use Overleaf’s authoring workflows and T3Code’s orchestration workflows as capability targets. Preserve the Writer foundation in local files, Git, terminal and desktop integration. Verify parity separately from visual approval.

## Visual principles

- Use warm putty chrome (#E7E2D7), paper editing surfaces (#FAF9F5), white typeset pages and ink (#242521) for the rail, terminal and diagnostic drawer. Keep the manuscript visually distinct from its surrounding controls.
- Reserve signal orange (#FF6332) for the principal action and small location cues. Use sage (#D7E1D1) for additions and soft clay (#F1DCD1) for removals. Pair color with signs, icons or explicit state labels.
- Set controls and navigation in compact sentence-case sans, paths and source in mono, and the example manuscript in serif. The document’s own LaTeX typography governs the real PDF. The renders use Arial, Courier New and Georgia as stand-ins.
- Use the four-stroke Score mark at toolbar scale with the OrchestraTeX wordmark. Give branding more room at setup and project entry.
- Use solid surfaces, hairline dividers and modest 5–9 px corners for desktop controls and panels. Align rows across panes. Preserve dense, legible lists, visible selection and keyboard focus. Make icon controls accessible by name and keyboard.
- Design for resizing, light and dark palettes, reduced motion and all three desktop platforms. The approved images establish the light desktop treatment. Other sizes, themes and platforms require their own validation.
