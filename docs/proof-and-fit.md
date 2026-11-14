# Proof and Fit

The two evidence features: the tamper-evident Proof ledger and the Lester Fit
evaluation. Merged in v1.0.2 from the former proof-and-verification and
fit-methodology guides (content unchanged).

<!-- ═════════════════════════════════════════════════════════════════ -->
# Proof and verification

# Proof and verification

## What the ledger records

Every request that reaches the pipeline — allowed, redacted, blocked or failed — appends
entries to an append-only SQLite table (`ProofEntry`). Each entry stores: actor, workspace,
action (`chat.request`, `chat.response`, `knowledge.upload`, `fit.run`, `model.install`,
`policy.update`, `auth.login`, `auth.fail`, `backup.create`, `backup.restore`,
`settings.update`, `user.create`, `proof.rehash`, …), status, model, provider, the
**DNS-resolved** endpoint host + IP + egress class (loopback / private / external / none),
latency, tokens, redaction count, and a metadata JSON (never prompt content, unless an admin
explicitly enabled content logging).

## The chain (hash v2)

```
selfHash(n) = SHA-256( prevHash(n-1) | seq(n) | ts(n) | canonicalJson(record(n)) )
```

Because `seq` and `ts` are inside the hash, five tamper modes are all detectable — and each
has an automated test:

| Tamper | Detected how |
|---|---|
| Edit an entry's content | selfHash mismatch at that seq |
| Delete a middle entry | prevHash link mismatch at seq+1 |
| Reorder entries | link + selfHash mismatches |
| Truncate the tail | chain head no longer matches the last signed checkpoint |
| Edit a timestamp | selfHash mismatch (v2 covers ts; v1.0.0 did not) |

Legacy v1.0.0 ledgers (hash without seq/ts) verify under v1 rules and are upgraded to v2 by
`rehashLegacyChain` — only after the whole v1 chain verifies, with the transition itself
Proof-logged as `proof.rehash`.

## Signed checkpoints

At every boot and every 6 hours, Lester signs the current head hash:

```
signature = Ed25519-sign("lester-checkpoint:{nodeId}:{seq}:{headHash}:{ts}")
```

Checkpoints appear in Health, in the Proof tab, and inside every exported report. **Why:**
someone with full disk access could rebuild and re-sign the whole chain. If you anchored a
checkpoint outside the host (emailed it, printed it, committed it to another repository), the
rewrite is detectable: the anchored checkpoint pins a head that the rewritten chain cannot
reproduce. Key rotation: `bun scripts/rotate-proof-key.ts` (old key archived — existing
exports keep verifying; the rotation is Proof-logged; checkpoints record which key signed
them via `keyId`).

## Exports

Proof tab → **Signed JSON** or **PDF** (auditor-friendly). The JSON contains: the entries with
their hashes and hash versions, the chain verification result, embedded checkpoints, the
node's Ed25519 public key, and an Ed25519 signature over the canonical payload.

## Offline verification

```bash
bun run proof:verify -- lester-proof-2026-11-14.json
```

Checks, in order:

1. the Ed25519 signature over the report payload with the embedded public key,
2. the full hash chain — recomputed exactly as the node did (v2 form for v2 entries, v1 form
   for legacy entries),
3. the embedded checkpoints' signatures.

Exit code 0 = verified. The verifier is a standalone script you can run on any machine — no
Lester install, no network.

## What an auditor should ask for

1. The signed JSON export for the review period.
2. One anchored checkpoint from outside the node (to detect whole-chain rewrites).
3. `bun run proof:verify` output on their own machine.
4. If content logging was enabled: be aware the ledger then contains the first 500 chars of
   prompts (amber-labeled in the Console) — request the Security tab screenshot as evidence of
   the setting.

<!-- ═════════════════════════════════════════════════════════════════ -->
# Fit methodology

# Fit methodology

## What Fit measures — and what it assumes

Lester Fit runs **your** prompts (20–200 of them) against candidate models through the normal
engine path (policy, redaction and Proof included). The summary splits the output into two
categories that are never blended:

**Measured** (real numbers from your hardware, your prompts):

- average / p95 latency per request
- tokens in / out per request
- throughput (tokens/sec of completion output)
- success rate
- quality (LLM-as-judge, 1–5, scored on the same node by the first candidate's engine;
  optional per run)

**Assumptions** (yours, editable before and after the run):

- `pricePerMillionIn` / `pricePerMillionOut` — your actual cloud pricing per million tokens
- `requestsPerMonth` — your expected volume
- `hardwareMonthlyCost` — amortized cost of running the local hardware, if you charge for it

## The cost-saved math (fully transparent)

```
monthlyCloudCost = (avgTokensIn  / 1e6 × pricePerMillionIn
                  + avgTokensOut / 1e6 × pricePerMillionOut) × requestsPerMonth
monthlyLocalCost = hardwareMonthlyCost
monthlySaved     = monthlyCloudCost − monthlyLocalCost
```

Everything on the right-hand side is either measured (tokens) or user-entered (prices,
volume, hardware cost). The verdict text labels itself an **ESTIMATE** and says which parts
were measured — because a cost claim is only as honest as its pricing inputs.

## Editing assumptions

The run configuration (pricing, volume, hardware cost) is editable in the Fit tab; the judge
toggle too. Re-running with different assumptions produces a new run with fresh measurements
(you can review old runs side by side).

## Limits, honestly stated

- Quality scores are LLM-as-judge on your node — useful for *relative* comparison between
  candidates, not absolute ground truth.
- Latency/throughput reflect your hardware at run time; a busy machine measures busy.
- The cost estimate assumes token distributions of your sample generalize to your workload.
  20 prompts is the minimum for signal; 100+ is better.
- No invented benchmarks appear anywhere: catalog sizes are public download sizes (≈),
  and every quality number in the product comes from a run you can see.
