# API and architecture

The HTTP API surface and how the system is built. Merged in v1.0.2 from the
former api guide, docs/api-architecture.md and docs/api-architecture.md (content unchanged; the
design-decision log is preserved verbatim at the end).

<!-- ═════════════════════════════════════════════════════════════════ -->
# HTTP API

# API reference

## OpenAI-compatible endpoint

Base URL: `http://<host>:8090/api/v1` — auth with a personal API token
(`Authorization: Bearer lst_…`). Tokens are created in Settings → API tokens (shown once,
stored hashed, revocable, max 20 active per user). Auditor accounts cannot use the inference
API.

### `POST /api/v1/chat/completions`

OpenAI `chat.completions` shape (the official SDKs work unmodified — both streaming and
non-streaming are covered by automated tests that use the official `openai` package):

```jsonc
{
  "model": "local:qwen2.5:1.5b",      // model key — see GET /api/v1/models
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": false                      // true → SSE chunks + [DONE]
}
```

Responses follow the OpenAI schema, plus a `lester` field on non-streaming completions.
Errors use the OpenAI error shape with Lester-specific codes:

| Code | HTTP | Meaning |
|---|---|---|
| `invalid_token` | 401 | Missing/invalid/revoked token |
| `model_not_found` | 404 | Model not installed — list with GET /api/v1/models |
| `blocked_by_policy` | 403 | Workspace policy refused the request (nothing was dispatched) |
| `egress_blocked` | — | Local-only request whose destination resolved to a public IP (surfaced as engine error) |
| `engine_unreachable` | 502 | The configured engine did not answer |

Requests pass through the same policy → redaction → engine → Proof pipeline as the Console.
Add `"workspace": "<workspaceId>"` to target a specific workspace (default: the first).

### `GET /api/v1/models`

OpenAI `models.list` shape — installed, enabled, approved models.

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8090/api/v1", api_key="lst_…")
for m in client.models.list():
    print(m.id)
```

## Console API (cookie session)

All bodies are JSON, zod-validated, size-limited. State-changing methods require a same-origin
`Origin` header when one is sent (CSRF). Errors: `{"error": {"code", "message"}}`.

| Method + path | Role | Purpose |
|---|---|---|
| `POST /api/auth/login` | — | Sign in (throttled: username+IP, doubling delays) |
| `POST /api/auth/logout` | any | Sign out |
| `GET /api/auth/session` | any | Current user |
| `GET /api/auth/sessions` · `DELETE` (body `{id}` or `{all:true}`) | any | List / revoke own sessions |
| `GET /api/setup/status` | — | First-run state: hardware scan, engine detection, adapter guide |
| `POST /api/setup/complete` | once | Create admin (+ optional engine connect + model) |
| `POST /api/chat` (SSE) | ADMIN/MEMBER | Console chat streaming |
| `GET/POST /api/conversations` · `GET/PATCH/DELETE /api/conversations/{id}` | ADMIN/MEMBER (own) | Conversations |
| `GET/POST/PATCH/DELETE /api/workspaces` | view: ADMIN/MEMBER; modify: ADMIN | Workspaces |
| `GET/POST/DELETE /api/knowledge` · `POST /api/knowledge/search` | ADMIN/MEMBER | Documents (multipart `file` + `workspaceId`) |
| `GET /api/models` · `POST /api/models` | view: ADMIN/MEMBER; modify: ADMIN | Registry + catalog + install/sync actions |
| `GET /api/engines/detect` · `POST` (connect) | detect: signed-in; connect: ADMIN | Engine detection / connection |
| `GET /api/policy` · `PUT` · `POST` (tester) | view/test: ADMIN/MEMBER; edit: ADMIN | Policy |
| `GET /api/proof` | ADMIN/AUDITOR all; MEMBER own | Ledger (paged, filters) + chain + checkpoints |
| `GET /api/proof/export?format=json\|pdf` | ADMIN/AUDITOR | Signed export |
| `GET/POST /api/fit` · `GET/DELETE /api/fit/{id}` | ADMIN/MEMBER (own) | Evaluation runs |
| `GET /api/hardware` | ADMIN/MEMBER | Hardware profile |
| `GET /api/health` · `GET /api/health-live` | rich: signed-in; live: none | Health / liveness |
| `GET /api/license` · `POST` | view: signed-in; activate: ADMIN | License info / activation |
| `GET /api/settings` · `PUT` | view: ADMIN/MEMBER; edit: ADMIN | Settings |
| `GET/POST /api/tokens` · `DELETE /api/tokens/{id}` | ADMIN/MEMBER (own) | API tokens |
| `GET/POST/PATCH/DELETE /api/users` | ADMIN | User management |

Full role matrix and reasoning: [security-model.md](security-model.md).

<!-- ═════════════════════════════════════════════════════════════════ -->
# Architecture

# Lester architecture

```mermaid
flowchart TB
    subgraph Node["Lester node (your hardware) — one Next.js process"]
        direction TB
        Console["Console — single-page app at / (PWA)"]
        Clients["OpenAI-compatible clients (official SDKs)"]
        subgraph API["API routes (Node runtime, zod-validated)"]
            Auth["Session auth (cookie) / token auth (Bearer lst_)"]
            MW["middleware: Origin check + security headers"]
            Policy["Policy router"]
            Redact["PII/secret redaction (regex + Luhn)"]
            Guard["Egress guard (DNS-resolve at connect)"]
        end
        Engines["Local engines: Ollama · llama.cpp · LM Studio · vLLM · any OpenAI-compatible"]
        Cloud["Cloud providers (policy-gated, OFF by default)"]
        Proof["Proof ledger (SHA-256 chain, v2: seq+ts+content, checkpoints)"]
        Store[("SQLite — WAL, synchronous=FULL, single connection")]
        Backup["Backups: VACUUM INTO + integrity_check + chain verify"]
    end
    Console --> MW --> Auth --> Policy
    Clients -->|Bearer lst_ (hashed lookup)| MW
    Policy --> Redact --> Guard
    Guard -->|loopback/private only enforced| Engines
    Guard -->|only CLOUD_FALLBACK policy| Cloud
    Proof --> Store --> Backup
    Policy --> Proof
    Guard -->|measured egress per request| Proof
```

## Process model

One Next.js process is the whole product:

- **Console** — served at `/`. Boot flow: `GET /api/setup/status` (hardware scan + engine
  detection + per-adapter setup guidance) → setup wizard (first run; works with no engine —
  "continue without one" is a first-class path) → login → fixed-shell SPA. Installs as a PWA;
  the service worker caches only the static shell and never API traffic.
- **API** — route handlers under `/api/*`, Node runtime, zod-validated bodies, role-enforced.
  All state lives in SQLite via Prisma (single connection, WAL, `synchronous=FULL`, FKs on).
- **Startup** (`start:prod`): build if missing → `runMigrations()` (fresh: apply all;
  v1.0.0: baseline + upgrade with pre-upgrade backup) → boot (durability pragmas, legacy token
  re-hash, v1→v2 proof rehash, boot checkpoint, chain verification, backup scheduler) → serve.
- **Shutdown**: SIGINT/SIGTERM stop accepting connections, let in-flight writes finish.

## Request path (everything flows through this)

1. **Edge** — `src/middleware.ts`: Origin check on state-changing cookie-auth routes (CSRF);
   CSP, `frame-ancestors 'none'`, nosniff, no-referrer, minimal Permissions-Policy on every
   response.
2. **Auth** — session cookie (HttpOnly, SameSite=Strict, Secure behind TLS with
   `LESTER_TRUST_PROXY`) → hashed server-side sessions; or personal API tokens
   (SHA-256-at-rest, multiple named tokens, revocable, shown once) for `/api/v1`.
3. **Policy** (`src/lib/policy.ts`) — workspace rules: mode (LOCAL_ONLY / CLOUD_FALLBACK /
   BLOCK_ALL), keyword blocks, model allow-lists, PII redaction. Blocked requests never reach
   an engine; they are Proof-recorded as `blocked` with `egress: none`.
4. **Redaction** (`src/lib/redact.ts`) — regex + Luhn detectors mask cards, SSN, IBAN, emails,
   phones (incl. +91 formats), API keys, private-key blocks *before dispatch*.
5. **Engine** (`src/lib/inference/`) — one OpenAI-compatible client for every engine;
   `detectEngines()` probes configured URL + common ports (incl. Docker sidecar and
   `host.docker.internal`). The **guarded HTTP client** resolves the destination through DNS at
   connect time and refuses public IPs unless this specific request is policy-authorized to use
   a cloud provider; link-local/cloud-metadata endpoints are always refused. Cloud fallback
   fires only on local-engine connection failure, only under CLOUD_FALLBACK policy, only with a
   configured provider — and is Proof-recorded as `external`.
6. **Proof ledger** (`src/lib/proof.ts`) — append-only, hash-chained. **Hash v2** covers
   `prevHash | seq | ts | canonicalJson` — editing content, renumbering or touching timestamps
   all break the chain at an exact sequence number. Serialized appends; Ed25519-signed exports
   (JSON + PDF); signed checkpoints of the head hash (boot + every 6h, exportable/anchorable);
   chain verified at boot, on demand, on every backup and every export.

## Egress classification (measured, not configured)

Every executed request resolves its engine endpoint through DNS at request time and records
host, IP and class — `loopback` (127/8, ::1), `private` (RFC1918, ULA, link-local),
`external`. The classification is a *measurement*; policy enforcement happens in the HTTP
client against that measurement. The remaining theoretical gap (DNS rebinding between resolve
and connect, milliseconds wide, attacker-controlled DNS required) is documented in
docs/security-model.md, with the `docker-compose.isolated.yml` network mode as the hard
guarantee.

## Storage & durability

- SQLite in WAL mode, `synchronous=FULL`, single connection (`connection_limit=1`).
- **Migrations only** (`prisma/migrations`, applied via `migrate deploy`): `db push` is never
  used; pending migrations trigger an automatic pre-upgrade snapshot first.
- **Backups**: `VACUUM INTO` (SQLite's online backup — a transactionally consistent snapshot,
  not a file copy), `PRAGMA integrity_check` on the snapshot, live chain verification recorded
  with every backup, retention pruning, configurable external directory
  (`LESTER_BACKUP_DIR`).
- **Restore**: checksum + integrity check, pre-restore safety snapshot of the current DB, then
  atomic swap and re-verification.
- Keys in `DATA/keys/` (0600): server secret (AES-256-GCM for API keys + optional message
  encryption; location overridable via `LESTER_MASTER_KEY_FILE`), Proof signing keypair
  (rotatable), no license keys (vendor public key pinned in source).

## Knowledge

Upload (validated: type, size ≤5 MB, count ≤500/workspace, sanitized filenames) → UTF-8 text →
paragraph-aware chunking (~900 chars, 120 overlap) → BM25 index (on-device). Chat retrieval
injects top-k excerpts as **untrusted data** — wrapped in explicit delimiters with instructions
that document content must never override policy or trigger actions (prompt-injection
hardening, tested).

## Fit

Runs prompts × candidates through the normal engine path (policy + Proof included), persisting
per-sample results as they complete. Quality is scored by an LLM-as-judge on the same node.
The summary splits **measured** (latency, tok/s, tokens, quality, success rate) from
**assumptions** (user-entered pricing and volume) and labels all cost figures as estimates.

## Roles (enforced server-side on every route)

- **ADMIN** — everything.
- **MEMBER** — chat, knowledge, fit, models view; sees only their own conversations and Fit
  runs; own Proof entries; own API tokens.
- **AUDITOR** — read-only Proof (full ledger + exports) and Health. Nothing else.

Full matrix: docs/security-model.md.

<!-- ═════════════════════════════════════════════════════════════════ -->
# Design decisions

# Lester decisions

One line per decision, as made. Versions were checked against the lockfile/registry at
build time, not from memory.

| # | Decision | Why |
|---|---|---|
| 1 | **Next.js 16 + TypeScript 5, single process** | One deployable serves Console + API; no separate backend to babysit on customer hardware. |
| 2 | **SQLite via Prisma 6, WAL + `synchronous=FULL`, `connection_limit=1`** | Zero external database satisfies "no dependencies"; single connection makes durability pragmas apply to every query; WAL survives process kill. |
| 3 | **One OpenAI-compatible client for ALL engines** (Ollama, llama.cpp, LM Studio, vLLM, generic; cloud providers) | "Connect to any existing OpenAI-compatible endpoint" is the spec; one client, one egress-enforcement point, one place to test. |
| 4 | **No built-in engine (removed in 1.0.1)** | v1.0.0 shipped a "built-in" engine that was actually a hosted SDK tied to the build sandbox — a false "local" claim. Local adapters + auto-detection replace it; a fresh install with no engine shows setup guidance, not an error. |
| 5 | **Egress measured by live DNS resolution, enforced at the HTTP client** | Honesty over configuration: destination class is a measurement; and when policy is local-only, public IPs are refused before a socket opens (defeats config lies and stale DNS; the ms-scale rebinding TOCTOU is documented with the isolated-network option as the hard guarantee). |
| 6 | **Hash chain v2 (SHA-256 over `prev + seq + ts + canonical JSON`) + Ed25519-signed exports + signed checkpoints** | v1's hash omitted seq/ts, so reordering/timestamp edits were undetectable. Legacy ledgers re-hash to v2 only after verifying under v1 rules; the transition is itself Proof-logged. Checkpoints are exportable anchors against disk-level attackers. |
| 7 | **PDF export via pdf-lib (standard fonts, WinAnsi-sanitized)** | Pure-JS, no binaries; sanitizing to ASCII keeps the auditor PDF renderable everywhere. |
| 8 | **BM25 retrieval, no embeddings** | Fully on-device, deterministic, explainable citations; v1 scope is text formats. |
| 9 | **PII redaction = regex + Luhn, before dispatch** | Deterministic, testable, zero-latency; false-positive-safe (invalid card numbers pass through). Known gaps (10-digit unprefixed Indian mobiles, national-ID formats) are documented, not hidden. |
| 10 | **Cloud fallback OFF by default, two-key ignition** | Requires policy mode `CLOUD_FALLBACK` AND a configured provider with a default model; fires only on local-engine connection failure; Proof-recorded as external. |
| 11 | **Model catalog = real Ollama library tags (Q4_K_M)** | Public, checkable facts; sizes/RAM stated as ≈; no invented benchmarks anywhere in the product. |
| 12 | **Fit: LLM-as-judge on-node; measured vs assumed visually separated; cost figures labeled ESTIMATE** | The spec forbids invented statistics; quality is measured live, pricing is user-entered, and the verdict text says which is which. |
| 13 | **Licenses: Ed25519, node-bound, offline; vendor public key pinned in source; private key NEVER on customer nodes** | Works air-gapped. Honest limits stated in the README: an open-source build cannot technically prevent self-patching; licensing gates honest builds + the support/compliance relationship. |
| 14 | **Auth: local accounts, scrypt, server-side hashed sessions, hashed multi-token API access, persisted progressive throttling** | No cloud identity in v1. Tokens shown once, stored as SHA-256. Throttle is username+IP keyed with doubling delays and no hard lockout (cannot be used to lock out the admin); offline `admin:recover` CLI exists. |
| 15 | **Console as a single fixed-shell SPA at `/` with tab navigation** | Spec demands no long scrolling pages; one route keeps the PWA shell simple and the SW cache-safe. |
| 16 | **PWA with a conservative service worker** | Installable; the SW caches only the shell — API traffic is never cached, so Proof/streaming always hit the live server. |
| 17 | **ZIP as the deliverable, regenerable with `bun run package`** | Self-contained source + Docker + scripts + docs; per-file checksums in `SHA256SUMS`. |
| 18 | **Migrations only — `db push` and `--accept-data-loss` are gone** | Upgrades must never destroy data. Pending migrations trigger automatic `VACUUM INTO` snapshots first; v1.0.0 databases are baselined + upgraded with data intact (automated test). |
| 19 | **Backups via `VACUUM INTO` + `integrity_check` + chain verify; restore takes a pre-restore snapshot** | A file copy after WAL checkpoint is not consistent under concurrent writes; SQLite's online backup is. Restores refuse corrupt/checksum-mismatched files. |
| 20 | **Bind address is an environment decision (`LESTER_BIND`, default 127.0.0.1), never a Console toggle** | v1.0.0 stored a fake "LAN access" setting that controlled nothing. Now the Console displays the bind read-only with instructions. |
| 21 | **Telemetry: none, ever** | Not "off by default" — absent. The only outbound bytes possible are admin-configured engines/providers (policy-gated) and model downloads through the local engine. |
| 22 | **Safe markdown for model output (react-markdown, no raw HTML, links as text, no images)** | Model output is untrusted: no XSS surface, no external image beacons, no crafted clickable links; CSP backs this up. |
| 23 | **Docker: digest-pinned bases, non-root, cap-drop ALL, no-new-privileges, read-only rootfs, loopback-only publish, zero-edit profiles** | The default compose experience must be safe out of the box; LAN exposure and isolated networking are explicit, documented choices. |
| 24 | **zod validation on every route + sanitized 500s** | No unvalidated input, no stack traces to clients. |

## Version pins (verified at build time)

Runtime: `next@16.1.3`, `react@19.1.0`, `typescript@5.9.x`, `prisma@6.19.3` client,
`tailwindcss@4`, `pdf-lib@1.17.1`, `@fontsource-variable/inter@5.3.0`, `adm-zip@0.6.1`,
`sharp@0.34.5`, `openai@5.x` (dev, tests), `zod@4.6.7`, `bun@1.3.14` (runtime, tests, scripts).
Docker bases: `oven/bun:1.3.14-slim` and `ollama/ollama:0.40.16`, both pinned by digest in the
Dockerfile/compose. Check `bun.lock` / `SHA256SUMS` for the exact reproducible set.
