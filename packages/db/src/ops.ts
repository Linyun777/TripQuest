import { createHmac } from "node:crypto";
import type { JourneyDatabaseClient } from "./connection";
import {
  chinaDay,
  siteUsageOverview,
  USAGE_CATEGORIES,
  userDailyDefault,
  type UsageCategory,
} from "./usage";

type Pool = JourneyDatabaseClient["pool"];
const DAY = 86_400_000;
const DAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
const words = new Set(
  (
    "plan outing adjust outing_change outing_generate chat_turn chat-summary trip-notes other " +
    "day-planner outing-allocator outing-reviewer outing-judge outing-repair short-picker chat-intake chat-trip chat-info chat-advice chat-companion " +
    "running interrupted done ok none failed fallback cancelled budget_exhausted model_call tool_call repair check handoff " +
    "amap_search amap_detail amap_route amap_weather amap_nearby web_search ask_knowledge get_weather search_place update_requirements " +
    "trial_plan trial_change allocation review invalid_allocation invalid_action invalid_review live_budget provider_error timeout " +
    "try_move try_swap try_moves try_drop try_add_interest try_travel keep suggest finish quota_exceeded rate_limited upstream_unavailable authorization_failed daily_limit user_limit site_limit named_untried root search_places try_itinerary search_nearby day_unknown_activity no_searches_left semantic_invalid model_error internal_error day_missing_required duplicate_order invalid stop tool caller lookup_nearby inspect_place error auth quota rate_limit decision finish search route schedule inspect try_order assessment findings rejected result baseline timeout invalid_output transport"
  ).split(" "),
);
const label = (v: string) => (words.has(v) ? v : "其他");
const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;

function stage(value: string | null) {
  if (!value) return "等待进度";
  if (/查找|地点|编号/.test(value)) return "查询地点";
  if (/路线|交通/.test(value)) return "核对路线";
  if (/修复|修正|重试/.test(value)) return "调整方案";
  if (/检查|校验|审查/.test(value)) return "检查方案";
  if (/排|生成/.test(value)) return "生成安排";
  return "其他";
}

function userCode(userId: string, secret: string) {
  return createHmac("sha256", secret)
    .update("ops:" + userId)
    .digest("hex")
    .slice(0, 12);
}

const executions = `WITH raw_runs AS (
  SELECT j.id, 'job' AS entity, j.user_id, j.root_run_id AS root, j.kind,
    CASE WHEN j.status='done' THEN coalesce(r.status,j.status) ELSE j.status END AS status,
    date_trunc('milliseconds',j.started_at) AS started_at,j.finished_at,j.heartbeat_at,j.steps->>-1 AS phase
  FROM conversation_jobs j LEFT JOIN agent_runs r ON r.id=j.root_run_id AND r.user_id=j.user_id
  WHERE j.started_at >= $1
  UNION ALL
  SELECT r.id,'root',r.user_id,r.id,coalesce(r.trigger,r.agent),r.status,date_trunc('milliseconds',r.started_at),r.finished_at,NULL,NULL
  FROM agent_runs r WHERE r.id=r.root_id AND r.started_at >= $1 AND NOT EXISTS
    (SELECT 1 FROM conversation_jobs j WHERE j.root_run_id=r.id AND j.user_id=r.user_id)
  UNION ALL
  SELECT e.run_id,'root',e.user_id,e.run_id,'other','unknown',date_trunc('milliseconds',min(e.created_at)),NULL,NULL,NULL
  FROM usage_events e WHERE e.created_at >= $1 AND e.run_id IS NOT NULL AND e.meter_status IN ('estimated','reserved','unknown','unsent')
    AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.id=e.run_id AND r.user_id=e.user_id)
    AND NOT EXISTS (SELECT 1 FROM conversation_jobs j WHERE j.root_run_id=e.run_id AND j.user_id=e.user_id)
  GROUP BY e.user_id,e.run_id
), executions AS (
  SELECT id,entity,user_id,root,kind,started_at,finished_at,heartbeat_at,phase,
    EXISTS (SELECT 1 FROM agent_runs c WHERE c.root_id=raw_runs.root AND c.user_id=raw_runs.user_id
      AND c.attributes->>'modelMode'='scripted') AS simulated,
    CASE WHEN status IN ('ok','done') AND EXISTS (
      SELECT 1 FROM agent_runs c WHERE c.root_id=raw_runs.root AND c.user_id=raw_runs.user_id
        AND c.status='fallback'
    ) THEN 'fallback' ELSE status END AS status
  FROM raw_runs
)`;

type Call = {
  id: string;
  root: string;
  user_id: string;
  child: string | null;
  day: string;
  category: string;
  status: string;
  provider: string | null;
  model: string | null;
  currency: string | null;
  amount: string | null;
  tokens: { input: number; output: number; hit: number | null; miss: number | null } | null;
};
const projection = `e.id,e.run_id AS root,e.user_id,e.child_run_id AS child,e.day::text,e.category,
  coalesce(e.meter_status,'legacy') AS status,e.provider,coalesce(e.returned_model,e.requested_model) AS model,
  e.currency,e.amount::text,e.tokens`;
type Execution = {
  id: string;
  entity: string;
  user_id: string;
  root: string | null;
  kind: string;
  status: string;
  simulated?: boolean;
  started_at: Date;
  finished_at: Date | null;
  heartbeat_at: Date | null;
  phase: string | null;
};
const units = (n: string) => {
  const [whole, fraction = ""] = n.split(".");
  return BigInt(whole + fraction.padEnd(14, "0"));
};
function decimal(n: bigint) {
  const s = n.toString().padStart(15, "0");
  return (s.slice(0, -14) + "." + s.slice(-14)).replace(/0+$/, "").replace(/\.$/, "");
}
function cost(calls: Call[]) {
  const sums = new Map<string, bigint>();
  let pending = 0;
  for (const c of calls) {
    if (c.status === "estimated" && c.currency && c.amount !== null) {
      sums.set(c.currency, (sums.get(c.currency) ?? 0n) + units(c.amount));
    } else if (c.status === "unknown" || c.status === "reserved") pending++;
  }
  return { amounts: Object.fromEntries([...sums].map(([k, v]) => [k, decimal(v)])), pending };
}
function summary(r: Execution, calls: Call[], secret: string, now: number) {
  return {
    id: r.id,
    entity: r.entity,
    root: r.root,
    kind: label(r.kind),
    status: label(r.status),
    user: userCode(r.user_id, secret),
    started: r.started_at.toISOString(),
    elapsed:
      r.finished_at || r.status === "running"
        ? (r.finished_at?.getTime() ?? now) - r.started_at.getTime()
        : null,
    heartbeat: r.heartbeat_at?.toISOString() ?? null,
    stale:
      r.status === "running" && r.heartbeat_at !== null && now - r.heartbeat_at.getTime() > 30_000,
    simulated: r.simulated === true,
    phase: stage(r.phase),
    cost: cost(calls),
  };
}

export class OpsReader {
  constructor(
    private pool: Pool,
    private secret: string,
    private now = Date.now(),
  ) {}
  private floor() {
    return new Date(this.now - 30 * DAY);
  }

  async runs(filters: URLSearchParams) {
    const rawUserId = filters.get("userId")?.trim() || null;
    if (rawUserId && !uuid.test(rawUserId)) {
      return { runs: [], next: null };
    }
    const end = filters.get("after");
    const [rank, time, key] = end?.split("|") ?? [];
    const cursor =
      !!key && uuid.test(key) && Number.isFinite(Date.parse(time!)) && ["0", "1"].includes(rank!);
    const { rows } = await this.pool.query<Execution>(
      executions +
        `
      SELECT * FROM executions WHERE ($2::text IS NULL OR status=$2)
      AND ($3::float8 IS NULL OR extract(epoch from (coalesce(finished_at,$4)-started_at)) >= $3)
      AND ($5::int IS NULL OR (CASE WHEN status='running' THEN 1 ELSE 0 END,started_at,id)<($5,$6,$7))
      AND ($8::text IS NULL OR kind=$8)
      AND ($12::uuid IS NULL OR user_id=$12)
      AND (($9::text IS NULL AND $10::text IS NULL AND $11::text IS NULL) OR EXISTS (
        SELECT 1 FROM usage_events e WHERE e.run_id=executions.root AND e.user_id=executions.user_id
          AND ($9::text IS NULL OR e.day::text=$9)
          AND ($10::text IS NULL OR e.provider=$10)
          AND ($11::text IS NULL OR coalesce(e.returned_model,e.requested_model)=$11)
      ))
      ORDER BY (status='running') DESC,started_at DESC,id DESC LIMIT 26`,
      [
        this.floor(),
        filters.get("status") || null,
        Number(filters.get("seconds")) || null,
        new Date(this.now),
        cursor ? Number(rank) : null,
        cursor ? time : null,
        cursor ? key : null,
        filters.get("kind") || null,
        filters.get("day") || null,
        filters.get("provider") || null,
        filters.get("model") || null,
        rawUserId,
      ],
    );
    const page = rows.slice(0, 25);
    const events = await this.pool.query<Call>(
      `SELECT ${projection} FROM usage_events e WHERE e.run_id=ANY($1::uuid[])`,
      [page.map((r) => r.root).filter(Boolean)],
    );
    const last = page.at(-1);
    return {
      runs: page.map((r) =>
        summary(
          r,
          events.rows.filter((c) => c.user_id === r.user_id && c.root === r.root),
          this.secret,
          this.now,
        ),
      ),
      next:
        rows.length > 25 && last
          ? [last.status === "running" ? 1 : 0, last.started_at.toISOString(), last.id].join("|")
          : null,
    };
  }

  async detail(entity: string, id: string, day?: string | null) {
    if (!uuid.test(id) || !["job", "root"].includes(entity)) return null;
    const r = (
      await this.pool.query<Execution>(
        executions +
          " SELECT * FROM executions WHERE (entity=$2 AND id=$3 OR $2='root' AND root=$3) LIMIT 1",
        [this.floor(), entity, id],
      )
    ).rows[0];
    if (!r) return null;
    const args = [r.user_id, r.root];
    const calls = (
      await this.pool.query<
        Call & {
          rates: {
            from: string;
            input: string | null;
            hit: string | null;
            miss: string | null;
            output: string;
          } | null;
        }
      >(
        `SELECT ${projection}, CASE WHEN e.price IS NOT NULL THEN jsonb_build_object(
        'from',e.price->'from','input',e.price->'input','hit',e.price->'hit','miss',e.price->'miss','output',e.price->'output'
      ) END AS rates FROM usage_events e
      WHERE e.user_id=$1 AND e.run_id=$2 ORDER BY created_at,id`,
        args,
      )
    ).rows;
    const nodes = (
      await this.pool.query(
        `SELECT id,parent_id,agent,status,outcome,started_at,finished_at FROM agent_runs
      WHERE user_id=$1 AND root_id=$2 ORDER BY started_at,id<>root_id,id`,
        args,
      )
    ).rows;
    const steps = (
      await this.pool.query(
        `SELECT s.run_id,s.seq,s.kind,s.name,s.latency_ms,
      s.summary->>'code' AS code,s.summary->>'eventId' AS event,s.summary->'repairs' AS repairs FROM agent_steps s
      JOIN agent_runs r ON r.id=s.run_id WHERE r.user_id=$1 AND r.root_id=$2 ORDER BY s.run_id,s.seq`,
        args,
      )
    ).rows;
    // Only expose receipts owned by this tree and linked to their actual model step.
    const byId = new Map(calls.map((call) => [call.id, call]));
    const byRepair = new Map<string, Set<Call>>();
    const projected = steps.map((step) => {
      const call = step.kind === "model_call" ? byId.get(step.event) : undefined;
      const event = call?.child === step.run_id ? call : undefined;
      if (event && Array.isArray(step.repairs)) {
        for (const ref of step.repairs) {
          if (!ref) continue;
          const key = `${ref.run}/${ref.seq}`;
          const linked = byRepair.get(key) ?? new Set<Call>();
          linked.add(event);
          byRepair.set(key, linked);
        }
      }
      return {
        run: String(step.run_id),
        seq: Number(step.seq),
        kind: label(step.kind),
        action:
          step.kind === "model_call" &&
          step.name.split("+").every((part: string) => words.has(part))
            ? (step.name as string)
            : label(step.name),
        code: step.code ? label(step.code) : null,
        ms: step.latency_ms as number | null,
        event: event?.id ?? null,
      };
    });
    return {
      ...summary(r, calls, this.secret, this.now),
      selectedDay: day ? cost(calls.filter((c) => c.day === day)) : null,
      nodes: nodes.map((n) => ({
        id: String(n.id),
        parent: n.parent_id as string | null,
        agent: label(n.agent),
        status: label(n.status),
        outcome: n.outcome ? label(n.outcome) : null,
        elapsed: n.finished_at ? n.finished_at - n.started_at : null,
      })),
      steps: projected.map((step) => {
        const linked = step.kind === "repair" ? byRepair.get(`${step.run}/${step.seq}`) : undefined;
        return {
          ...step,
          repair: linked
            ? { events: [...linked].map((c) => c.id), cost: cost([...linked]) }
            : null,
        };
      }),
      calls: calls.map((c) => ({
        id: c.id,
        child: c.child,
        day: c.day,
        category: c.category,
        status: c.status,
        provider: c.provider,
        model: c.model,
        tokens: c.tokens,
        rates: c.rates,
        currency: c.currency,
        amount: c.amount,
      })),
    };
  }

  async usage(filters: URLSearchParams) {
    const rawUserId = filters.get("userId")?.trim() || null;
    const today = chinaDay(this.now);
    const month = today.slice(0, 7) + "-01";
    const week = chinaDay(this.now - 6 * DAY);
    const from = [month, week, chinaDay(this.now - 29 * DAY)].sort()[0];
    if (rawUserId && !uuid.test(rawUserId)) {
      return {
        today: cost([]),
        month: cost([]),
        days: Array.from({ length: 7 }, (_, i) => ({
          day: chinaDay(this.now - (6 - i) * DAY),
          ...cost([]),
        })),
        counts: Object.fromEntries(USAGE_CATEGORIES.map((k) => [k, 0])),
        groups: [],
      };
    }
    const rows = (
      await this.pool.query<Call & { kind: string }>(
        `SELECT ${projection},
      coalesce(j.kind,r.trigger,'other') AS kind FROM usage_events e
      LEFT JOIN agent_runs r ON r.id=e.run_id AND r.user_id=e.user_id
      LEFT JOIN conversation_jobs j ON j.root_run_id=e.run_id AND j.user_id=e.user_id
      WHERE e.day BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR e.user_id=$3) ORDER BY e.day,e.id`,
        [from, today, rawUserId],
      )
    ).rows;
    const selected = rows.filter(
      (c) =>
        c.day === (filters.get("day") || today) &&
        (["provider", "model", "kind"] as const).every(
          (k) => !filters.get(k) || c[k] === filters.get(k),
        ),
    );
    const selectedRoots = selected
      .filter((c) => c.category === "model" && c.root)
      .map((c) => c.root);
    const history = (
      await this.pool.query<Call & { complete: boolean }>(
        `SELECT ${projection},
      (EXISTS (SELECT 1 FROM agent_runs r WHERE r.id=e.run_id AND r.user_id=e.user_id AND r.finished_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM conversation_jobs j WHERE j.root_run_id=e.run_id AND j.user_id=e.user_id
          AND j.status='running')) AS complete FROM usage_events e
      WHERE e.category='model' AND e.run_id=ANY($1::uuid[])`,
        [selectedRoots],
      )
    ).rows;
    const groups = new Map<string, Call[]>();
    for (const c of selected.filter((c) => c.category === "model")) {
      const key = JSON.stringify([c.provider, c.model, label(c.kind), c.currency]);
      const list = groups.get(key) ?? [];
      list.push(c);
      groups.set(key, list);
    }
    return {
      today: cost(rows.filter((c) => c.day === today)),
      month: cost(rows.filter((c) => c.day >= month)),
      days: Array.from({ length: 7 }, (_, i) => {
        const day = chinaDay(this.now - (6 - i) * DAY);
        return { day, ...cost(rows.filter((c) => c.day === day)) };
      }),
      counts: Object.fromEntries(
        USAGE_CATEGORIES.map((k) => [k, selected.filter((c) => c.category === k).length]),
      ),
      groups: [...groups]
        .map(([key, list]) => {
          const [provider, model, kind, currency] = JSON.parse(key) as (string | null)[];
          const roots = new Set(list.filter((c) => c.root).map((c) => c.user_id + "/" + c.root));
          const complete = [...roots]
            .map((root) =>
              history.filter((c) => c.user_id + "/" + c.root === root && c.category === "model"),
            )
            .filter(
              (run) =>
                run.every(
                  (c) =>
                    c.complete &&
                    (c.status === "unsent" ||
                      (c.status === "estimated" && c.currency === currency)),
                ) && run.some((c) => c.amount !== null),
            );
          const sum = complete.flat().reduce((n, c) => n + units(c.amount ?? "0"), 0n);
          return {
            provider,
            model,
            kind,
            currency,
            ...cost(list),
            roots: roots.size,
            pendingRoots: [...roots].filter((root) =>
              history.some(
                (c) =>
                  c.user_id + "/" + c.root === root && ["unknown", "reserved"].includes(c.status),
              ),
            ).length,
            average: complete.length ? decimal(sum / BigInt(complete.length)) : null,
            samples: complete.length,
          };
        })
        .sort(
          (a, b) =>
            Number(!a.currency) - Number(!b.currency) ||
            (a.currency ?? "").localeCompare(b.currency ?? "") ||
            Number(b.amounts[b.currency ?? ""] ?? 0) - Number(a.amounts[a.currency ?? ""] ?? 0),
        ),
    };
  }

  /**
   * 站长按用户维度观测：各账号的当日/当月 API 费用估算、五类调用的已用/上限/剩余（含全站余量限制标注）
   * 与近 30 天运行概况，并附当前全站五类额度状态。不返回邮箱、密码哈希、会话令牌、对话正文或位置。
   */
  async users(
    requestedDay?: string | null,
    environment: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    const today = chinaDay(this.now);
    const day = requestedDay && DAY_FORMAT.test(requestedDay) ? requestedDay : today;
    const month = day.slice(0, 7) + "-01";
    const from = [month, day].sort()[0]!;
    const until = [today, day].sort().at(-1)!;

    const [
      site,
      userRows,
      limitRows,
      usageRows,
      runRows,
    ] = await Promise.all([
      siteUsageOverview(this.pool, day, environment),
      this.pool.query<{
        id: string;
        username: string | null;
        display_username: string | null;
        name: string;
        role: string | null;
        banned: boolean | null;
        created_at: Date;
        last_sign_in_at: Date | null;
      }>(
        `SELECT u.id, u.username, u.display_username, u.name, u.role, u.banned, u.created_at,
                (SELECT max(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS last_sign_in_at
           FROM users u
          ORDER BY u.created_at ASC`,
      ),
      this.pool.query<{ user_id: string; category: UsageCategory; daily_limit: number }>(
        "SELECT user_id, category, daily_limit FROM usage_limits",
      ),
      this.pool.query<Call>(
        `SELECT ${projection} FROM usage_events e WHERE e.day BETWEEN $1 AND $2 ORDER BY e.day, e.id`,
        [from, until],
      ),
      this.pool.query<Execution>(
        executions + " SELECT * FROM executions ORDER BY (status='running') DESC, started_at DESC, id DESC",
        [this.floor()],
      ),
    ]);

    const siteByCategory = new Map(site.map((item) => [item.category, item]));
    const customLimits = new Map<string, number>();
    for (const row of limitRows.rows) {
      customLimits.set(`${row.user_id}:${row.category}`, row.daily_limit);
    }

    const callsByUser = new Map<string, Call[]>();
    for (const row of usageRows.rows) {
      const list = callsByUser.get(row.user_id) ?? [];
      list.push(row);
      callsByUser.set(row.user_id, list);
    }

    const runsByUser = new Map<string, Execution[]>();
    for (const row of runRows.rows) {
      const list = runsByUser.get(row.user_id) ?? [];
      list.push(row);
      runsByUser.set(row.user_id, list);
    }

    const monthEnd = day.slice(0, 7) + "-31";
    const users = userRows.rows
      .map((u) => {
        const calls = callsByUser.get(u.id) ?? [];
        const dayCalls = calls.filter((c) => c.day === day);
        const monthCalls = calls.filter((c) => c.day >= month && c.day <= monthEnd);
        const userRuns = runsByUser.get(u.id) ?? [];
        const runningRuns = userRuns.filter((r) => r.status === "running");
        const staleCount = runningRuns.filter(
          (r) => r.heartbeat_at !== null && this.now - r.heartbeat_at.getTime() > 30_000,
        ).length;
        const latest = userRuns[0] ?? null;

        const quotas = USAGE_CATEGORIES.map((category) => {
          const used = dayCalls.filter((c) => c.category === category).length;
          const defaultLimit = userDailyDefault(category, environment);
          const customLimit = customLimits.get(`${u.id}:${category}`) ?? null;
          const limit = customLimit ?? defaultLimit;
          const remaining = Math.max(0, limit - used);
          const siteRemaining = siteByCategory.get(category)?.remaining ?? null;
          const effectiveRemaining =
            siteRemaining === null ? remaining : Math.min(remaining, siteRemaining);
          const cappedBySite = siteRemaining !== null && siteRemaining < remaining;
          return {
            category,
            used,
            limit,
            defaultLimit,
            customLimit,
            remaining,
            effectiveRemaining,
            cappedBySite,
          };
        });

        return {
          id: u.id,
          code: userCode(u.id, this.secret),
          username: u.username ?? u.name,
          displayUsername: u.display_username || u.username || u.name,
          role: (u.role === "admin" ? "admin" : "user") as "admin" | "user",
          banned: u.banned === true,
          createdAt: u.created_at.toISOString(),
          lastSignInAt: u.last_sign_in_at?.toISOString() ?? null,
          dayCost: cost(dayCalls),
          monthCost: cost(monthCalls),
          quotas,
          runs: {
            running: runningRuns.length,
            stale: staleCount,
            dayTotal: userRuns.filter((r) => chinaDay(r.started_at.getTime()) === day).length,
            total30d: userRuns.length,
            failed30d: userRuns.filter(
              (r) => r.status === "failed" || r.status === "budget_exhausted",
            ).length,
            fallback30d: userRuns.filter((r) => r.status === "fallback").length,
            lastRunAt: latest ? latest.started_at.toISOString() : null,
            lastRunKind: latest ? label(latest.kind) : null,
            lastRunStatus: latest ? label(latest.status) : null,
            lastRunPhase: latest && (latest.status === "running" || latest.status === "interrupted")
              ? stage(latest.phase)
              : null,
          },
        };
      })
      .sort((a, b) => {
        if (b.runs.running !== a.runs.running) return b.runs.running - a.runs.running;
        const aTime = a.runs.lastRunAt ? Date.parse(a.runs.lastRunAt) : 0;
        const bTime = b.runs.lastRunAt ? Date.parse(b.runs.lastRunAt) : 0;
        if (bTime !== aTime) return bTime - aTime;
        return Date.parse(a.createdAt) - Date.parse(b.createdAt);
      });

    return {
      day,
      today,
      isToday: day === today,
      site,
      users,
    };
  }
}

export async function pruneBilling(pool: Pool, now = Date.now()) {
  const today = chinaDay(now);
  const cutoff = [today.slice(0, 7) + "-01", chinaDay(now - 29 * DAY)].sort()[0];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE agent_steps SET summary=summary-'eventId'
      WHERE at < ($1::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND summary ? 'eventId'`,
      [cutoff],
    );
    await client.query(
      `UPDATE usage_events SET meter_status=NULL,child_run_id=NULL,provider=NULL,
      requested_model=NULL,returned_model=NULL,tokens=NULL,price=NULL,currency=NULL,amount=NULL
      WHERE day<$1 AND meter_status IS NOT NULL`,
      [cutoff],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
