# Changelog

All notable changes to Lester are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.3] — 2026-11-14

GitHub web-upload reliability and documentation-link fixes; no functional changes.

### Fixed

- **README CI badge never rendered** after a GitHub web upload: the badge pointed
  at the CI workflow, but GitHub's web uploader drops dotfiles (`.github/` never
  reached the repository), leaving a broken badge image. The dynamic badge is
  removed; CI status is visible natively in the repository's Actions tab (and
  sidebar) once the workflows are uploaded.
- Stale documentation links left over from the v1.0.2 consolidation:
  `DEPLOY.md` → `docs/guide.md` (docker-compose files, SECURITY.md, install.sh,
  marketing site), `docs/SECURITY.md` → `docs/security-model.md`, and a
  `cd lester-v1.0.1` typo in docs/guide.md.
- SECURITY.md and CONTRIBUTING.md no longer link to repository files that were
  removed (see below); the guidance now lives inline in those documents.

### Changed

- **93 committed files (down from 95)** — the GitHub issue and PR templates were
  removed so the repository stays comfortably below GitHub's 100-file web-upload
  limit. Tests, docs, commands and behavior are unchanged.
- `.env.example` renamed to `env.example`: files starting with a dot are hidden
  by default in file managers and were being dropped by the web upload. Same
  contents, same copy-to-`.env` workflow.
- The release package no longer contains `db/.gitkeep` (the data directory is
  created at runtime); `THIRD_PARTY_LICENSES.md` and `SHA256SUMS` are still
  generated into the package at build time.

[1.0.3]: https://github.com/sufirumii/lester/releases/tag/v1.0.3

## [1.0.2] — 2026-11-14

Repository consolidated into fewer files; no functional changes.

### Changed

- **The whole repository now ships 95 committed files** (down from 227), so it
  can be uploaded to GitHub in a single web drag-and-drop. Every URL, command,
  screen, test and security property is unchanged — verified by diffing API
  response snapshots, route tables, Proof cross-verification and the full
  65-test suite against v1.0.1 before and after.
- API routes merged into one optional catch-all route with an internal
  method+path router (`src/app/api/[[...route]]` + `handlers.ts`).
- Console UI merged: one `ui.tsx` (the shadcn primitives in use) and seven
  screen modules; `src/lib` merged into fourteen cohesive modules.
- Operational scripts merged into `scripts/cli.ts` subcommands (same
  `bun run …` names and arguments).
- Docs merged into four guides under `docs/`; the deploy guide, architecture
  and design-decision log now live there; the code of conduct lives in
  CONTRIBUTING.md. THIRD_PARTY_LICENSES.md is generated at package time.
- Playwright config moved to `tests/` (run with
  `bunx playwright test --config tests/playwright.config.ts`).

### Fixed

- Latent path bug in the Playwright webServer helper that prevented the app
  server from booting (`tests/e2e/server.ts` now uses an absolute path) and
  the fake-engine helper merged into the same file with an `--engine-only` mode.

[1.0.2]: https://github.com/sufirumii/lester/releases/tag/v1.0.2

## [1.0.1] — 2026-11-14

Release-hardening: data-durability, security and honesty fixes over 1.0.0.
Every change below is covered by the test suite (`bun run test`); the summary
itself follows the project's honest-claims policy — nothing is listed that
isn't demonstrated by a test or a measured, reproducible procedure.

### Fixed

- **Upgrades no longer risk data loss.** Real Prisma SQL migrations ship in
  `prisma/migrations/` and are applied by `bun run migrate`, which takes an
  automatic pre-upgrade backup first — `db push --accept-data-loss` is gone
  from the upgrade path entirely.
- **Role matrix tightened and IDOR gaps closed.** Role enforcement is
  server-side on every route (auditors get Proof/Health only; members cannot
  touch policy, users or settings), and object access is scoped to the owning
  user/workspace.
- **Hardware detection is cross-platform.** CPU/RAM/GPU/disk probes now run
  via `execFile` instead of shell one-liners, so the first-run scan works the
  same on Windows, macOS and Linux.
- **Type errors eliminated.** `bunx tsc --noEmit` is clean, and the build runs
  with `ignoreBuildErrors: false`.

### Security

- **Hashed API tokens** for the OpenAI-compatible endpoint: only SHA-256
  hashes are stored; multiple tokens per user, revocation, and the raw token
  is shown exactly once at creation.
- **Persisted progressive login throttling** (username + IP keyed, escalating
  delays, survives restarts) with a fail-safe `bun run admin:recover` CLI.
- **Middleware hardening**: CSRF Origin checks, Content-Security-Policy and
  security headers, Secure cookie flag behind TLS/trusted proxy.
- **SSRF guard** for engine/provider URLs — DNS-resolved IP classification,
  metadata/link-local space blocked — plus egress enforcement at connect time
  so recorded endpoint classes are measured, not assumed.
- **Proof hash v2**: sequence number and timestamp are now covered by the
  chain hash; periodic signed checkpoints; verified v1 chains are migrated to
  v2 (rehash) on upgrade.
- **Backups hardening**: snapshots via SQLite `VACUUM INTO` with integrity
  checks; restore refuses checksum mismatches and takes a pre-restore
  snapshot before touching anything.
- **Vendor-pinned license keys**: production builds verify licenses against
  the vendor public key pinned in source, so license keys cannot be forged on
  a stock build.
- **Safe markdown rendering** in the Console chat (hardened allow-list
  renderer — no raw HTML or script injection).
- **Document upload hardening**: strict type/size checks and safe parsing on
  knowledge ingestion.
- **Zod validation on all API routes** — request bodies and query parameters
  are schema-validated before any handler logic runs.

### Changed

- **The builtin engine is gone.** Lester now ships first-class local adapters
  — Ollama, llama.cpp, LM Studio, vLLM, or any OpenAI-compatible endpoint —
  with auto-detection at boot (`LESTER_ENGINE=auto` probes the common ports).
- **Single binding variables** `LESTER_BIND` / `LESTER_PORT`; the server binds
  to loopback only by default — LAN exposure is an explicit operator action.
- **Docker is zero-edit**: `docker compose up -d` works as-is,
  `--profile with-ollama` adds a local engine sidecar; images are
  digest-pinned, containers run non-root, and services have healthchecks.
- `reactStrictMode` is on — what it reveals gets fixed, not hidden.
- The marketing site self-hosts its fonts — no third-party CDN requests.

### Added

- **Key export CLI** (`bun run keys:export`) with optional passphrase
  protection, for moving key material off the data disk.
- **Test suite grown to 65 tests**, including an end-to-end test that drives
  the OpenAI-compatible API with the real OpenAI SDK.

[1.0.1]: https://github.com/sufirumii/lester/releases/tag/v1.0.1
