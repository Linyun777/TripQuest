// Local development: the web app plus, when durable tasks are on, the task worker.
// One terminal, one Ctrl+C; if either process exits, the other is stopped too.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";

if (existsSync(".env")) process.loadEnvFile(".env");
const withWorker = process.env.PLANNING_TASKS_ENABLED === "true";

const children = [];
let stopping = false;

function start(name, command, args) {
  // Each child leads its own process group, so stopping it also stops what it started
  // (pnpm → next dev → next-server). Otherwise next-server outlives us and keeps port 3000.
  const child = spawn(command, args, { stdio: "inherit", env: process.env, detached: true });
  child.on("exit", (code) => {
    if (!stopping) console.log(`[dev] ${name} exited (${code ?? "signal"}); stopping the rest.`);
    stopAll();
    process.exitCode = code ?? 0;
  });
  children.push(child);
}

function stopAll() {
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

// Ctrl+C, kill, or closing the terminal window (SIGHUP) all stop every child group.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, stopAll);
}
process.on("exit", stopAll);

if (withWorker) {
  const build = spawnSync("pnpm", ["--filter", "@tripquest/worker", "build"], { stdio: "inherit" });
  if (build.status !== 0) process.exit(build.status ?? 1);
  start("worker", "node", ["apps/worker/dist/worker.js"]);
} else {
  console.log("[dev] PLANNING_TASKS_ENABLED is not true: no worker, drafts stream in-request.");
}
const webArgs = process.argv.includes("--https") ? httpsArgs() : [];
start("web", "pnpm", ["--filter", "@tripquest/web", "dev", ...webArgs]);

// `pnpm dev:https`: browsers only give a phone its location over HTTPS. A self-signed
// certificate for this computer's LAN addresses (made once per address set, kept in the
// ignored .certificates/), so the phone accepts one warning and nothing is installed.
function httpsArgs() {
  const lan = Object.values(networkInterfaces()).flat()
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  const hosts = ["localhost", "127.0.0.1", ...lan];
  const dir = resolve(".certificates");
  const key = resolve(dir, "lan-key.pem");
  const cert = resolve(dir, "lan.pem");
  const stamp = resolve(dir, "hosts.txt");
  if (!existsSync(stamp) || readFileSync(stamp, "utf8") !== hosts.join(",")) {
    mkdirSync(dir, { recursive: true });
    const names = hosts.map((host) => (/^[\d.]+$/.test(host) ? `IP:${host}` : `DNS:${host}`)).join(",");
    const made = spawnSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "365",
      "-keyout", key, "-out", cert, "-subj", "/CN=TripQuest local",
      "-addext", `subjectAltName=${names}`,
      "-addext", "extendedKeyUsage=serverAuth",
    ], { stdio: ["ignore", "ignore", "inherit"] });
    if (made.status !== 0) process.exit(made.status ?? 1);
    writeFileSync(stamp, hosts.join(","));
  }
  // Wi-Fi first (en0/en1 on a Mac); the others are VMs and VPNs.
  const wifi = ["en0", "en1"].flatMap((name) => networkInterfaces()[name] ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  for (const address of wifi.length ? wifi : lan) {
    console.log(`[dev] On a phone in the same Wi-Fi: https://${address}:${process.env.PORT ?? 3000}`);
  }
  // Next blocks its dev resources (hot reload) for other hosts; allow only these addresses.
  process.env.TRIPQUEST_DEV_ORIGINS = lan.join(",");
  return ["--experimental-https", "--experimental-https-key", key, "--experimental-https-cert", cert, "--hostname", "0.0.0.0"];
}
