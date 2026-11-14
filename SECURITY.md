# Security Policy

Lester is a private AI control plane — keeping user data private, provable and
intact is the entire product. Security reports are taken seriously and fixed
fast.

## Reporting a vulnerability

**Please report privately. Do NOT open a public issue for anything
security-sensitive.**

The preferred channel is GitHub Security Advisories:

1. Open the repository's **Security** tab → **Advisories** →
   **"Report a vulnerability"**
   (directly: `https://github.com/sufirumii/lester/security/advisories/new`).
2. Describe the issue, reproduction steps and impact. Proof-of-concept code is
   welcome — but **redact any real prompt content or PII** first.
3. You will receive an acknowledgement within a few days, and a fix timeline
   once the report has been triaged.

Please allow time for a fix and a release before public disclosure.
Coordinated disclosure is credited in the release notes if you wish.

For non-security bugs, use the issue tracker and the bug-report template —
see [`.github/ISSUE_TEMPLATE/bug_report.md`](.github/ISSUE_TEMPLATE/bug_report.md).

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

Only the latest patch release of the current minor line (1.0.x) receives
security fixes.

## What counts as a security issue

Lester's core promises are privacy, auditability and integrity. Reports in
these categories are treated as security issues (the list is not exhaustive):

- **Authentication / authorization bypass** — reaching the Console, API or
  admin functions without valid credentials; member or auditor acting with
  admin rights; IDOR on any object ID.
- **Proof-ledger forgery** — any way to add, edit or delete ledger entries
  without detection, forge a checkpoint or an Ed25519 signature, or make a
  tampered chain verify as intact.
- **Egress despite policy** — content leaving the machine when the workspace
  policy says LOCAL_ONLY or BLOCK_ALL, through any channel (API, DNS,
  referrers, third-party assets, engine URL tricks).
- **SSRF** — engine/provider URLs reaching loopback, RFC1918, link-local or
  cloud-metadata endpoints that the SSRF guard should have blocked.
- **Data loss** — any operation that can destroy or corrupt the database,
  backups or key material without a safety net (backup/snapshot first).

If you are unsure whether something is a security issue, report it privately
anyway — it can always be reclassified.

## Threat model (summary)

Lester assumes the operator controls the host and defends against the biggest
real risk: **data leaving quietly**. It protects **confidentiality** (prompts
stay local; PII/secret redaction before dispatch), **auditability** (every
request lands in a tamper-evident, hash-chained Proof ledger with signed
exports verifiable offline) and **integrity** (retroactive edits are detected
and pinpointed; backups are checksummed and restore is refuse-on-mismatch).
Cloud fallback is off by default and needs two explicit switches; telemetry is
absent, not disabled. The full threat model — secure defaults, data
protection, integrity, egress honesty and honest scope limits — lives in
[docs/SECURITY.md](docs/SECURITY.md); operator hardening guidance is in
[DEPLOY.md](DEPLOY.md).
