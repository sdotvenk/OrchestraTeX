# OrchestraTeX — Design System

## Design Philosophy

**Calm, exact, research-first.** Inspired by the tactile precision of Silkscreen and classic academic typesetting: warm paper chrome (`--bg`), crisp white inset workspace frames (`--panel`), hairline borders instead of heavy chrome, sentence-case UI typography (`IBM Plex Sans`), and monospace (`IBM Plex Mono`) strictly for LaTeX source, identifiers, file paths, and tabular metrics.

---

## Tokenized Base & Built-In Palettes

All components consume semantic CSS variables defined in `apps/desktop/src/app/globals.css`. Three cohesive palettes share the exact same token contract (each with Light and Dark variants via `data-palette` + `.dark`):

| Palette | Light Chrome (`--bg`) | Structural Accent (`--accent`) | Primary CTA (`--primary-bg`) | Character |
| --- | --- | --- | --- | --- |
| **Atelier** (default) | `#f6f5f0` Warm Cotton | `#2c4f7c` Prussian Ink | `#d14e2a` Vermilion | Letterpress / fine academic typesetting |
| **Conductor** | `#f3f5f8` Cool Alabaster | `#3652b8` Cobalt Slate | `#c48b28` Warm Brass | Crisp daylight studio instrument |
| **Monograph** | `#f7f4f0` Warm Linen | `#6e3450` Oxblood Plum | `#256b60` Deep Teal | Quiet monograph & archival study |

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
