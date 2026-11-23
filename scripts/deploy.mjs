import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "env-file": { type: "string" },
    "override-file": { type: "string" },
    project: { type: "string", default: "tripquest-production" },
    database: { type: "string" },
    kind: { type: "string", default: "daily" },
    tag: { type: "string" },
    platform: { type: "string", default: "linux/amd64" },
  },
});
const [command, argument] = positionals;

function run(args, options = {}) {
  const result = spawnSync("docker", args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    ...options,
  });
  if (result.error || result.status !== 0) throw new Error("Docker operation failed");
  return result.stdout?.toString().trim();
}

function deployContext() {
  const filename = values["env-file"];
  if (!filename || !isAbsolute(filename) || resolve(filename).startsWith(`${root}${sep}`)) {
    throw new Error("--env-file must be an absolute path outside the repository");
  }
  if ((statSync(filename).mode & 0o077) !== 0) throw new Error("Restrict the environment file to its owner (chmod 600)");
  // Use Node's env loader without inheriting shell variables over the explicit file.
  // The child output is captured in memory; configuration values are never printed.
  const loaded = spawnSync(process.execPath, [
    "-e",
    "process.loadEnvFile(process.argv[1]); process.stdout.write(JSON.stringify(process.env))",
    filename,
  ], { env: {}, encoding: "utf8" });
  if (loaded.status !== 0) throw new Error("Cannot load deployment environment file");
  let environment;
  try {
    environment = JSON.parse(loaded.stdout);
  } catch {
    throw new Error("Cannot load deployment environment file");
  }
  for (const name of ["TRIPQUEST_DEPLOY_STATE_DIR", "TRIPQUEST_BACKUP_DIR", "TRIPQUEST_MODEL_PROFILE_FILE"]) {
    if (!environment[name] || !isAbsolute(environment[name])) throw new Error(`Set an absolute ${name}`);
    if (resolve(environment[name]).startsWith(`${root}${sep}`)) throw new Error(`${name} must stay outside the repository`);
  }
  const hostname = environment.SITE_HOST;
  if (!hostname || !/^[a-z0-9.-]+$/i.test(hostname) || environment.BETTER_AUTH_URL !== `https://${hostname}`) {
    throw new Error("SITE_HOST and BETTER_AUTH_URL must identify the same HTTPS origin");
  }
  if (!/^[a-z0-9][a-z0-9_-]+$/.test(values.project)) throw new Error("Invalid Compose project name");
  const image = environment.TRIPQUEST_APP_IMAGE;
  if (!image || /:latest(?:$|@)/.test(image) ||
    !(/(?:^sha256:|@sha256:)[a-f0-9]{64}$/.test(image) || /:[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(image))) {
    throw new Error("Select an explicit TRIPQUEST_APP_IMAGE tag or digest");
  }
  if (!existsSync(environment.TRIPQUEST_MODEL_PROFILE_FILE)) throw new Error("Model profile file is missing");
  const commandEnvironment = { ...process.env, ...environment, TRIPQUEST_ENV_FILE: filename };
  const base = ["compose", "--env-file", filename, "--project-name", values.project, "-f", "deploy/compose.yaml"];
  if (environment.TRIPQUEST_COST_CONFIG_DIR) {
    const folder = environment.TRIPQUEST_COST_CONFIG_DIR;
    if (!isAbsolute(folder) || resolve(folder) === root || resolve(folder).startsWith(root + sep) || !statSync(folder).isDirectory()) {
      throw new Error("Set TRIPQUEST_COST_CONFIG_DIR to a directory outside the repository");
    }
    base.push("-f", "deploy/costs.compose.yaml");
  }
  if (values["override-file"]) {
    if (!isAbsolute(values["override-file"])) throw new Error("--override-file must be an absolute path");
    base.push("-f", values["override-file"]);
  }
  const compose = (args, options) => run([...base, ...args], { ...options, env: commandEnvironment });
  const ops = (args) => compose(["run", "--rm", "--no-deps", "-T", "ops", ...args]);
  const state = environment.TRIPQUEST_DEPLOY_STATE_DIR;
  const backupFolder = environment.TRIPQUEST_BACKUP_DIR;
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(backupFolder, { recursive: true, mode: 0o700 });
  compose(["config", "--quiet"]);
  return { environment, compose, ops, state, backupFolder };
}

function maintenance(state, enabled) {
  const filename = join(state, "maintenance");
  if (enabled) writeFileSync(filename, "maintenance\n", { mode: 0o600 });
  else rmSync(filename, { force: true });
}

function backup(context, kind) {
  if (!["daily", "pre-update"].includes(kind)) throw new Error("Backup kind must be daily or pre-update");
  const { environment, compose, backupFolder } = context;
  const filename = join(backupFolder, `${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.dump`);
  const partial = `${filename}.partial`;
  const fd = openSync(partial, "wx", 0o600);
  try {
    compose(["exec", "-T", "postgres", "pg_dump", "-U", environment.POSTGRES_USER, "-d", environment.POSTGRES_DB, "-Fc"], {
      stdio: ["ignore", fd, "inherit"],
    });
    if (statSync(partial).size === 0) throw new Error("Empty database backup");
    renameSync(partial, filename);
  } finally {
    closeSync(fd);
    rmSync(partial, { force: true });
  }
  const copies = readdirSync(backupFolder).filter((name) => name.startsWith(`${kind}-`) && name.endsWith(".dump")).sort().reverse();
  for (const name of copies.slice(kind === "daily" ? 7 : 2)) rmSync(join(backupFolder, name));
  console.log(`Backup saved: ${filename}`);
  return filename;
}

async function main() {
  if (command === "build") {
    if (!values.tag || !values.tag.includes(":") || /:latest$/.test(values.tag)) throw new Error("build needs --tag with an explicit image tag");
    run(["build", "--platform", values.platform, "--tag", values.tag, "."]);
    return;
  }
  const context = deployContext();
  const { environment, compose, ops, state } = context;
  if (command === "check") {
    ops(["check"]);
  } else if (command === "status") {
    compose(["ps"]);
  } else if (command === "maintenance") {
    if (!["on", "off"].includes(argument)) throw new Error("maintenance needs on or off");
    maintenance(state, argument === "on");
  } else if (command === "backup") {
    backup(context, values.kind);
    if (values.kind === "daily") ops(["prune-billing"]);
  } else if (command === "restore-test") {
    const database = values.database;
    if (!database || !/^[a-z][a-z0-9_]*_test$/.test(database) || database === environment.POSTGRES_DB) {
      throw new Error("Restore destination must be a new *_test database, different from the active database");
    }
    if (!argument || !isAbsolute(argument)) throw new Error("Supply an absolute backup file path");
    const fd = openSync(argument, "r");
    try {
      compose(["exec", "-T", "postgres", "createdb", "-U", environment.POSTGRES_USER, database]);
      compose(["exec", "-T", "postgres", "pg_restore", "-U", environment.POSTGRES_USER,
        "--exit-on-error", "--no-owner", "--no-privileges", "-d", database], { stdio: [fd, "inherit", "inherit"] });
    } finally {
      closeSync(fd);
    }
    console.log("Backup restored to the isolated test database; production was not changed.");
  } else if (command === "release") {
    // Check before taking the old site into maintenance. No implicit registry pull or rebuild.
    const imageId = run(["image", "inspect", environment.TRIPQUEST_APP_IMAGE, "--format", "{{.Id}}"], { stdio: "pipe" });
    ops(["check"]);
    maintenance(state, true);
    compose(["up", "-d", "--wait", "postgres"]);
    const running = compose(["ps", "--status", "running", "-q", "web"], { stdio: "pipe" });
    if (running) ops(["drain"]);
    // SIGTERM lets Next finish ordinary in-flight HTTP writes as well as the tracked jobs.
    compose(["--profile", "worker", "stop", "web", "worker"]);
    const snapshot = backup(context, "pre-update");
    ops(["migrate"]);
    const worker = environment.PLANNING_TASKS_ENABLED === "true";
    const profiles = worker ? ["--profile", "worker"] : [];
    compose([...profiles, "up", "-d", "--wait", "--wait-timeout", "120", "web", "proxy", ...(worker ? ["worker"] : [])]);
    ops(["ready"]);
    const current = join(state, "release.json");
    if (existsSync(current)) renameSync(current, join(state, "previous-release.json"));
    writeFileSync(current, `${JSON.stringify({ image: environment.TRIPQUEST_APP_IMAGE, imageId, backup: snapshot, releasedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    maintenance(state, false);
    console.log("Release ready. Keep an encrypted off-host copy of the backup and configuration.");
  } else {
    throw new Error("Commands: build | check | release | backup | restore-test <file> --database <new_test> | maintenance on/off | status");
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Deployment operation failed");
  process.exitCode = 1;
}
