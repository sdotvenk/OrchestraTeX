# OrchestraTeX design language

[Paper materials](paper.md) · [Studio materials](studio.md) · [Approved Design A archive](../design-a/README.md)

## One workspace, two materials

The project is the unit of navigation. The activity rail selects files, search, Git, threads or terminal. Use a persistent project identity, document tabs, source line numbers, a resizable output pane and a bottom status bar. Keep file creation, import and rename at the tree; engine, compile and PDF export at the preview; stage and commit at the diff. Give the manuscript its own white page and document-defined typography in either theme.

## A thread has two placements

| Placement | Use and visible context | Transition |
| --- | --- | --- |
| Beside the document | Edit source while steering one thread. Keep the tree and outline, selected source tab, compact tool results, queued input and permission request visible. In this study the right output slot shows chat in place of the PDF. | Open in tab promotes this thread. Restore the previous PDF page and zoom when the dock closes. |
| In a workspace tab | Give a long-running session room for its transcript, project thread list and a switchable project inspector. Keep the document tab accessible. | Dock beside editor returns this thread to the right of the last source file. Selecting the source tab returns focus to writing. |

Both placements use the same project and thread ID. Preserve drafts, attachments, stream position, queued messages, approvals, usage and file context. Moving a session must neither start another turn nor repeat a tool request. Retain cursor, selection and unsaved buffers. In a narrow window prefer the tab when docking would leave less than a readable code column. Expose both placement commands by keyboard and give focus to the destination header on transfer.

## Card anatomy and density

A consequential action shows provider, exact command, project context and labeled choices. Keep detailed arguments readable and wrap long commands. Example minimum heights for a single-line command are 96 px compact, 124 px standard and 172 px expanded, measured in logical desktop pixels. Use standard for ordinary permissions, compact for short requests under space pressure, and expanded for paths, explanations or multiline commands. Content sets the final height. A compact composer control opens session usage. The project rail opens cross-session usage and limits. Keep passive status in a row when it fits.

[Compact](../design-studies/theme-pair/permission-compact.png) · [Standard](../design-studies/theme-pair/permission-standard.png) · [Expanded](../design-studies/theme-pair/permission-expanded.png)

## Interaction and accessibility

Use visible labels for approval, destructive and delivery actions. Use color alongside text, signs or icons. Keep everyday file rows approximately 28–30 px high and icons 16–20 px with a larger target. Use clear keyboard focus on tabs, menus, pane controls and actionable cards. Preserve focus and scroll when external edits or streamed messages arrive. Honor reduced motion. Validate contrast, scaling, dark appearance, keyboard use and native install paths on each desktop OS before adopting the themes. The renders are light-mode design studies.

## Agent tab surfaces

Start with a compact project inspector showing the local checkout, project scripts, branch and upstream, change counts, Git actions, main document, latest build and thread lineage. Opening a diff, file, PDF, terminal or build log uses the adjacent pane. Keep the transcript, thread selection and draft in place. Project scripts and lineage are proposed integrations. Commit & push opens a change review and explicit action.

## Usage across harnesses

Group usage by harness, account, model and time range, with a project filter. Normalize input to include cache reads exactly once according to each adapter’s accounting. Calculate cache share as total cached-read tokens divided by matching total input tokens. Label partial reporting coverage. Show request-level hit rate only when a harness reports cache hits and eligible requests. Keep cache creation/write tokens separate when available. Reasoning tokens may be included in output; avoid summing overlapping categories. Deduplicate repeated or cumulative usage events.

Show quota windows at their reported scope (account, provider or model pool), with remaining capacity, reset and last refresh. Distinguish missing, stale and measured-zero values. Never infer an account-wide allowance from locally observed token counts. The study uses illustrative data and proposed local history.

[Paper project inspector](../design-studies/project-materials/paper.png) · [Studio working diff](../design-studies/project-inspector/studio-diff.png) · [Usage across harnesses](../design-studies/project-inspector/paper-usage.png)

The preferred agent-tab study combines the project inspector layout with the original Paper and Studio materials. Group checkout actions, Git state and the latest build in separate inset surfaces. Use one shared tool-result surface in the transcript and keep lineage compact. [Paper](../design-studies/project-materials/paper.png) · [Studio](../design-studies/project-materials/studio.png)

## Live conversation

Give user turns, agent prose and streamed activity a single reading column. Use speaker labels, spacing and a fine trace guide. Append provider-exposed activity in place and let readers fold the trace into one summary. Follow new output while the reader is at the end; scrolling back preserves their place. Keep elevation for the surrounding tools and actionable interruptions. The [palette and trace study](../design-studies/studio-palette/index.html) pairs this transcript with the project inspector.
