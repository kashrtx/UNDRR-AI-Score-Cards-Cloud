#!/usr/bin/env node
/**
 * `npm run dev` launcher:
 *   1. Stops dev servers of THIS project left running from earlier runs (only
 *      processes whose working directory / command line is this folder and that
 *      listen on ports 3000-3010; other apps are never touched).
 *   2. Starts `next dev` (port 3000, or the next free one; PORT=… to force one).
 *   3. Opens the app in the default browser once it answers.
 *
 * Set NO_OPEN=1 to skip opening the browser. `npm run dev:plain` runs bare `next dev`.
 */

import { spawn, execFileSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_PORTS = Array.from({ length: 11 }, (_, i) => 3000 + i);
const isWin = process.platform === "win32";

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    return e.stdout?.toString() || ""; // lsof exits 1 when nothing matches
  }
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** PIDs listening on the scanned ports. */
function listeners() {
  const pids = new Set();
  if (isWin) {
    for (const line of run("netstat", ["-ano", "-p", "TCP"]).split(/\r?\n/)) {
      const m = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
      if (m && SCAN_PORTS.includes(Number(m[1]))) pids.add(Number(m[2]));
    }
  } else {
    for (const port of SCAN_PORTS) {
      for (const pid of run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).split(/\s+/)) {
        if (pid) pids.add(Number(pid));
      }
    }
  }
  return [...pids];
}

/** Does this process belong to this project? */
function isOurs(pid) {
  if (isWin) {
    const cmd = run("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`]);
    return cmd.toLowerCase().includes(ROOT.toLowerCase());
  }
  let cwd = "";
  try {
    cwd = readlinkSync(`/proc/${pid}/cwd`); // Linux
  } catch {
    const out = run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]); // macOS
    cwd = (out.split("\n").find((l) => l.startsWith("n")) || "").slice(1);
  }
  return !!cwd && samePath(cwd, ROOT);
}

/** The `next dev` parent of a next-server, so it can't restart the child. */
function parentOf(pid) {
  if (isWin) return null;
  const ppid = Number(run("ps", ["-o", "ppid=", "-p", String(pid)]).trim());
  if (!ppid) return null;
  const cmd = run("ps", ["-o", "command=", "-p", String(ppid)]);
  return /next(\.js)?\s+dev|next\/dist\/bin\/next|\.bin\/next/.test(cmd) ? ppid : null;
}

function kill(pid) {
  try {
    if (isWin) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

async function stopPreviousRuns() {
  const ours = listeners().filter((pid) => pid !== process.pid && isOurs(pid));
  if (!ours.length) return;
  const targets = new Set();
  for (const pid of ours) {
    targets.add(pid);
    const parent = parentOf(pid);
    if (parent) targets.add(parent);
  }
  for (const pid of targets) {
    if (kill(pid)) console.log(`[dev] Stopped a previous Scorecard Analyzer dev server (pid ${pid}).`);
  }
  // Wait for the port to free up.
  for (let i = 0; i < 20 && listeners().some((p) => targets.has(p)); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
}

function openBrowser(url) {
  if (process.env.NO_OPEN || process.env.CI) return console.log(`[dev] Ready at ${url}`);
  console.log(`[dev] Opening ${url}`);
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
    : isWin ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    console.log(`[dev] Open ${url} in your browser.`);
  }
}

async function waitAndOpen(url) {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(url, { method: "HEAD" });
      if (res.status < 500) return openBrowser(url);
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

await stopPreviousRuns();

// Let Next pick the port (it moves to 3001+ if 3000 belongs to another app) and
// read the real address from its own "Local: http://localhost:…" line.
const nextBin = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
const args = [nextBin, "dev", ...(process.env.PORT ? ["-p", process.env.PORT] : [])];
const child = spawn(process.execPath, args, {
  cwd: ROOT,
  stdio: ["inherit", "pipe", "inherit"],
  env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? "1" },
});
let opened = false;
child.stdout.on("data", (buf) => {
  process.stdout.write(buf);
  if (opened) return;
  const m = buf.toString().replace(/\x1b\[[0-9;]*m/g, "").match(/Local:\s+(http:\/\/\S+)/);
  if (m) {
    opened = true;
    void waitAndOpen(m[1]);
  }
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
