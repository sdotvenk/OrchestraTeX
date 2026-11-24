# OrchestraTeX — Design System

## Design Philosophy

**Calm, exact, research-first.** Inspired by the tactile precision of Silkscreen and classic academic typesetting: warm paper chrome (`--bg`), crisp white inset workspace frames (`--panel`), hairline borders instead of heavy chrome, sentence-case UI typography (`IBM Plex Sans`), and monospace (`IBM Plex Mono`) strictly for LaTeX source, identifiers, file paths, and tabular metrics.

---

## Appearance

The top-bar theme picker offers Lux, Nocturne, and Auto. Auto is the default and follows the system appearance. Both themes use the semantic CSS tokens in `apps/desktop/src/app/globals.css`.

Theme preferences are stored as `lux`, `nocturne`, and `system`.

| Theme | Chrome (`--bg`) | Structural accent (`--accent`) | Primary action (`--primary-bg`) |
| --- | --- | --- | --- |
| **Lux** | `#ece7dc` | `#435670` | `#1b1f33` |
| **Nocturne** | `#14161f` | `#a3b3ca` | `#f2ede2` |

### Core Semantic Tokens

| Token | Role |
| --- | --- |
| `--bg` | App chrome background (top bar + left sidebar rail sit directly on it) |
| `--panel` | Inset frames, cards, popovers, composer |
| `--subtle` | Hover surfaces, search pills, user chat bubbles |
| `--sunken` | Segmented control tracks, code blocks, meter tracks |
| `--stage` | Calm drafting mat behind rendered PDF pages |
| `--line` / `--line-strong` | 1px hairline dividers and input borders |
| `--text` / `--text-strong` | Body prose and titles |
| `--muted` / `--faint` | Secondary labels, timestamps, placeholders |
| `--accent` / `--accent-soft` | Active tabs, links, SyncTeX highlights, focus rings, clickable file chips |
| `--primary-bg` / `--primary-text` | Single primary action per view (**Compile**, **Send**) |
| `--ok` / `--warn` / `--danger` | Semantic status pills with icons (never color alone) |

---

## Typography

```css
--font-family-sans: var(--font-plex-sans), "IBM Plex Sans", -apple-system, sans-serif;
--font-family-display: var(--font-display-serif), "Newsreader", Georgia, serif;
--font-family-mono: var(--font-plex-mono), "IBM Plex Mono", ui-monospace, monospace;
```

- **UI Chrome & Prose**: `IBM Plex Sans`, sentence case everywhere (avoid shouting uppercase).
- **Display**: `Newsreader` reserved sparingly for the Home greeting and focal brand moments.
- **Identifiers & Code**: `IBM Plex Mono` for LaTeX source, file paths, `\label`, `@cite`, line numbers, and `tabular-nums` stats.

---

## Shell & Component Rules

1. **Paper + Inset Frames**: Borderless 44px top bar and space-efficient Overleaf-style sidebar sit on `--bg`; Editor + Live PDF share one rounded white inset frame (`ox-frame`, `12px` radius), and the Agent pane sits in an adjacent inset frame.
2. **One Primary CTA per View**: Primary brand fill is reserved for **Compile** (workspace) and **Send** (composer).
3. **Agent Management**: Rail footer `Agents` status card opens a floating `Agent tools` popover (per-provider status, plan badge, thin color-coded rate-limit meters, refresh). The composer consolidates permission/mode/effort into a single left popover (`ChatModes`) and provider/model selection into a compact `ModelChip` beside the circular Send/Stop button.
4. **Live Streaming Thought Traces**: While reasoning streams, render a quiet muted live trace with an elapsed timer; auto-fold into a single expandable line (`Thought for Ns ›`) once the answer arrives.
5. **Connected Context**: Editor selections attach as removable context chips above the composer; inline file references render as clickable chips; `⌘K` opens the unified Command Palette across files, `\label`s, `@cite` entries, diagnostics, and actions.
