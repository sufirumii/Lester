# Lester guide

Everything an operator needs: quick start, configuration reference, deployment
paths, and troubleshooting. Merged in v1.0.2 from the former quick-start,
configuration, troubleshooting and DEPLOY guides (content unchanged; file
references updated).

<!-- ═════════════════════════════════════════════════════════════════ -->
# Quick start

# Quick start

## 1 · Install

**Docker (any OS):**
```bash
unzip lester-v1.0.4.zip && cd lester-v1.0.4
docker compose up -d
open http://localhost:8090
```

With an Ollama sidecar (pulls a small model once):
```bash
docker compose --profile with-ollama up -d
```

**Native:** `bash install.sh` (Linux/macOS) or `.\install.ps1` (Windows), then
`bun run start:prod` → http://localhost:8090.

## 2 · First run (the wizard)

1. **Hardware & engine** — a real scan of CPU/RAM/GPU/disk, plus engine detection.
   Have Ollama/LM Studio/llama.cpp/vLLM running and it is found automatically
   (or press **Rescan**). Nothing found? The wizard shows per-engine install
   instructions — you can also continue without an engine and connect one later
   in Settings → Engine.
2. **Admin account** — local, scrypt-hashed. 10+ characters with letters and
   numbers; common passwords are rejected.
3. **Model** — models your engine already serves (zero download) or catalog
   picks with hardware-fit from the scan.
4. **Review** — secure defaults: local-only routing, PII redaction on, cloud
   fallback off, no telemetry.

## 3 · Chat

Type. Every answer shows tokens, latency and its Proof sequence number. Try the
policy tester (Policy tab) with a credit-card number to watch redaction happen
before dispatch.

## 4 · Prove it

Proof tab → **Signed JSON**. Then, fully offline:

```bash
bun run proof:verify -- lester-proof-<date>.json
```

## 5 · Use your existing apps

Settings → API tokens → create one (shown once, stored hashed):

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8090/api/v1", api_key="lst_…")
print(client.chat.completions.create(
    model="local:qwen2.5:1.5b",   # GET /api/v1/models lists what's installed
    messages=[{"role": "user", "content": "Hello, Lester."}],
).choices[0].message.content)
```

## Next steps

- [configuration.md](configuration.md) — every environment variable
- [security-model.md](security-model.md) — threat model, roles, limits
- [proof-and-verification.md](proof-and-verification.md) — ledger internals
- [fit-methodology.md](fit-methodology.md) — how the cost estimate works
- [api.md](api.md) — API reference
- [troubleshooting.md](troubleshooting.md) — common problems

<!-- ═════════════════════════════════════════════════════════════════ -->
# Configuration reference

# Configuration reference

Every environment variable, one table. All have safe defaults; nothing secret is required.
The Console (Settings tab) manages most behavior at runtime — these are the boot-time
defaults and infrastructure settings. Set them in `.env` (native) or the compose
`environment:` block (Docker).

## Core

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | `file:<project>/db/lester.db?connection_limit=1` | SQLite location (unset = this default; a relative path is resolved against the project folder). Keep `connection_limit=1` — it makes the durability pragmas apply to every query. |
| `LESTER_DATA_DIR` | `<project>/db` | Where the database, backups and keys live (Docker: `/app/data`). |
| `LESTER_BACKUP_DIR` | `DATA/backups` | Backup destination. Point at another volume so a dead disk cannot take the only copies (the Console warns when backups share the DB's volume). |

## Network (loopback by default)

| Variable | Default | What it does |
|---|---|---|
| `LESTER_BIND` | `127.0.0.1` | Address the production server binds to. `0.0.0.0` (LAN) is an explicit operator decision — the Console shows the current bind read-only and refuses to pretend a toggle controls it. |
| `LESTER_PORT` | `8090` | The one port variable, used by `start:prod` and Docker. Dev server is always 3000. |
| `LESTER_TRUST_PROXY` | `false` | Set `true` only behind a trusted reverse proxy (Caddy/nginx) that sets `X-Forwarded-*`. Required for the `Secure` cookie flag behind TLS; also enables real client IPs for throttling. |

## Engine

| Variable | Default | What it does |
|---|---|---|
| `LESTER_ENGINE` | `auto` | `auto` probes common ports (+ Docker sidecar + host). Or `ollama`, `lmstudio`, `llamacpp`, `vllm`, `openai-compat` (with URL), `none`. Editable later in Settings → Engine. |
| `LESTER_ENGINE_URL` | — | Explicit engine base URL (e.g. `http://127.0.0.1:11434/v1`). Overrides preset ports. Local engines must resolve to loopback/private space. |
| `LESTER_ENGINE_CANDIDATES` | — | Extra detection URLs, comma-separated (e.g. `http://192.168.1.50:11434/v1`). |
| `LESTER_ALLOW_METADATA_ENDPOINTS` | `false` | Allow engine/provider URLs resolving into link-local / cloud-metadata space (169.254.0.0/16). Almost always a mistake. |

## Keys & crypto

| Variable | Default | What it does |
|---|---|---|
| `LESTER_MASTER_KEY_FILE` | `DATA/keys/server.key` | Location of the AES-256-GCM master key. Point at another volume/removable device to separate key material from data. |
| `LESTER_PROOF_SIGNING_KEY_FILE` | `DATA/keys/proof-signing.pem` | Proof signing key override (rotation: `bun scripts/rotate-proof-key.ts`). |
| `LESTER_LICENSE_PUB` | vendor key pinned in source | Override for contributor/dev workflows (`bun run license:devkey`). Production builds verify against the pinned vendor key. |
| `LESTER_LICENSE_PRIV` | — | Issuing side only (`scripts/issue-license.ts`); never set on a customer node. |

## Behavior

| Variable | Default | What it does |
|---|---|---|
| `LESTER_CONTENT_LOGGING` | `false` | Boot-time default for prompt-content audit logging (first 500 chars in Proof; amber warning in the Console). |
| `LESTER_ENCRYPT_AT_REST` | `false` | Boot-time default for AES-256-GCM message encryption. |
| `LESTER_SESSION_TTL_HOURS` | `72` | Console session lifetime. |
| `LESTER_BACKUP_HOUR` | `3` | Daily auto-backup hour (0–23, server time). |
| `LESTER_BACKUP_KEEP` | `14` | Backup retention count. |
| `LESTER_TELEMETRY` | does-not-exist | Intentionally unused; documented to make the absence greppable. |

## What is NOT configurable (on purpose)

- Telemetry — there is none, at any setting.
- The vendor license public key (source-pinned; env override is a dev convenience, visible in `.env`).
- The Proof chain hash format (v2) — changing it would break verification.
- Cloud-model approval — cloud models always start unapproved; an admin must approve.

<!-- ═════════════════════════════════════════════════════════════════ -->
# Troubleshooting

# Troubleshooting

## First run / engines

**"No local engine found (yet)"** — expected on a fresh install without an engine. Either
install one (the wizard lists per-engine instructions: Ollama → `ollama serve`, LM Studio →
start the local server, llama.cpp → `llama-server -m model.gguf --port 8080`, vLLM →
`vllm serve`) and press **Rescan**, or continue without an engine and connect it later in
Settings → Engine.

**Engine runs but is not detected** — check it actually speaks the OpenAI-compatible API on
the default port (Ollama 11434, LM Studio 1234, llama.cpp 8080, vLLM 8000). Non-standard
port/URL: set `LESTER_ENGINE_URL` (or `LESTER_ENGINE_CANDIDATES`) or enter the URL in
Settings → Engine. Engines must resolve to loopback/private addresses.

**Docker: Lester can't reach Ollama on the host** — use `docker compose --profile with-ollama
up -d` (sidecar; auto-detected), or keep host Ollama: the base compose already maps
`host.docker.internal` on Linux via `extra_hosts`. Verify with
`docker compose exec lester bun -e "fetch('http://host.docker.internal:11434/v1/models').then(r=>console.log(r.status)).catch(e=>console.log(e.message))"`.

**"engine_unreachable" during chat** — the engine URL is stale or the engine restarted. The
error text includes the endpoint; nothing left the machine.

## Access

**Forgot the admin password** — on the server, stopped:
`bun run admin:recover -- --user admin --new-password '<new>'` (resets the password, revokes
sessions, clears throttle state; recorded in Proof).

**"Too many failed attempts"** — throttling is progressive (1s→60s) and clears after 15 quiet
minutes or a successful login. It is keyed by username **and** IP; it never hard-locks the
account.

**Cannot sign in behind a reverse proxy** — if TLS is terminated by the proxy, set
`LESTER_TRUST_PROXY=true` so `X-Forwarded-*` is honored (Secure cookies, real client IPs).

**Port already in use** — `LESTER_PORT=9090 bun run start:prod` (Docker: change the compose
port mapping). Exactly one port variable.

**Not reachable from another machine** — that is the default (loopback-only bind). See
the Deploy section of this guide § LAN exposure for the deliberate opt-in.

## Data / durability

**"Backups share the volume with the database" warning** — set
`LESTER_BACKUP_DIR=/mnt/backup/lester` to a different volume, and run
`bun run keys:export` so restores on other hardware stay possible.

**Restore refuses a file** — checksum mismatch (corrupt/transferred incorrectly) or the file
failed `PRAGMA integrity_check`. Lester never restores a file that fails either check; use a
different backup.

**Upgrade concerns** — `bun run migrate` takes an automatic pre-upgrade snapshot and never
uses destructive flags. If a migration ever refuses (corrupt DB), restore the latest backup
and retry.

## Proof

**Chain INVALID at boot** — the message names the first broken sequence number and the tamper
mode (edit / reorder / timestamp). Inspect that entry in the Proof tab; compare against an
exported report or an anchored checkpoint. This is the system working, not failing.

**proof:verify says checkpoints 0/3 verify** — the report key differs from the key that signed
the checkpoints (a rotation happened); check `keyId` fields and the retired keys under
`DATA/keys/retired/`.

## Docker specifics

**Healthcheck unhealthy** — `docker compose logs lester`; the liveness endpoint is
`GET /api/health-live`. First boot includes migrations — give it the start period.

**Isolated mode blocks model downloads** — that is the point of `docker-compose.isolated.yml`
(zero outbound route). Preload models into the volume instead (the Deploy section of this guide §4).

<!-- ═════════════════════════════════════════════════════════════════ -->
# Deploying Lester

# Deploying Lester

Three supported paths: single laptop, on-premises server, air-gapped network.

---

## Network requirements — the honest list

Lester's **runtime** makes no outbound requests except engines you configure. But **installing**
needs the network. Every touch, explicitly:

| When | What is downloaded | From |
|---|---|---|
| Native install | Bun runtime (if missing) | `bun.sh` |
| Native install | npm packages (`bun install --frozen-lockfile`) | `registry.npmjs.org` |
| Native install / build | Prisma query + migration engines | `binaries.prisma.sh` (via npm package lifecycle) |
| Docker build | Base images + packages | Docker Hub (`oven/bun`, pinned by digest) |
| Anytime (optional) | AI models through your engine | e.g. `registry.ollama.ai` |
| Never | Telemetry, license servers, update checks | — none exist |

For air-gapped installs see §4 — everything above can be pre-carried.

---

## 1 · Single laptop (Windows / macOS / Linux)

```bash
unzip lester-v1.0.4.zip && cd lester-v1.0.4

# Linux / macOS
bash install.sh

# Windows (PowerShell, admin optional)
.\install.ps1
```

The installer: installs Bun ≥ 1.3 if missing, installs dependencies, applies database
migrations (never destructive — existing data survives), installs the `lester` launcher
(+ desktop entry / shortcut).

Start:
```bash
bun run start:prod        # http://localhost:8090  (binds 127.0.0.1)
# or after install.sh:    lester
```

`start:prod` builds if needed, migrates (auto-backup first), serves, and shuts down gracefully
on Ctrl-C (in-flight writes finish, WAL checkpointed).

**With a local model engine** (recommended): install [Ollama](https://ollama.com) /
[LM Studio](https://lmstudio.ai) / llama.cpp / vLLM and start it. The setup wizard and
Settings → Engine auto-detect it (Ollama 11434, LM Studio 1234, llama.cpp 8080, vLLM 8000).
With Ollama, Models → Catalog installs pull through it.

---

## 2 · On-premises server (Docker)

```bash
cd lester-v1.0.4
docker compose up -d                          # Lester on http://localhost:8090
docker compose --profile with-ollama up -d    # + Ollama sidecar (pulls qwen2.5:1.5b once)
```

What the compose file does (no manual edits needed in either mode):

- `lester` — builds the app (multi-stage, digest-pinned `oven/bun:1.3.14-slim`), runs as the
  non-root `bun` user, applies migrations at startup, publishes **127.0.0.1:8090:8090 only**,
  drops all capabilities, `no-new-privileges`, read-only rootfs + tmpfs, healthcheck.
- `ollama` (optional profile) — pinned `ollama/ollama:0.40.16`, own volume, healthcheck.
- `ollama-init` (optional profile) — one-shot pull of a small default model.
- Auto-detection covers the sidecar (`http://ollama:11434`), host Ollama
  (`host.docker.internal`, mapped on Linux via `extra_hosts`) and local ports.

### LAN exposure (explicit opt-in)

By default the port is published on loopback only. To expose on the LAN **deliberately**:

1. Put TLS in front (Caddy example below) — or accept the risk knowingly.
2. Change the compose port mapping to `"8090:8090"`.

```
# Caddyfile example
ai.corp.example {
    reverse_proxy 127.0.0.1:8090
}
```

If a trusted reverse proxy terminates TLS and sets `X-Forwarded-*`, set
`LESTER_TRUST_PROXY=true` so session cookies get the `Secure` flag.

### Hard zero-egress mode

```bash
docker compose -f docker-compose.yml -f docker-compose.isolated.yml up -d
```

The `lester` service joins an `internal: true` network — no outbound route exists at the
network layer, so even a compromised app cannot reach the internet. Consequences (honest):
model downloads and cloud fallback become impossible; bring models in via `docker cp` or a
preloaded volume (§4).

### Native service management

`sudo bash install.sh --systemd` installs a systemd unit (Linux). Unit-level overrides live in
`/etc/lester.env`.

---

## 3 · Upgrades (safe by construction)

```bash
# unzip the new release beside the old one, copy db/ over (or keep LESTER_DATA_DIR on a volume), then:
bun run migrate      # v1.0.0 databases: baselined + upgraded, data intact
bun run start:prod
```

- `migrate` **never** uses `--accept-data-loss`. Schema changes are real SQL migrations.
- Before applying any pending migration an automatic backup is taken (`VACUUM INTO` snapshot,
  recorded in the Backups list as `pre-upgrade`).
- A v1.0.0 database (created via `db push`, no migrations table) is recognized, baselined and
  upgraded with data intact — verified by an automated test (`tests/migrations.test.ts`).
- Legacy v1 proof entries are re-hashed to the v2 form (seq+ts covered) only after the v1 chain
  verifies; the transition is Proof-logged.

---

## 4 · Air-gapped network

1. **Carry the software**: `lester-v1.0.4.zip` via removable media; verify against `SHA256SUMS`
   (`sha256sum -c` / `Get-FileHash`).
2. **Carry dependencies** (from a connected machine, inside the project):
   ```bash
   bash scripts/vendor-offline.sh     # → lester-offline-bundle-<date>.tar.gz
   ```
   The bundle contains the full `node_modules` tree **including the Prisma engine binaries** —
   nothing contacts `binaries.prisma.sh` on the air-gapped side. Bun itself must be pre-placed
   (`packaging/vendor/bun`) or installed via your internal software distribution.
   On the air-gapped machine: `tar xzf lester-offline-bundle-*.tar.gz && bun run start:prod`.
   (Docker path: `docker save`/`docker load` the images from a connected machine.)
3. **Carry the models** — pick one:
   - Copy an existing Ollama store (`~/.ollama/models`) to the same path on the target host.
   - Or copy GGUF files and register them (`ollama create` from a Modelfile).
   - Or preload a volume / `docker cp` into the ollama container.
4. **Configure**: Settings → Engine (auto-detect finds the local engine; or set
   `LESTER_ENGINE_URL`). Models → Catalog shows pulled models as installed.
5. **Licenses** are offline by design: `bun run license:issue -- --key <vendor.pem> --node <nodeId>`
   on the machine holding the vendor private key, paste into Settings → About.
6. **Verify egress**: with cloud fallback off (default), the Proof ledger's egress column stays
   `loopback`/`private` — these are DNS-measured values, not configuration echoes. For a network
   -layer guarantee use the isolated compose mode (§2).

---

## 5 · Operations runbook

| Task | Command / place |
|---|---|
| Start | `bun run start:prod` · `docker compose up -d` · `lester` · systemd unit |
| Stop | Ctrl-C (graceful) · `docker compose down` — WAL guarantees consistency |
| Backup now | Settings → Backups → "Back up now" · `bun run backup` |
| Scheduled backups | Settings → Backups (daily hour, retention) — enabled by default |
| External backup dir | `LESTER_BACKUP_DIR=/mnt/backup/lester` (warns in Console when backups share the DB's volume) |
| Key export (D2) | `bun run keys:export [--passphrase '…']` — needed to decrypt content after a restore on other hardware |
| Restore | Settings → Backups → Restore · `bun run restore <file> [--sha <hex>]` (pre-restore snapshot + integrity check first) |
| Upgrade | §3 — `bun run migrate` (auto-backup) then start |
| Admin locked out | `bun run admin:recover -- --user admin --new-password '<new>'` (server stopped; Proof-logged) |
| Rotate proof key | `bun scripts/rotate-proof-key.ts` (old key archived, transition Proof-logged) |
| Export Proof | Proof tab → Signed JSON / PDF; verify: `bun run proof:verify -- file.json` |
| Health check | `GET /api/health-live` (liveness, no auth) · `GET /api/health` (rich, auth) |
| Logs | stdout (start:prod) · `docker compose logs lester` |

### What a backup contains — and what it doesn't

A `.db` backup contains the database (ledger, users' hashes, workspaces, conversations,
encrypted blobs). It does **not** contain key material: without `DATA/keys/server.key`
(or your `LESTER_MASTER_KEY_FILE`), encrypted API keys and encrypted message content cannot be
decrypted after a restore on other hardware, and old Proof signatures cannot be verified with
the node's key. Run `bun run keys:export` after setup, store the bundle (ideally
passphrase-encrypted) off-machine alongside backups. See docs/security-model.md for the exact
threat model of encryption-at-rest.

## Uninstall

```bash
bash uninstall.sh          # or Windows: .\uninstall.ps1
```

Removes launcher/service; asks explicitly before touching any data (db/, backups, keys are kept
by default). Docker: `docker compose down -v` removes volumes (that DOES delete data — it is
a volume deletion).

<!-- ═════════════════════════════════════════════════════════════════ -->
# Appendix: Inter font license (SIL Open Font License 1.1)

The Console and the marketing site self-host the Inter typeface. The full
license text follows, preserved verbatim (formerly packaging/site/FONT_LICENSE.txt):

Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.

