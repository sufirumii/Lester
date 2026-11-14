import os from "node:os";
import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import path from "node:path";
import { LESTER } from "./env";

export interface HardwareProfile {
  os: string;
  arch: string;
  cpu: { model: string; cores: number; speedMhz: number };
  ram: { totalMb: number; freeMb: number; usedPct: number };
  disk: { totalGb: number; freeGb: number; usedPct: number; path: string };
  gpus: { name: string; vramMb: number | null }[];
  npuDetected: boolean;
  scannedAt: string;
}

/**
 * Cross-platform hardware detection. All shell tools are invoked with
 * execFile + argument arrays — never a shell string (S6). Every probe has a
 * timeout and degrades gracefully to "not detected".
 */
function run(cmd: string, args: string[], timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        resolve(err ? null : stdout.trim());
      });
    } catch {
      resolve(null);
    }
  });
}

let cachedStatic: Omit<HardwareProfile, "ram" | "disk" | "scannedAt"> | null = null;

async function detectGpus(): Promise<{ name: string; vramMb: number | null }[]> {
  const gpus: { name: string; vramMb: number | null }[] = [];
  const platform = os.platform();

  if (platform !== "win32") {
    // NVIDIA — present on Linux and macOS (eGPU) where installed.
    const nvidia = await run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
    if (nvidia) {
      for (const line of nvidia.split("\n")) {
        const parts = line.split(",");
        if (parts[0]?.trim()) {
          gpus.push({
            name: parts[0].trim(),
            vramMb: parts[1] ? Math.round(parseFloat(parts[1].trim())) : null,
          });
        }
      }
    }
  } else {
    // Windows: CIM is more reliable than the deprecated wmic.
    const out = await run("powershell", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress",
    ], 6000);
    if (out) {
      try {
        const parsed = JSON.parse(out) as Array<{ Name?: string; AdapterRAM?: number }> | { Name?: string; AdapterRAM?: number };
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const g of list) {
          if (g.Name) gpus.push({ name: g.Name, vramMb: typeof g.AdapterRAM === "number" ? Math.round(g.AdapterRAM / 1024 / 1024) : null });
        }
      } catch {
        // malformed output — ignore
      }
    }
  }

  if (gpus.length === 0 && platform === "darwin") {
    // Apple silicon / Intel Macs: the GPU is part of the SoC; unified memory
    // means vramMb is meaningless, so we report the chip instead.
    const prof = await run("system_profiler", ["SPDisplaysDataType"], 6000);
    if (prof) {
      const chip = prof.split("\n").map((l) => l.trim()).find((l) => l.startsWith("Chipset Model:"));
      if (chip) gpus.push({ name: chip.replace("Chipset Model:", "").trim(), vramMb: null });
    }
  }

  if (gpus.length === 0 && platform === "linux") {
    // AMD/Intel via rocm-smi or glxinfo, best-effort.
    const rocm = await run("rocm-smi", ["--showproductname", "--csv"]);
    if (rocm) {
      const card = rocm.split("\n").find((l) => l.toLowerCase().includes("card series"));
      if (card) gpus.push({ name: card.split(",").pop()?.trim() ?? "AMD GPU (rocm)", vramMb: null });
    }
  }

  return gpus;
}

async function detectStatic() {
  if (cachedStatic) return cachedStatic;
  const cpus = os.cpus();
  const gpus = await detectGpus();
  cachedStatic = {
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpu: { model: cpus[0]?.model ?? "Unknown CPU", cores: cpus.length, speedMhz: Math.round((cpus[0]?.speed ?? 0) * 1000) },
    gpus,
    npuDetected: false, // no portable, reliable NPU probe exists; never guessed
  };
  return cachedStatic;
}

async function diskUsage(p: string): Promise<{ totalGb: number; freeGb: number; usedPct: number }> {
  try {
    const st = await statfs(p);
    const total = Number(st.blocks) * Number(st.bsize);
    const free = Number(st.bavail) * Number(st.bsize);
    if (total > 0) {
      return { totalGb: +(total / 1024 ** 3).toFixed(1), freeGb: +(free / 1024 ** 3).toFixed(1), usedPct: +(((total - free) / total) * 100).toFixed(1) };
    }
  } catch {
    // statfs unsupported on this platform — fall through to platform tools
  }
  const platform = os.platform();
  if (platform !== "win32") {
    const df = await run("df", ["-k", p]);
    if (df) {
      const parts = df.split("\n")[1]?.trim().split(/\s+/) ?? [];
      const total = parseInt(parts[1] ?? "0", 10) * 1024;
      const free = parseInt(parts[3] ?? "0", 10) * 1024;
      if (total > 0) return { totalGb: +(total / 1024 ** 3).toFixed(1), freeGb: +(free / 1024 ** 3).toFixed(1), usedPct: +(((total - free) / total) * 100).toFixed(1) };
    }
  } else {
    const out = await run("powershell", [
      "-NoProfile",
      "-Command",
      `$d = Get-PSDrive -Name "${p.slice(0, 1)}"; Write-Output "$($d.Used) $($d.Free)"`,
    ], 6000);
    if (out) {
      const [used, free] = out.split(/\s+/).map(Number);
      const total = (used || 0) + (free || 0);
      if (total > 0) return { totalGb: +(total / 1024 ** 3).toFixed(1), freeGb: +((free || 0) / 1024 ** 3).toFixed(1), usedPct: +((used / total) * 100).toFixed(1) };
    }
  }
  return { totalGb: 0, freeGb: 0, usedPct: 0 };
}

export async function detectHardware(): Promise<HardwareProfile> {
  const staticInfo = await detectStatic();
  const totalMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeMb = Math.round(os.freemem() / 1024 / 1024);
  const disk = await diskUsage(path.dirname(LESTER.dataDir));
  return {
    ...staticInfo,
    ram: { totalMb, freeMb, usedPct: +(((totalMb - freeMb) / totalMb) * 100).toFixed(1) },
    disk: { ...disk, path: path.dirname(LESTER.dataDir) },
    scannedAt: new Date().toISOString(),
  };
}
