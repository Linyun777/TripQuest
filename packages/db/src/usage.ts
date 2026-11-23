import { estimate, type ModelReceipt, type Price } from "./model-prices";
import { randomUUID } from "node:crypto";
import type { JourneyDatabaseClient } from "./connection";

/**
 * V2.12 用量（stages/V2.12.md §3.5，原来是本机文件 eval-results/local-usage.jsonl）：每次地图、模型、联网、
 * 资料库、Jev 请求先预留一条，超过上限就不记、不发请求。两层上限：每人每日（缺省模型 300、高德 1000、联网 50、
 * 资料库 300、Jev 0；环境变量 USER_DAILY_LIMIT_<类别> 改缺省，站长可在页面或命令行给某人单独调），和全站每日
 * （高德 3000，D-046；联网、资料库、Jev 沿用 WEB_SEARCH_DAILY_LIMIT、EMBEDDING_DAILY_LIMIT、JEV_DAILY_LIMIT；
 * 模型由 MODEL_DAILY_LIMIT 控制，生产必须配置；站长可在观测页写入 site_usage_limits 动态覆盖并立即生效）。
 * 只记次数，不记请求内容。
 */
export const USAGE_CATEGORIES = ["model", "amap", "web", "embed", "jev"] as const;
export type UsageCategory = (typeof USAGE_CATEGORIES)[number];

export const USER_DAILY_DEFAULTS: Readonly<Record<UsageCategory, number>> = {
  model: 300,
  amap: 1000,
  web: 50,
  embed: 300,
  jev: 0,
};
export const SITE_DAILY_DEFAULTS: Readonly<Record<UsageCategory, number>> = {
  model: Number.POSITIVE_INFINITY,
  amap: 3000,
  web: 100,
  embed: 1000,
  jev: 500,
};
const SITE_VARIABLES: Partial<Record<UsageCategory, string>> = {
  model: "MODEL_DAILY_LIMIT",
  web: "WEB_SEARCH_DAILY_LIMIT",
  embed: "EMBEDDING_DAILY_LIMIT",
  jev: "JEV_DAILY_LIMIT",
};

type Pool = JourneyDatabaseClient["pool"];
type Environment = Readonly<Record<string, string | undefined>>;

const configured = (value: string | undefined, fallback: number) => {
  const number = Number(value);
  return value !== undefined &&
    value !== "" &&
    Number.isInteger(number) &&
    number >= 0 &&
    number <= 100_000
    ? number
    : fallback;
};

const isUsageCategory = (category: string): category is UsageCategory =>
  (USAGE_CATEGORIES as readonly string[]).includes(category);

const assertValidLimit = (limit: number) => {
  if (!Number.isInteger(limit) || limit < 0 || limit > 100_000) {
    throw new Error("limit must be 0–100000");
  }
};

export function siteDailyLimit(category: UsageCategory, environment: Environment): number {
  const variable = SITE_VARIABLES[category];
  if (category === "model" && environment.NODE_ENV === "production") {
    const value = environment.MODEL_DAILY_LIMIT;
    if (
      !value ||
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) > 100_000
    ) {
      throw new Error("MODEL_DAILY_LIMIT must be an integer from 0 to 100000 in production");
    }
  }
  return variable
    ? configured(environment[variable], SITE_DAILY_DEFAULTS[category])
    : SITE_DAILY_DEFAULTS[category];
}

export function userDailyDefault(category: UsageCategory, environment: Environment): number {
  return configured(
    environment[`USER_DAILY_LIMIT_${category.toUpperCase()}`],
    USER_DAILY_DEFAULTS[category],
  );
}

/** 北京时间的日期（用量按自然日算）。 */
export function chinaDay(ms: number): string {
  return new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);
}

export class UsageLimitError extends Error {
  constructor(
    readonly category: UsageCategory,
    readonly scope: "user" | "site",
  ) {
    super(
      category === "amap"
        ? "今天的地点查询次数用完了，明天再试。"
        : category === "web"
          ? "今天的联网搜索次数用完了，明天再试。"
          : category === "embed"
            ? "今天的资料库查询次数用完了，明天再试。"
            : category === "jev"
              ? "今天的 Jev 判断次数用完了，明天再试。"
              : "今天的规划次数用完了，明天再试。",
    );
  }
}

/** 账本读写不了（连接、锁、语句超时）：这一次没记上、请求不发，但不是次数用完，调用方不能说“明天再试”。 */
export class UsageUnavailableError extends Error {
  constructor(readonly category: UsageCategory) {
    super("usage ledger unavailable");
  }
}

export interface UsageToday {
  readonly category: UsageCategory;
  readonly used: number;
  readonly limit: number;
}

export interface SiteUsageLimit {
  readonly category: UsageCategory;
  readonly used: number;
  /** 生效的全站每日上限；null 表示未设上限（仅本机开发态模型可能为 null）。 */
  readonly limit: number | null;
  readonly defaultLimit: number | null;
  readonly customLimit: number | null;
  readonly remaining: number | null;
  readonly updatedAt: string | null;
}

/**
 * 一个用户的用量账本：先预留再请求，失败也不退还次数（同原来的本机账本）。到上限抛 UsageLimitError；
 * 账本本身读写不了抛 UsageUnavailableError（以前也算成到上限，数据库一抖用户就被告知“今天用完了”）。
 */
export class UsageLedger {
  constructor(
    private readonly pool: Pool,
    private readonly userId: string,
    private readonly environment: Environment = process.env,
    private readonly now: () => number = Date.now,
    /** V3.0：发这次请求的根运行（没有就是 null），记在用量上，以后能按运行看花费。 */
    private readonly runId: () => string | null = () => null,
  ) {}

  async reserve(category: UsageCategory, kind: string, purpose: string): Promise<void> {
    await this.reserveEvent(category, kind, purpose);
  }

  async reserveEvent(
    category: UsageCategory,
    kind: string,
    purpose: string,
    childRunId?: string,
  ) {
    const at = new Date(this.now());
    const day = chinaDay(at.getTime());
    const id = randomUUID();
    const rootId = this.runId();
    const client = await this.pool.connect().catch(() => {
      throw new UsageUnavailableError(category);
    });
    try {
      await client.query("BEGIN");
      // 同一天同一类的预留串行：数已用量、比上限、写入在同一把锁里。几个人用，锁的范围按类别足够。
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`usage:${category}:${day}`]);
      const { rows } = await client.query<{
        mine: number;
        site: number;
        limit: number | null;
        site_limit: number | null;
      }>(
        `SELECT count(*) FILTER (WHERE user_id = $1)::int AS mine,
                count(*)::int AS site,
                (SELECT daily_limit FROM usage_limits WHERE user_id = $1 AND category = $3) AS limit,
                (SELECT daily_limit FROM site_usage_limits WHERE category = $3) AS site_limit
           FROM usage_events WHERE day = $2 AND category = $3`,
        [this.userId, day, category],
      );
      const row = rows[0]!;
      const userLimit = row.limit ?? userDailyDefault(category, this.environment);
      if (row.mine >= userLimit) throw new UsageLimitError(category, "user");
      const effectiveSiteLimit = row.site_limit ?? siteDailyLimit(category, this.environment);
      if (row.site >= effectiveSiteLimit) throw new UsageLimitError(category, "site");
      await client.query(
        `INSERT INTO usage_events
          (id,user_id,day,category,kind,purpose,created_at,run_id,child_run_id,meter_status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          this.userId,
          day,
          category,
          kind.slice(0, 40),
          purpose.slice(0, 40),
          at,
          rootId,
          childRunId ?? null,
          category === "model" && childRunId ? "reserved" : "count_only",
        ],
      );
      await client.query("COMMIT");
      return { id, at, rootId, childRunId };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      // 不带出驱动的原始错误（可能含连接信息）。
      throw error instanceof UsageLimitError ? error : new UsageUnavailableError(category);
    } finally {
      client.release();
    }
  }

  async settleModel(
    event: { id: string; at: Date },
    receipt: ModelReceipt,
    prices: Price[],
    channel: string,
  ) {
    const cost = estimate(prices, channel, event.at, receipt);
    await this.pool.query(
      `UPDATE usage_events SET meter_status=$3,provider=$4,requested_model=$5,returned_model=$6,
        tokens=$7, price=$8, currency=$9, amount=$10
        WHERE id=$1 AND user_id=$2 AND meter_status='reserved'`,
      [
        event.id,
        this.userId,
        !receipt.sent ? "unsent" : cost ? "estimated" : "unknown",
        receipt.provider,
        receipt.requested,
        receipt.returned ?? null,
        receipt.usage,
        cost?.price ?? null,
        cost?.price.currency ?? null,
        cost?.amount ?? null,
      ],
    );
  }

  /** 今天各类用了多少、上限多少（“我的账号”页）。 */
  async today(): Promise<UsageToday[]> {
    return (await usageByUser(this.pool, chinaDay(this.now()), this.environment, this.userId))[0]
      ?.categories ?? [];
  }
}

/** 某天每个用户各类的用量和上限（命令行 pnpm users list；只给一个用户时只查他）。 */
export async function usageByUser(
  pool: Pool,
  day: string,
  environment: Environment,
  onlyUserId?: string,
): Promise<{ userId: string; categories: UsageToday[] }[]> {
  const { rows: users } = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE $1::uuid IS NULL OR id = $1 ORDER BY created_at",
    [onlyUserId ?? null],
  );
  const { rows: used } = await pool.query<{ user_id: string; category: UsageCategory; n: number }>(
    `SELECT user_id, category, count(*)::int AS n FROM usage_events
      WHERE day = $1 AND ($2::uuid IS NULL OR user_id = $2) GROUP BY user_id, category`,
    [day, onlyUserId ?? null],
  );
  const { rows: limits } = await pool.query<{
    user_id: string;
    category: UsageCategory;
    daily_limit: number;
  }>(
    "SELECT user_id, category, daily_limit FROM usage_limits WHERE $1::uuid IS NULL OR user_id = $1",
    [onlyUserId ?? null],
  );
  return users.map(({ id }) => ({
    userId: id,
    categories: USAGE_CATEGORIES.map((category) => ({
      category,
      used: used.find((row) => row.user_id === id && row.category === category)?.n ?? 0,
      limit:
        limits.find((row) => row.user_id === id && row.category === category)?.daily_limit ??
        userDailyDefault(category, environment),
    })),
  }));
}

/** 某天全站各类的用量、生效上限、环境默认与剩余次数（站长观测与额度管理）。 */
export async function siteUsageOverview(
  pool: Pool,
  day: string,
  environment: Environment = process.env,
): Promise<SiteUsageLimit[]> {
  const [{ rows: usedRows }, { rows: overrideRows }] = await Promise.all([
    pool.query<{ category: UsageCategory; n: number }>(
      "SELECT category, count(*)::int AS n FROM usage_events WHERE day = $1 GROUP BY category",
      [day],
    ),
    pool.query<{ category: UsageCategory; daily_limit: number; updated_at: Date }>(
      "SELECT category, daily_limit, updated_at FROM site_usage_limits",
    ),
  ]);
  const usedMap = new Map(usedRows.map((row) => [row.category, row.n]));
  const overrideMap = new Map(overrideRows.map((row) => [row.category, row]));
  return USAGE_CATEGORIES.map((category) => {
    const used = usedMap.get(category) ?? 0;
    const override = overrideMap.get(category);
    let rawDefault: number;
    try {
      rawDefault = siteDailyLimit(category, environment);
    } catch {
      rawDefault = SITE_DAILY_DEFAULTS[category];
    }
    const defaultLimit = Number.isFinite(rawDefault) ? rawDefault : null;
    const customLimit = override ? override.daily_limit : null;
    const limit = customLimit ?? defaultLimit;
    return {
      category,
      used,
      limit,
      defaultLimit,
      customLimit,
      remaining: limit === null ? null : Math.max(0, limit - used),
      updatedAt: override ? override.updated_at.toISOString() : null,
    };
  });
}

/** 拥有者给某人单独调每日上限（命令行 pnpm users limit 或站长观测页）。 */
export async function setUserDailyLimit(
  pool: Pool,
  userId: string,
  category: UsageCategory,
  limit: number,
): Promise<void> {
  if (!isUsageCategory(category)) throw new Error("invalid usage category");
  assertValidLimit(limit);
  await pool.query(
    `INSERT INTO usage_limits (user_id, category, daily_limit) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, category) DO UPDATE SET daily_limit = EXCLUDED.daily_limit`,
    [userId, category, limit],
  );
}

/** 取消某人的单独上限覆盖，恢复为环境变量或系统默认。 */
export async function resetUserDailyLimit(
  pool: Pool,
  userId: string,
  category: UsageCategory,
): Promise<void> {
  if (!isUsageCategory(category)) throw new Error("invalid usage category");
  await pool.query("DELETE FROM usage_limits WHERE user_id = $1 AND category = $2", [
    userId,
    category,
  ]);
}

/** 站长动态调整全站每日上限，写入数据库并立即在后续账本预留中生效。 */
export async function setSiteDailyLimit(
  pool: Pool,
  category: UsageCategory,
  limit: number,
  now: Date = new Date(),
): Promise<void> {
  if (!isUsageCategory(category)) throw new Error("invalid usage category");
  assertValidLimit(limit);
  await pool.query(
    `INSERT INTO site_usage_limits (category, daily_limit, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (category) DO UPDATE SET daily_limit = EXCLUDED.daily_limit, updated_at = EXCLUDED.updated_at`,
    [category, limit, now],
  );
}

/** 取消全站某类上限的数据库覆盖，恢复为环境变量或系统默认。 */
export async function resetSiteDailyLimit(
  pool: Pool,
  category: UsageCategory,
): Promise<void> {
  if (!isUsageCategory(category)) throw new Error("invalid usage category");
  await pool.query("DELETE FROM site_usage_limits WHERE category = $1", [category]);
}
