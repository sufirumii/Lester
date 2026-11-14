import { db } from "./db";

/**
 * On-device knowledge retrieval. Chunking + BM25 — no embeddings service,
 * no network, fully local and deterministic.
 */

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "of", "at", "by", "for", "with", "about",
  "into", "to", "from", "in", "on", "is", "are", "was", "were", "be", "been", "being", "have",
  "has", "had", "do", "does", "did", "will", "would", "shall", "should", "can", "could", "may",
  "might", "must", "this", "that", "these", "those", "it", "its", "as", "not", "no", "you",
  "your", "we", "our", "they", "their", "he", "she", "his", "her", "i", "me", "my",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export interface ChunkData {
  docId: string;
  docName: string;
  idx: number;
  content: string;
  tokens: string[];
}

const indexCache = new Map<string, { at: number; chunks: ChunkData[] }>();
const INDEX_TTL = 30_000;

async function loadIndex(workspaceId: string): Promise<ChunkData[]> {
  const cached = indexCache.get(workspaceId);
  if (cached && Date.now() - cached.at < INDEX_TTL) return cached.chunks;
  const docs = await db.document.findMany({ where: { workspaceId }, include: { chunks: { orderBy: { idx: "asc" } } } });
  const chunks: ChunkData[] = [];
  for (const doc of docs) {
    for (const c of doc.chunks) {
      chunks.push({ docId: doc.id, docName: doc.name, idx: c.idx, content: c.content, tokens: tokenize(c.content) });
    }
  }
  indexCache.set(workspaceId, { at: Date.now(), chunks });
  return chunks;
}

export function invalidateIndex(workspaceId?: string) {
  if (workspaceId) indexCache.delete(workspaceId);
  else indexCache.clear();
}

/** Split text into overlapping chunks, preferring paragraph boundaries. */
export function chunkText(text: string, target = 900, overlap = 120): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= target) return [clean];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + target, clean.length);
    if (end < clean.length) {
      // prefer breaking at sentence/paragraph within the last 40%
      const window = clean.slice(start, end);
      let cut = -1;
      const lastPara = window.lastIndexOf("\n\n");
      const lastSent = window.lastIndexOf(". ");
      if (lastPara > target * 0.6) cut = lastPara;
      else if (lastSent > target * 0.6) cut = lastSent + 1;
      if (cut > 0) end = start + cut;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

export interface SearchHit {
  docId: string;
  docName: string;
  chunkIdx: number;
  snippet: string;
  score: number;
}

/** BM25 ranking over the workspace's local chunks. */
export async function search(workspaceId: string, query: string, k = 4): Promise<SearchHit[]> {
  const chunks = await loadIndex(workspaceId);
  if (chunks.length === 0) return [];
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];

  const N = chunks.length;
  const avgLen = chunks.reduce((a, c) => a + c.tokens.length, 0) / N;
  const df = new Map<string, number>();
  for (const t of qTokens) {
    let n = 0;
    for (const c of chunks) if (c.tokens.includes(t)) n++;
    df.set(t, n);
  }
  const k1 = 1.5;
  const b = 0.75;
  const hits: SearchHit[] = chunks.map((c) => {
    let score = 0;
    const tf = new Map<string, number>();
    for (const t of c.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of qTokens) {
      const f = tf.get(t) ?? 0;
      if (f === 0) continue;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * c.tokens.length) / avgLen)));
    }
    return {
      docId: c.docId,
      docName: c.docName,
      chunkIdx: c.idx,
      snippet: c.content.length > 240 ? `${c.content.slice(0, 240)}…` : c.content,
      score: +score.toFixed(3),
    };
  });
  return hits
    .filter((h) => h.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, k);
}

export const SUPPORTED_UPLOAD_TYPES: Record<string, string> = {
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
  "application/octet-stream": "bin", // resolved by extension below
};

export function isSupportedUpload(filename: string, mime: string): boolean {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (["txt", "md", "csv", "json", "log"].includes(ext)) return true;
  return ["text/plain", "text/markdown", "text/csv", "application/json"].includes(mime);
}
