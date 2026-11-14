import { db } from "./db";
import { resolveTarget, chatOnce, EngineTarget } from "@/lib/engine";
import { appendProof } from "./proof";

/**
 * Lester Fit — runs the customer's own prompts against candidate models,
 * measures latency/tokens/quality (LLM-as-judge), and computes cost saved
 * from user-provided pricing assumptions. Measured vs assumed is always
 * visually separated in the results.
 */

export interface FitConfig {
  requestsPerMonth: number;
  pricePerMillionIn: number; // the customer's actual cloud pricing — an assumption, editable
  pricePerMillionOut: number;
  hardwareMonthlyCost: number; // amortized on-prem cost, optional
  judge: boolean;
}

export interface SampleRow {
  promptIdx: number;
  modelKey: string;
  ok: boolean;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  chars: number;
  quality: number | null;
  error?: string;
}

export interface CandidateResult {
  modelKey: string;
  label: string;
  provider: string;
  egress: string;
  ok: number;
  failed: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  tokensPerSec: number;
  avgTokensIn: number;
  avgTokensOut: number;
  avgQuality: number | null;
  successRate: number;
}

export interface FitSummary {
  measured: {
    prompts: number;
    avgTokensIn: number;
    avgTokensOut: number;
    avgLatencyMs: number;
    tokensPerSec: number;
    avgQuality: number | null;
    successRate: number;
  };
  assumptions: FitConfig;
  monthlyCloudCost: number;
  monthlyLocalCost: number;
  monthlySaved: number;
  verdict: string;
}

const MIN_PROMPTS = 20;
const MAX_PROMPTS = 200;

const g = globalThis as unknown as { lesterFitJobs?: Map<string, { cancel: boolean }> };

export function validatePrompts(prompts: string[]): string | null {
  const trimmed = prompts.map((p) => p.trim()).filter(Boolean);
  if (trimmed.length < MIN_PROMPTS) return `Fit needs at least ${MIN_PROMPTS} real prompts (you provided ${trimmed.length}). Between ${MIN_PROMPTS} and ${MAX_PROMPTS} gives meaningful results.`;
  if (trimmed.length > MAX_PROMPTS) return `Fit accepts at most ${MAX_PROMPTS} prompts per run (you provided ${trimmed.length}).`;
  return null;
}

export async function startFitRun(input: {
  userId: string;
  username: string;
  prompts: string[];
  candidates: string[];
  config: FitConfig;
}): Promise<string> {
  const prompts = input.prompts.map((p) => p.trim()).filter(Boolean);
  const invalid = validatePrompts(prompts);
  if (invalid) throw new Error(invalid);
  if (input.candidates.length === 0) throw new Error("Select at least one candidate model.");
  const total = prompts.length * input.candidates.length;
  const run = await db.fitRun.create({
    data: {
      userId: input.userId,
      status: "queued",
      prompts: JSON.stringify(prompts),
      candidates: JSON.stringify(input.candidates),
      config: JSON.stringify(input.config),
      total,
      progress: 0,
    },
  });
  await appendProof({
    userId: input.userId,
    username: input.username,
    action: "fit.run",
    status: "ok",
    detail: { runId: run.id, prompts: prompts.length, candidates: input.candidates },
  });
  if (!g.lesterFitJobs) g.lesterFitJobs = new Map();
  g.lesterFitJobs.set(run.id, { cancel: false });
  void executeRun(run.id).catch(async (e) => {
    await db.fitRun
      .update({ where: { id: run.id }, data: { status: "error", error: e instanceof Error ? e.message : String(e) } })
      .catch(() => undefined);
  });
  return run.id;
}

export function cancelFitRun(runId: string): boolean {
  const job = g.lesterFitJobs?.get(runId);
  if (!job) return false;
  job.cancel = true;
  return true;
}

/** LLM-as-judge: score a response 1–5 on the local engine. Measured, not invented. */
async function judgeScore(judgeTarget: EngineTarget | null, prompt: string, response: string): Promise<number | null> {
  if (!judgeTarget) return null;
  const sys =
    "You are a strict evaluator. Rate the assistant's response to the user's request on a 1-5 integer scale. 5 = fully addresses the request accurately and completely, 3 = partially useful, 1 = fails. Reply with ONLY the digit.";
  const user = `Request: ${prompt}\n\nResponse: ${response}`;
  try {
    const r = await chatOnce(
      judgeTarget,
      [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      { maxTokens: 8, allowExternal: judgeTarget.kind === "cloud" }
    );
    const m = r.content.trim().match(/^[^0-9]*([1-5])/);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

async function executeRun(runId: string): Promise<void> {
  const run = await db.fitRun.findUnique({ where: { id: runId } });
  if (!run) return;
  const prompts = JSON.parse(run.prompts) as string[];
  const candidates = JSON.parse(run.candidates) as string[];
  const config = JSON.parse(run.config) as FitConfig;
  const job = g.lesterFitJobs?.get(runId);
  const samples: SampleRow[] = [];
  const contents = new Map<string, string>(); // `${promptIdx}:${modelKey}` → response text (in-memory only)

  await db.fitRun.update({ where: { id: runId }, data: { status: "running" } });
  let progress = 0;

  const targets = new Map<string, EngineTarget | null>();
  for (const modelKey of candidates) {
    targets.set(modelKey, await resolveTarget(modelKey).catch(() => null));
    if (!targets.get(modelKey)) {
      for (let i = 0; i < prompts.length; i++) {
        samples.push({ promptIdx: i, modelKey, ok: false, latencyMs: 0, tokensIn: 0, tokensOut: 0, chars: 0, quality: null, error: "model unavailable on this node" });
      }
      progress += prompts.length;
      await db.fitRun.update({ where: { id: runId }, data: { progress, samples: JSON.stringify(samples) } });
    }
  }

  for (const modelKey of candidates) {
    const target = targets.get(modelKey) ?? null;
    if (!target) continue;
    const allowExternal = target.kind === "cloud"; // explicit: cloud baseline candidates
    for (let i = 0; i < prompts.length; i++) {
      if (job?.cancel) {
        await db.fitRun.update({ where: { id: runId }, data: { status: "cancelled", samples: JSON.stringify(samples) } });
        return;
      }
      const row: SampleRow = { promptIdx: i, modelKey, ok: false, latencyMs: 0, tokensIn: 0, tokensOut: 0, chars: 0, quality: null };
      try {
        const res = await chatOnce(target, [{ role: "user", content: prompts[i] }], { maxTokens: 512, allowExternal });
        row.ok = res.content.trim().length > 0;
        row.latencyMs = res.latencyMs;
        row.tokensIn = res.usage.promptTokens;
        row.tokensOut = res.usage.completionTokens;
        row.chars = res.content.length;
        contents.set(`${i}:${modelKey}`, res.content);
      } catch (e) {
        row.error = e instanceof Error ? e.message.slice(0, 200) : "request failed";
      }
      samples.push(row);
      progress++;
      if (progress % 5 === 0 || progress === run.total) {
        await db.fitRun.update({ where: { id: runId }, data: { progress, samples: JSON.stringify(samples) } });
      }
    }
  }

  // Judge step — LLM-as-judge scoring on the first available candidate's engine.
  if (config.judge) {
    const judgeTarget = targets.get(candidates[0]) ?? null;
    if (judgeTarget) {
      for (const row of samples) {
        if (job?.cancel) break;
        if (!row.ok) continue;
        const response = contents.get(`${row.promptIdx}:${row.modelKey}`);
        if (!response) continue;
        row.quality = await judgeScore(judgeTarget, prompts[row.promptIdx], response);
      }
      await db.fitRun.update({ where: { id: runId }, data: { samples: JSON.stringify(samples) } });
    }
  }

  await finalize(runId, prompts, candidates, config, samples);
}

async function finalize(
  runId: string,
  prompts: string[],
  candidates: string[],
  config: FitConfig,
  samples: SampleRow[]
): Promise<void> {
  const results: CandidateResult[] = [];
  for (const modelKey of candidates) {
    const rows = samples.filter((s) => s.modelKey === modelKey);
    const okRows = rows.filter((r) => r.ok);
    const latencies = okRows.map((r) => r.latencyMs).sort((a, b) => a - b);
    const totalTokensOut = okRows.reduce((a, r) => a + r.tokensOut, 0);
    const totalMs = okRows.reduce((a, r) => a + r.latencyMs, 0);
    const qualities = rows.map((r) => r.quality).filter((q): q is number => q !== null);
    const entry = await db.modelEntry.findUnique({ where: { key: modelKey } });
    const measuredEgress = entry ? (modelKey.startsWith("cloud") ? "external" : "loopback") : "unknown";
    results.push({
      modelKey,
      label: entry?.name ?? modelKey,
      provider: entry?.provider ?? "unknown",
      egress: measuredEgress,
      ok: okRows.length,
      failed: rows.length - okRows.length,
      avgLatencyMs: okRows.length ? Math.round(okRows.reduce((a, r) => a + r.latencyMs, 0) / okRows.length) : 0,
      p95LatencyMs: latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : 0,
      tokensPerSec: totalMs > 0 ? +((totalTokensOut / totalMs) * 1000).toFixed(1) : 0,
      avgTokensIn: okRows.length ? Math.round(okRows.reduce((a, r) => a + r.tokensIn, 0) / okRows.length) : 0,
      avgTokensOut: okRows.length ? Math.round(totalTokensOut / okRows.length) : 0,
      avgQuality: qualities.length ? +(qualities.reduce((a, q) => a + q, 0) / qualities.length).toFixed(2) : null,
      successRate: rows.length ? +((okRows.length / rows.length) * 100).toFixed(1) : 0,
    });
  }

  const localRows = samples.filter((s) => !s.modelKey.startsWith("cloud"));
  const okLocal = localRows.filter((r) => r.ok);
  const avgTokensIn = okLocal.length ? okLocal.reduce((a, r) => a + r.tokensIn, 0) / okLocal.length : 0;
  const avgTokensOut = okLocal.length ? okLocal.reduce((a, r) => a + r.tokensOut, 0) / okLocal.length : 0;
  const avgLatencyMs = okLocal.length ? Math.round(okLocal.reduce((a, r) => a + r.latencyMs, 0) / okLocal.length) : 0;
  const totalTokensOutLocal = okLocal.reduce((a, r) => a + r.tokensOut, 0);
  const totalMsLocal = okLocal.reduce((a, r) => a + r.latencyMs, 0);
  const tokensPerSec = totalMsLocal > 0 ? +(totalTokensOutLocal / totalMsLocal * 1000).toFixed(1) : 0;
  const qualities = localRows.map((r) => r.quality).filter((q): q is number => q !== null);
  const monthlyCloudCost =
    ((avgTokensIn / 1e6) * config.pricePerMillionIn + (avgTokensOut / 1e6) * config.pricePerMillionOut) *
    config.requestsPerMonth;
  const monthlyLocalCost = config.hardwareMonthlyCost;
  const monthlySaved = monthlyCloudCost - monthlyLocalCost;
  const summary: FitSummary = {
    measured: {
      prompts: prompts.length,
      avgTokensIn: Math.round(avgTokensIn),
      avgTokensOut: Math.round(avgTokensOut),
      avgLatencyMs,
      tokensPerSec,
      avgQuality: qualities.length ? +(qualities.reduce((a, q) => a + q, 0) / qualities.length).toFixed(2) : null,
      successRate: localRows.length ? +((okLocal.length / localRows.length) * 100).toFixed(1) : 0,
    },
    assumptions: config,
    monthlyCloudCost: +monthlyCloudCost.toFixed(2),
    monthlyLocalCost: +monthlyLocalCost.toFixed(2),
    monthlySaved: +monthlySaved.toFixed(2),
    verdict:
      monthlySaved > 0
        ? `ESTIMATE (from your assumptions, not a measurement): at your cloud pricing this workload would cost ≈$${monthlyCloudCost.toFixed(0)}/month; running locally saves ≈$${monthlySaved.toFixed(0)}/month under your inputs. Latency/tokens/quality are measured on ${prompts.length} of your prompts at ${tokensPerSec || "—"} tok/s.`
        : `ESTIMATE (from your assumptions, not a measurement): local execution did not save money under the pricing inputs you provided. Latency/tokens/quality are measured; cost figures are assumptions — edit them above.`,
  };
  await db.fitRun.update({
    where: { id: runId },
    data: { status: "done", results: JSON.stringify(results), summary: JSON.stringify(summary), samples: JSON.stringify(samples) },
  });
}
