# Design C user guide

## Projects and workspace

**Home** opens folders, creates a starter `main.tex`, and clones Git repositories. Recent projects show active thread counts and status. Home also shows detected LaTeX engines and agent CLI status.

Choose **Write** for source, a docked thread, and live PDF preview. Choose **Agents** for all project threads and the project inspector. Choose **History** for checkpoints, commits, and labels. Switch between light Score and dark Nocturne with the theme control.

Use **Cmd/Ctrl+K** to search threads in Agents or find a file in Write. **Cmd/Ctrl+L** toggles the docked thread, **Cmd/Ctrl+P** toggles the PDF preview, and **Cmd/Ctrl+Shift+B** recompiles.

## Source, Visual, and builds

- Switch an open `.tex` file between **Code** and **Visual** in the primary editor. Visual edits headings, paragraphs, simple lists, math source, and figure or table captions. Unsupported environments remain available as source blocks. Both modes use the same LaTeX file and autosave.
- Right-click selected lines in Code and choose **Ask Agent about Selection** to attach the source range to the composer. When an edit can be attributed to a thread, **Keep** dismisses review and **Undo** restores the previous text if the file still matches the edit.
- Open **Score** below the editor to see reads, edits, compiles, and approval waits from the last 15 minutes. Select a mark to open its file, thread, or build log. **Problems**, **Build log**, and **Terminal** share the drawer.
- Use the PDF toolbar to recompile or change engines and build options. Open a problem to jump to its source line or send it to an agent. A missing-file suggestion applies a replacement when its source is open and still matches. Otherwise it opens the diagnostic line.
- An inline **Retry save** action keeps unsaved text available if a write fails.

## Files and references

Use **F2** or the file context menu to rename a file, or drag an item to move it. **Set as Main File** is available for TeX files.

If the change affects braced `\input` or `\include` references, the tree shows three choices below the file name.

- **Update** renames the item and rewrites the references. A stale source file cancels the operation. A write failure triggers rollback.
- **Skip** renames the item and leaves the references as they are.
- **Cancel** closes the prompt. If an inline rename fails, press Enter from the name field to scan again. For a failed move, drag the item again to retry.

## Threads and worktrees

The composer’s model and effort control opens the provider, model, effort, mode, access, workspace, and context controls. Expand the project inspector to delegate a task to another provider or schedule a thread. Schedules run while OrchestraTeX is open.

Create a worktree from **Checkout** before a thread starts. The project must be open at its Git root and have an initial commit. Review and stage changes in **Diff**. **Commit & PR** uses an `origin` remote and an authenticated GitHub CLI. **Merge into project** requires clean checkouts and aborts if a conflict occurs.

## History and usage

- In **History**, choose a project or active thread checkout and select a checkpoint. Review a diff, revert an individual hunk, or restore the checkout. Restore creates a safety checkpoint and preserves the Git index. Labels are annotated Git tags shared across a repository’s worktrees.
- **Commits** stages changes and supports an agent-generated commit message. Checkpoints are local to the checkout. Automatic checkpoints surround ordinary agent turns in Git projects.
- **Usage** groups local measurements by date, project, provider, model, and thread. Export the filtered report to CSV. A dash means the provider left a metric unreported. Cache share uses reported cache and input tokens. Hit rate requires request-level counts.
