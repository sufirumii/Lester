# Contributing to Lester

Lester is a private AI control plane — its product *is* its integrity. Two
policies in this document are non-negotiable: **honest claims** and **zero
telemetry**. Everything else is normal engineering.

Questions, bug reports and feature ideas start in the
[issue tracker](https://github.com/sufirumii/lester/issues); security reports
go privately as described in [SECURITY.md](SECURITY.md).

## Setting up

The only toolchain you need is [Bun](https://bun.sh) ≥ 1.3.14 — no Node, no
npm, nothing else.

```bash
git clone https://github.com/sufirumii/lester.git
cd lester
bun install
```

Everything works with the safe defaults (loopback-only bind, no engine
required to boot). Optionally copy `env.example` to `.env` to change
boot-time behavior — never commit `.env`:

```bash
cp env.example .env     # optional
```

## The dev loop

```bash
bun run dev             # Next.js dev server on http://localhost:3000
```

The Console is a single-page app served at `/`; the API lives under
`src/app/api/`. On first run the Setup wizard walks you through creating the
admin account. Point the engine at a real local server (Ollama, LM Studio,
llama.cpp, vLLM) via `.env` (`LESTER_ENGINE`, `LESTER_ENGINE_URL`) or leave
`LESTER_ENGINE=none` and configure it later in Settings.

## Before you open a PR

There is no hosted CI in this repository (GitHub's web uploader drops dotfiles,
so `.github/` is not shipped — see the web-upload note below). Run the gates
locally first:

```bash
bun run lint            # eslint .
bunx tsc --noEmit       # typecheck; must be clean (build has ignoreBuildErrors: false)
bun run test            # full test suite
```

### Testing

```bash
bun run test
```

The runner (`scripts/cli.ts test`) gives **each test file its own process**:
every file sets its own `DATABASE_URL` at import time, so files must not
share a process. Add new tests as `tests/<name>.test.ts` — the runner picks
them up automatically.

The suite boots the real server and a deterministic fake OpenAI-compatible
engine on `127.0.0.1` (`tests/helpers.ts`), so it needs no GPU
and downloads no models — it runs on plain CI runners.

### Database migrations — NEVER `db push`

User data must survive every upgrade. The workflow is:

1. Edit `prisma/schema.prisma`.
2. Create the SQL migration by hand:
   `prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql`
   (see `0_init` and `20260115000000_v101_tokens_throttle_proof` for the
   format — plain SQL, forward-only, no destructive statements).
3. Apply with `bun run migrate` — it takes an automatic **pre-upgrade
   backup** before touching anything and refuses to run destructively.

`prisma db push` is banned in this repository (and `--accept-data-loss`
doubly so): it can silently destroy data and desynchronizes the migration
history. `tests/unit-core.test.ts` (migrations group) fails if the schema and the migration
history drift apart.

### License dev keys

Production builds verify licenses against the vendor public key pinned in
`src/lib/license.ts` (VENDOR_LICENSE_PUB_HEX). To test license activation locally,
generate a development keypair that overrides the pinned key in your `.env`:

```bash
bun run license:devkey
```

This writes `LESTER_LICENSE_PUB` into `.env` (gitignored) and a private key
into `db/keys/` (also gitignored). Remove the override to verify against the
pinned vendor key again. Never commit a dev key.

## The honest-claims policy

1. **Every claim must be tested.** If the code or the docs claim it — "zero
   egress", "tamper-evident", "cross-platform", "works offline" — a test (or
   a measured, reproducible procedure) must demonstrate it. If it can't be
   tested, it must not be claimed; state plainly what is and isn't true.
   README and marketing-site claims follow the same rule as code comments.
2. **No telemetry. Ever.** No analytics, crash reporting, update pings,
   beacons, third-party CDNs or fonts, or any "phone home". Lester makes no
   outbound requests except the engines/providers the admin configures —
   that's the product's core promise. If your change needs a new outbound
   request, open an issue and discuss the design first.

PRs are expected to show real command output under "How it was tested" — the
commands you ran (`bun run lint`, `bunx tsc --noEmit`, `bun run test`), their
result, and any manual verification steps.

### Uploading the repository via GitHub's web UI

The repository is deliberately shaped for GitHub's web uploader — under 100
files (its per-drag limit), **no dotfiles** (the OS hides them from a plain
folder drag, so the release ZIP ships none; `install.sh` / `install.ps1`
recreate `.gitignore` / `.dockerignore` locally when missing) and **no `[` or
`]` in any path** (the uploader rejects bracket-named route directories such
as `[[...route]]` / `[id]` with "Something went really wrong, and we can't
process that file" and silently drops every file queued after it — which is
why the API is served by one plain route file, `src/app/api/route.ts`, with
`/api/*` mapped onto it by a rewrite in `next.config.ts`).

To upload: extract the release ZIP, open the `lester-v1.0.4` folder, select
all (Ctrl/Cmd+A) and drag the **contents** (not the folder itself) into the
repository's "Upload files" page. Every file is visible and uploadable, so
the count shown in the dialog must match the ZIP's file count exactly before
you commit — if it does, nothing was dropped.

## Sign-off

Use the DCO sign-off on every commit:

```bash
git commit -s
```

which appends a line like:

```
Signed-off-by: Jane Doe <jane@example.com>
```

By signing off you certify that you wrote the contribution or otherwise
have the right to submit it under the project's Apache-2.0 license (see
[LICENSE](LICENSE)).

## Code of conduct

By participating in this project you agree to uphold the code of conduct below.
Be excellent to each other.

<!-- Merged verbatim from the former CODE_OF_CONDUCT.md (v1.0.2 consolidation). -->

---

# Contributor Covenant Code of Conduct

## Our Pledge

We as members, contributors, and leaders pledge to make participation in our
community a harassment-free experience for everyone, regardless of age, body
size, visible or invisible disability, ethnicity, sex characteristics, gender
identity and expression, level of experience, education, socio-economic status,
nationality, personal appearance, race, caste, color, religion, or sexual
identity and orientation.

We pledge to act and interact in ways that contribute to an open, welcoming,
diverse, inclusive, and healthy community.

## Our Standards

Examples of behavior that contributes to a positive environment for our
community include:

* Demonstrating empathy and kindness toward other people
* Being respectful of differing opinions, viewpoints, and experiences
* Giving and gracefully accepting constructive feedback
* Accepting responsibility and apologizing to those affected by our mistakes,
  and learning from the experience
* Focusing on what is best not just for us as individuals, but for the overall
  community

Examples of unacceptable behavior include:

* The use of sexualized language or imagery, and sexual attention or advances
  of any kind
* Trolling, insulting or derogatory comments, and personal or political attacks
* Public or private harassment
* Publishing others' private information, such as a physical or email address,
  without their explicit permission
* Other conduct which could reasonably be considered inappropriate in a
  professional setting

## Enforcement Responsibilities

Community leaders are responsible for clarifying and enforcing our standards of
acceptable behavior and will take appropriate and fair corrective action in
response to any behavior that they deem inappropriate, threatening, offensive,
or harmful.

Community leaders have the right and responsibility to remove, edit, or reject
comments, commits, code, wiki edits, issues, and other contributions that are
not aligned to this Code of Conduct, and will communicate reasons for moderation
decisions when appropriate.

## Scope

This Code of Conduct applies within all community spaces, and also applies when
an individual is officially representing the community in public spaces.
Examples of representing our community include using an official email address,
posting via an official social media account, or acting as an appointed
representative at an online or offline event.

## Enforcement

Instances of abusive, harassing, or otherwise unacceptable behavior may be
reported to the community leaders responsible for enforcement via GitHub
([@sufirumii](https://github.com/sufirumii)) — the project maintainer's contact
method. All complaints will be reviewed and investigated promptly and fairly.

All community leaders are obligated to respect the privacy and security of the
reporter of any incident.

## Enforcement Guidelines

Community leaders will follow these Community Impact Guidelines in determining
the consequences for any action they deem in violation of this Code of Conduct:

### 1. Correction

**Community Impact**: Use of inappropriate language or other behavior deemed
unprofessional or unwelcome in the community.

**Consequence**: A private, written warning from community leaders, providing
clarity around the nature of the violation and an explanation of why the
behavior was inappropriate. A public apology may be requested.

### 2. Warning

**Community Impact**: A violation through a single incident or series of
actions.

**Consequence**: A warning with consequences for continued behavior. No
interaction with the people involved, including unsolicited interaction with
those enforcing the Code of Conduct, for a specified period of time. This
includes avoiding interactions in community spaces as well as external channels
like social media. Violating these terms may lead to a temporary or permanent
ban.

### 3. Temporary Ban

**Community Impact**: A serious violation of community standards, including
sustained inappropriate behavior.

**Consequence**: A temporary ban from any sort of interaction or public
communication with the community for a specified period of time. No public or
private interaction with the people involved, including unsolicited interaction
with those enforcing the Code of Conduct, is allowed during this period.
Violating these terms may lead to a permanent ban.

### 4. Permanent Ban

**Community Impact**: Demonstrating a pattern of violation of community
standards, including sustained inappropriate behavior, harassment of an
individual, or aggression toward or disparagement of classes of individuals.

**Consequence**: A permanent ban from any sort of public interaction within
the community.

## Attribution

This Code of Conduct is adapted from the [Contributor Covenant][homepage],
version 2.1, available at
[https://www.contributor-covenant.org/version/2/1/code_of_conduct.html][v2.1].

Community Impact Guidelines were inspired by
[Mozilla's code of conduct enforcement ladder][Mozilla CoC].

For answers to common questions about this code of conduct, see the FAQ at
[https://www.contributor-covenant.org/faq][FAQ]. Translations are available at
[https://www.contributor-covenant.org/translations][translations].

[homepage]: https://www.contributor-covenant.org
[v2.1]: https://www.contributor-covenant.org/version/2/1/code_of_conduct.html
[Mozilla CoC]: https://github.com/mozilla/diversity
[FAQ]: https://www.contributor-covenant.org/faq
[translations]: https://www.contributor-covenant.org/translations
