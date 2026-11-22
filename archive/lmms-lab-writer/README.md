# Archived LMMs-Lab Writer Upstream Assets

**OrchestraTeX** originated as a major overhaul of [LMMs-Lab Writer](https://github.com/EvolvingLMMs-Lab/lmms-lab-writer) (MIT License, by [LMMs-Lab](https://lmms-lab.com)).

Because OrchestraTeX is focused on a **local-first desktop workspace** (and will eventually adopt local-first remote control rather than the upstream hosted web portal), the upstream LMMs-Lab Writer-specific components, marketing assets, and cloud-auth code have been archived here verbatim for **attribution** and **reference** rather than deleted:

- **Upstream READMEs & media** (relative image paths preserved intact):
  - [`README_ORIGINAL.md`](README_ORIGINAL.md) — verbatim original upstream English README
  - [`README_zh.md`](README_zh.md) — original upstream Chinese README
  - [`README_ja.md`](README_ja.md) — original upstream Japanese README
  - [`imgs/`](imgs/) — original upstream logos and screenshots
- **Upstream web & video apps** (excluded from active `pnpm` workspace / Turbo / Biome runs):
  - [`apps/web/`](apps/web/) — LMMs-Lab Writer Next.js marketing site, Supabase portal, and download pages
  - [`apps/video/`](apps/video/) — Remotion marketing video project
- **Upstream marketing copy**:
  - [`docs/COPY-DAN-KOE.md`](docs/COPY-DAN-KOE.md) — upstream long-form marketing copy
- **Upstream release scripts**:
  - [`scripts/upload-to-blob.sh`](scripts/upload-to-blob.sh) — LMMs-Lab Vercel Blob upload helper
  - [`scripts/release.sh`](scripts/release.sh) — LMMs-Lab Homebrew tap release script
- **Upstream desktop cloud-auth & Supabase integration** (removed from active desktop build):
  - [`desktop-auth/components/auth/`](desktop-auth/components/auth/) — `LoginCodeModal`, `UserDropdown`, `DeepLinkHandler`
  - [`desktop-auth/lib/auth/`](desktop-auth/lib/auth/) — `useAuth` hook
  - [`desktop-auth/lib/supabase/`](desktop-auth/lib/supabase/) — Supabase browser client
  - [`desktop-auth/src-tauri/auth.rs`](desktop-auth/src-tauri/auth.rs) — Tauri localhost OAuth callback server
- **Unused upstream desktop wordmark SVGs**:
  - [`desktop-public/logo-light.svg`](desktop-public/logo-light.svg) & [`desktop-public/logo-dark.svg`](desktop-public/logo-dark.svg) — unreferenced upstream LMMs-Lab Writer logos removed from `apps/desktop/public/`
