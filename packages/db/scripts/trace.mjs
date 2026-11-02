// V3.0: prints run records as trees — one request is one root run, with each agent's child runs and their
// steps (model calls, tools, checks, repairs, handoffs, fallbacks). Give a conversation id (every request of
// that conversation, plus the V2.9 chat_traces written before V3.0) or any run id (that run's whole tree).
// Records hold no addresses, coordinates, page summaries or knowledge text.
// Usage from the repository root: pnpm trace <conversation id | run id> [--test]
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

const [id] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
  console.error("Usage: pnpm trace <conversation id | run id> [--test]");
  process.exit(2);
}
const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
const url = process.argv.includes("--test") ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or TEST_DATABASE_URL with --test) is not set.");
  process.exit(2);
}

const short = (value, max = 160) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
const seconds = (run) => (run.finished_at ? `${((run.finished_at - run.started_at) / 1000).toFixed(1)} s` : "未结束");
const tally = (run) => [
  `模型 ${run.model_requests}`,
  run.map_requests ? `地图 ${run.map_requests}` : "",
  run.web_requests ? `联网 ${run.web_requests}` : "",
  run.knowledge_requests ? `资料库 ${run.knowledge_requests}` : "",
  run.input_tokens
    ? `${run.input_tokens + run.output_tokens} tokens（缓存 ${Math.round((run.cache_hit_tokens / Math.max(1, run.input_tokens)) * 100)}%）`
    : "",
].filter(Boolean).join("  ");
const label = (run) => {
  const extra = run.attributes?.date ? ` ${run.attributes.date}` : run.attributes?.purpose ? ` ${run.attributes.purpose}` : "";
  const outcome = run.outcome ? `（${run.outcome}）` : "";
  return `${run.agent}${extra}  ${run.status}${outcome}  ${seconds(run)}  ${tally(run)}`;
};
/** 模型调用的结果码和 tokens 已在运行那一行汇总，步骤里不再重复。 */
const HIDDEN = new Set(["code", "inputTokens", "outputTokens", "cacheHitTokens", "decision"]);
const quiet = (step) => !Object.keys(step.summary ?? {}).some((key) => !HIDDEN.has(key) || key === "decision");

/** 一步一行；连续的模型调用（没有附带决定的）合成一行：search_places ×2 · try_itinerary · finish。 */
function stepLines(steps) {
  const lines = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step.kind === "model_call" && quiet(step)) {
      const group = [step];
      while (steps[index + 1]?.kind === "model_call" && quiet(steps[index + 1])) group.push(steps[(index += 1)]);
      const names = [];
      for (const item of group) {
        const name = item.summary?.code === "ok" ? item.name : `${item.name}（${item.summary?.code}）`;
        const last = names.at(-1);
        if (last?.name === name) last.count += 1;
        else names.push({ name, count: 1 });
      }
      const ms = group.reduce((sum, item) => sum + (item.latency_ms ?? 0), 0);
      lines.push(`model_call  ${names.map(({ name, count }) => (count > 1 ? `${name} ×${count}` : name)).join(" · ")}  ${(ms / 1000).toFixed(1)} s`);
      continue;
    }
    const { code, decision } = step.summary ?? {};
    const rest = Object.fromEntries(Object.entries(step.summary ?? {}).filter(([key]) => !HIDDEN.has(key)));
    const detail = decision !== undefined ? decision : Object.keys(rest).length ? rest : null;
    const status = step.kind === "model_call" && code !== "ok" ? `（${code}）` : "";
    const latency = step.latency_ms !== null ? ` · ${step.latency_ms} ms` : "";
    lines.push(`${step.kind}  ${step.name}${status}${latency}${detail ? `  ${short(detail, 140)}` : ""}`);
  }
  return lines;
}

function printTree(runs, steps, parent, prefix) {
  const children = runs.filter((run) => run.parent_id === parent.id);
  const items = [
    ...stepLines(steps.filter((step) => step.run_id === parent.id)).map((text) => ({ text })),
    ...children.map((run) => ({ run })),
  ];
  items.forEach((item, index) => {
    const last = index === items.length - 1;
    console.log(`${prefix}${last ? "└─" : "├─"} ${item.run ? label(item.run) : item.text}`);
    if (item.run) printTree(runs, steps, item.run, `${prefix}${last ? "   " : "│  "}`);
  });
}

async function printRoot(client, root, messages) {
  const runs = (await client.query("SELECT * FROM agent_runs WHERE root_id = $1 ORDER BY started_at, id <> root_id, id", [root.id])).rows;
  const steps = (await client.query(
    "SELECT s.* FROM agent_steps s JOIN agent_runs r ON r.id = s.run_id WHERE r.root_id = $1 ORDER BY s.at, s.seq",
    [root.id],
  )).rows;
  const seq = root.attributes?.seq;
  const user = seq ? messages.find((message) => message.seq === seq) : null;
  console.log(`\n运行 ${root.id.slice(0, 8)}…  ${root.trigger}  ${root.status}${root.outcome ? `（${root.outcome}）` : ""}  ${seconds(root)}  ${tally(root)}`);
  if (user) console.log(`  #${seq} 用户：${short(user.body?.text ?? "")}`);
  printTree(runs, steps, root, "  ");
  if (seq) {
    const next = messages.find((message) => message.seq === seq + 1 && message.role === "assistant");
    if (next) console.log(`  回复：${next.kind === "text" ? short(next.body.text) : `（${next.kind}）`}`);
  }
}

/** V2.9 的决策记录（V3.0 以前的对话轮次）。 */
function printLegacy(record, seq, messages) {
  const user = messages.find((message) => message.seq === seq);
  console.log(`\n#${seq} 用户：${short(user?.body?.text ?? "")}（V2.9 决策记录）`);
  const route = record.route;
  if (route) console.log(`  分流：${route.router} · ${route.flags.join("+") || "—"} · ${route.latencyMs} ms`);
  (record.decisions ?? []).forEach((decision, index) => console.log(`  决策 ${index + 1}：${short(decision)}`));
  if (record.hints?.length) console.log(`  校验：${record.hints.join("；")}`);
  for (const tool of record.tools ?? []) {
    console.log(`  工具：${tool.tool}${tool.subject ? ` ${short(tool.subject, 40)}` : ""}${tool.count !== undefined ? ` → ${tool.count}` : ""}`);
  }
  console.log(`  结果：${record.outcome} · 模型 ${record.counts?.model ?? 0} 次 · ${(record.durationMs / 1000).toFixed(1)} s`);
}

const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  const messages = (await client.query(
    "SELECT seq, role, kind, body FROM conversation_messages WHERE conversation_id = $1 ORDER BY seq", [id],
  )).rows;
  if (messages.length) {
    const legacy = (await client.query("SELECT seq, record FROM chat_traces WHERE conversation_id = $1 ORDER BY seq", [id])).rows;
    for (const { seq, record } of legacy) printLegacy(record, seq, messages);
    const roots = (await client.query("SELECT * FROM agent_runs WHERE conversation_id = $1 AND id = root_id ORDER BY started_at", [id])).rows;
    for (const root of roots) await printRoot(client, root, messages);
    if (!legacy.length && !roots.length) console.log("这段对话还没有运行记录。");
  } else {
    const root = (await client.query(
      "SELECT r.* FROM agent_runs r JOIN agent_runs x ON x.root_id = r.id WHERE x.id = $1", [id],
    )).rows[0];
    if (!root) {
      console.log("No such conversation or run.");
      process.exitCode = 1;
    } else {
      const conversation = root.conversation_id
        ? (await client.query(
          "SELECT seq, role, kind, body FROM conversation_messages WHERE conversation_id = $1 ORDER BY seq", [root.conversation_id],
        )).rows
        : [];
      await printRoot(client, root, conversation);
    }
  }
} catch {
  // Never echo connection strings or driver messages.
  console.error("Trace failed: database unavailable or not migrated.");
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
