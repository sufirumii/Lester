# Lester security model

## Threat model

Lester protects three things, under the assumption **the operator controls the host**:

1. **Confidentiality of prompts** — nothing leaves the machine unless policy explicitly allows
   it, and every exit is recorded.
2. **Auditability** — every request is provable: model, destination (measured), timing, outcome.
3. **Integrity of records** — retroactive tampering is detectable; upgrades and restores never
   destroy data.

The biggest assumed risk is *data leaving quietly*. The biggest honest limitation is that
Lester cannot defend against the host's own administrator — see Limits.

## Secure defaults

| Default | Enforcement |
|---|---|
| Loopback-only bind (`LESTER_BIND=127.0.0.1`) | `start:prod` passes it to the server; Docker publishes `127.0.0.1:8090:8090`; automated test asserts the default. LAN exposure is an env change + restart, never a Console toggle. |
| Authentication always required | Session cookie (HttpOnly, `SameSite=Strict`, `Secure` behind TLS with `LESTER_TRUST_PROXY`) or hashed API token. |
| Password policy | 10+ chars, letters+numbers, common-password blocklist, no username substring. |
| Login throttling | Persisted (survives restarts), keyed by username+IP, doubling delays 1s→60s, **no hard lockout** — attackers slow themselves down, admins stay able to sign in. Offline recovery: `bun run admin:recover`. |
| API tokens | SHA-256 at rest, shown once, multiple named tokens, individual revocation. |
| Cloud fallback OFF | Needs policy mode `CLOUD_FALLBACK` **and** a configured provider; fires only on local-engine failure; recorded as `external`. |
| Cloud models unapproved by default | An admin must approve each one even after sync. |
| SSRF guard | Admin-saved engine/provider URLs: scheme allowlist, no embedded credentials, host must resolve, link-local/cloud-metadata (169.254.0.0/16) always refused. Re-checked at connect time. |
| Egress enforcement | The HTTP client DNS-resolves the destination per request; local-only requests to public IPs are refused before a socket opens. |
| Security headers | CSP (self-only scripts, `frame-ancestors 'none'`, no objects), nosniff, no-referrer, minimal Permissions-Policy; Origin check on state-changing cookie routes (CSRF). |
| Rendering | Model output rendered as markdown **without raw HTML**, links as plain text, images disabled (no XSS, no beacons); CSP backs this up. |
| Telemetry | Absent — not "off", absent. Runtime outbound traffic: configured engines and policy-approved providers only. |

## Role matrix (enforced server-side on every route)

| Route | ADMIN | MEMBER | AUDITOR |
|---|---|---|---|
| Chat (`/api/chat`, `/api/v1/chat/completions`) | ✓ | ✓ | ✗ |
| Conversations (list/read/edit/delete) | all | **own only** | ✗ |
| Knowledge (list/upload/delete/search) | ✓ | ✓ | ✗ |
| Models (view) | ✓ | ✓ | ✗ |
| Models (install/approve/sync) | ✓ | ✗ | ✗ |
| Engines (detect/connect) | ✓ | ✗ (detect: ✓) | ✗ |
| Policy (view / test) | ✓ | ✓ | ✗ |
| Policy (edit) | ✓ | ✗ | ✗ |
| Proof (list) | all | **own entries only** | all |
| Proof (signed export) | ✓ | ✗ | ✓ |
| Fit (run/view/cancel) | all | **own only** | ✗ |
| Users (list/create/edit/delete) | ✓ | ✗ | ✗ |
| Settings (view) | ✓ | ✓ | ✗ |
| Settings (edit) | ✓ | ✗ | ✗ |
| API tokens | own | own | ✗ |
| Sessions (list/revoke own) | ✓ | ✓ | ✓ |
| Health | ✓ | ✓ | ✓ |
| License (view / activate) | ✓ / ✓ | ✓ / ✗ | ✓ / ✗ |

IDOR protections: conversations and Fit runs are ownership-checked (owner or ADMIN);
documents are workspace-scoped by design (shared workspace knowledge).

## Data protection

- PII/secret redaction **before dispatch**: Luhn-validated cards, US SSN, IBAN, emails,
  international phones (incl. `+91` formats), API keys (sk-/ghp_/AKIA/xoxb-), private-key
  blocks. False-negative-safe: an invalid card number passes through unmasked.
- Cloud API keys: AES-256-GCM at rest. Optional message-content encryption at rest (same).
- Prompt content never enters the Proof ledger unless an admin explicitly enables content
  logging (amber warning in the Console).

### Redaction accuracy (measured on the test corpus, honestly)

On the suite in `tests/redaction.test.ts`: **100% recall and 100% precision** for the covered
formats (Luhn-valid cards in 3 formats incl. Amex, emails, +91/+1/+49 phones, SSN, IBAN, 3
API-key shapes, PEM blocks). **Known gaps (documented, deliberate):** 10-digit Indian mobiles
*without* the +91 prefix are not masked (indistinguishable from order/reference numbers —
masking them would flood users with false positives); no national-ID formats (Aadhaar etc.) in
v1. Treat redaction as a safety net, not a compliance guarantee.

## Integrity

- **Proof chain v2** — each entry's hash covers the previous hash, the sequence number, the
  timestamp and the content (canonical JSON). Editing content, renumbering, reordering or
  touching timestamps breaks the chain at an exact seq. Automated tests exercise every one of
  those tamper modes.
- **v1→v2 upgrade** — legacy entries re-hash only after the v1 chain verifies; the transition
  is Proof-logged. A broken legacy chain is refused and left untouched.
- **Signed checkpoints** — the head hash is signed (Ed25519) at boot and every 6h. Export one
  and anchor it off-host (email it, print it, commit it to another repo) and a full-chain
  rewrite by a disk-level attacker becomes detectable.
- **Exports** — Ed25519-signed JSON + PDF; `bun run proof:verify` checks signature, chain and
  checkpoints offline.
- **Migrations** — real SQL migrations only; pending migrations trigger an automatic pre-upgrade
  `VACUUM INTO` snapshot. No `--accept-data-loss` anywhere.
- **Backups** — consistent snapshots with `PRAGMA integrity_check` and live chain verification
  recorded per backup. Restores verify checksum + integrity, snapshot the current DB first,
  then swap atomically.

## Encryption at rest — what it does and does not protect

What's encrypted: cloud-provider API keys (always), message content (optional
`LESTER_ENCRYPT_AT_REST`).

What it protects against: someone copying the database file (or a backup) without the key.

What it does NOT protect against: the host administrator, who can read the key at
`DATA/keys/server.key` (mode 0600). To raise the bar: point `LESTER_MASTER_KEY_FILE` at a
separate volume/removable device, and keep the passphrase-encrypted key bundle
(`bun run keys:export`) off-machine. The SQLite file itself is not whole-file encrypted in v1.
Old Proof signatures verify with the node's key — keep the key bundle with your backups or
old exports stop verifying.

## Egress enforcement — exact wording of what is guaranteed

1. **Configured endpoint ≠ trusted**: every request resolves the engine destination through
   DNS at connect time and records host + IP + class (loopback/private/external).
2. **Local-only requests cannot open sockets to public IPs**: the guarded HTTP client refuses
   before connecting. Link-local/cloud-metadata endpoints are always refused for engines and
   providers.
3. **Cloud requests happen only under `CLOUD_FALLBACK` policy with a configured provider**,
   and every one is recorded as `external` with its resolved IP.
4. **Theoretical gap**: an attacker who controls the engine's DNS could rebind the name
   between resolution and connection (a millisecond-scale window). If you need a hard
   guarantee, use `docker-compose.isolated.yml` — an internal Docker network with no outbound
   route at all.
5. **"No telemetry" is total**: no analytics, no update pings, no crash reports, no font CDNs
   (marketing site fonts are self-hosted). Installing needs the network; running does not.

## Limits (read this part)

- A host administrator with disk access can read decrypted data, and can rebuild + re-sign the
  Proof chain — checkpoints anchored off-host are the countermeasure; without one, tampering by
  the host admin is not provable.
- An open-source product cannot technically prevent a self-patcher from removing license checks
  or policy. Lester's guarantees hold for unmodified builds; verification tooling
  (`proof:verify`) is provided so auditors can check what a node actually did.
- Redaction is regex+Luhn — see accuracy above.
- SSO/OIDC is not implemented (and not advertised).

## Reporting

See [SECURITY.md](../SECURITY.md) at the repository root for private disclosure instructions.
