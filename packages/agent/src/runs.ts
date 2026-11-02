import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * V3.0 运行记录（stages/V3.0.md §3.2–3.4）。一次请求一个根运行，下面是各 Agent 的子运行和步骤；结构参照
 * OpenTelemetry 的 span（编号、父、根、起止时间、状态、属性），只存在自己的数据库或内存里，不发到外部。
 * 当前运行用 AsyncLocalStorage 传：Agent 入口建子运行，模型传输层和计量依赖在这里记次数、扣共用预算。
 * 没有当前运行时（单元测试、直接调用）这些都不做，行为和原来一样。
 */
export type RunStatus = "running" | "ok" | "none" | "failed" | "fallback" | "budget_exhausted" | "cancelled";
export type StepKind = "model_call" | "tool_call" | "check" | "repair" | "handoff" | "fallback";
/** 按次数计的请求类别（与用量账本的类别相同）。 */
export type RunCategory = "model" | "amap" | "web" | "embed" | "jev";

export interface RunLinks {
  readonly conversationId?: string;
  readonly journeyId?: string;
  readonly tripId?: string;
}

/** 一个根运行下所有 Agent 共用的上限；不写的类别不限。`ms` 是从根运行开始算的总耗时。 */
export type RunBudget = Partial<Record<RunCategory | "ms", number>>;

export interface RunCounts {
  model: number;
  amap: number;
  web: number;
  embed: number;
  jev: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
}

export interface RunRecord {
  readonly id: string;
  readonly rootId: string;
  readonly parentId: string | null;
  readonly userId: string | null;
  readonly agent: string;
  readonly version: string | null;
  readonly trigger: string | null;
  readonly links: RunLinks;
  readonly status: RunStatus;
  readonly outcome: string | null;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly counts: Readonly<RunCounts>;
}

export interface StepRecord {
  readonly runId: string;
  readonly seq: number;
  readonly kind: StepKind;
  readonly name: string;
  readonly latencyMs: number | null;
  readonly summary: Readonly<Record<string, unknown>>;
  readonly at: Date;
}

/** 根运行结束时一次写入整棵树（数据库版在 packages/db，评测用内存版）。 */
export interface RunSink {
  write(runs: readonly RunRecord[], steps: readonly StepRecord[]): Promise<void>;
}

export class RunBudgetError extends Error {
  constructor(readonly category: RunCategory | "ms") {
    super(`run budget exhausted: ${category}`);
  }
}

/** 一个运行最多记这么多步，防止循环把记录撑大；超出的只计数。 */
const STEP_LIMIT = 200;
const SAFE_NAME = /^[A-Za-z0-9_.:>+→-]{1,80}$/;
const emptyCounts = (): RunCounts => ({ model: 0, amap: 0, web: 0, embed: 0, jev: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 });

interface RootState {
  budget: RunBudget;
  readonly sink: RunSink | null;
  /** 不是 Agent 的入口（打开页面、改卡片）：一次请求都没发就不写记录。 */
  readonly skipEmpty: boolean;
  readonly now: () => number;
  readonly runs: AgentRun[];
  readonly steps: StepRecord[];
  readonly spent: Record<RunCategory, number>;
  exhausted: RunCategory | "ms" | null;
}

export class AgentRun {
  readonly id = randomUUID();
  readonly rootId: string;
  readonly startedAt: Date;
  readonly counts = emptyCounts();
  private readonly attributes: Record<string, unknown>;
  private status: RunStatus = "running";
  private outcome: string | null = null;
  private finishedAt: Date | null = null;
  private seq = 0;
  private dropped = 0;
  private allowed: readonly RunCategory[] | null = null;

  private constructor(
    private readonly state: RootState,
    readonly parent: AgentRun | null,
    readonly agent: string,
    readonly version: string | null,
    readonly trigger: string | null,
    readonly userId: string | null,
    private links: RunLinks,
    attributes: Record<string, unknown>,
  ) {
    this.rootId = parent?.rootId ?? this.id;
    this.startedAt = new Date(state.now());
    this.attributes = { ...attributes };
    state.runs.push(this);
  }

  static root(options: {
    readonly trigger: string;
    readonly agent?: string;
    readonly version?: string;
    readonly userId?: string | null;
    readonly links?: RunLinks;
    readonly attributes?: Record<string, unknown>;
    readonly budget?: RunBudget;
    readonly sink?: RunSink | null;
    readonly skipEmpty?: boolean;
    readonly now?: () => number;
  }): AgentRun {
    const state: RootState = {
      budget: options.budget ?? {},
      sink: options.sink ?? null,
      skipEmpty: options.skipEmpty ?? false,
      now: options.now ?? Date.now,
      runs: [],
      steps: [],
      spent: { model: 0, amap: 0, web: 0, embed: 0, jev: 0 },
      exhausted: null,
    };
    return new AgentRun(
      state, null, options.agent ?? options.trigger, options.version ?? null, options.trigger,
      options.userId ?? null, options.links ?? {}, options.attributes ?? {},
    );
  }

  get isRoot(): boolean {
    return this.parent === null;
  }

  /** 预算用完的类别（没有用完是 null）；根运行据此记为 budget_exhausted。 */
  get exhausted(): RunCategory | "ms" | null {
    return this.state.exhausted;
  }

  get finished(): boolean {
    return this.status !== "running";
  }

  child(agent: string, options: { readonly version?: string; readonly links?: RunLinks; readonly attributes?: Record<string, unknown> } = {}): AgentRun {
    return new AgentRun(
      this.state, this, agent, options.version ?? null, null, this.userId, options.links ?? {}, options.attributes ?? {},
    );
  }

  /** 记一步。摘要只放短的结构化内容（动作、提示码、数量、编号），调用方负责不放地址、坐标、正文。 */
  /** `at` 给事后补记的步骤用（如对话的分流发生在一轮开头）。 */
  step(kind: StepKind, name: string, summary: Record<string, unknown> = {}, latencyMs?: number, at?: Date): void {
    if (this.finished) return;
    if (this.seq >= STEP_LIMIT) {
      this.dropped += 1;
      return;
    }
    this.seq += 1;
    this.state.steps.push({
      runId: this.id,
      seq: this.seq,
      kind,
      name: SAFE_NAME.test(name) ? name : "unnamed",
      latencyMs: latencyMs === undefined ? null : Math.max(0, Math.round(latencyMs)),
      summary,
      at: at ?? new Date(this.state.now()),
    });
  }

  /** 给这个运行最近的一次模型调用补上 Agent 自己才知道的内容（如对话的决定）。 */
  note(summary: Record<string, unknown>): void {
    const last = [...this.state.steps].reverse().find((item) => item.runId === this.id && item.kind === "model_call");
    if (last) (last as { summary: Record<string, unknown> }).summary = { ...last.summary, ...summary };
  }

  /** 这个 Agent 契约里允许的请求类别；用了别的记一步 check（不拦）。 */
  allow(categories: readonly RunCategory[]): void {
    this.allowed = categories;
  }

  /** 入口知道规模之后再定预算（如出游按要排的天数）；只对根运行有效。 */
  limit(budget: RunBudget): void {
    if (this.isRoot) this.state.budget = budget;
  }

  /** 入口确认对象属于这个用户之后再挂上关联（找不到时不挂）。 */
  link(links: RunLinks): void {
    this.links = { ...this.links, ...links };
  }

  set(attributes: Record<string, unknown>): void {
    Object.assign(this.attributes, attributes);
  }

  /**
   * 发请求之前扣共用预算：根运行的总数到上限就抛 RunBudgetError，请求不发。扣成功后这个运行和它的
   * 所有上级都加一次（每个运行看到的是自己这棵子树的次数）。
   */
  spend(category: RunCategory): void {
    const { budget, spent } = this.state;
    const elapsed = this.state.now() - this.root.startedAt.getTime();
    if (budget.ms !== undefined && elapsed > budget.ms) {
      this.state.exhausted ??= "ms";
      throw new RunBudgetError("ms");
    }
    const limit = budget[category];
    if (limit !== undefined && spent[category] >= limit) {
      this.state.exhausted ??= category;
      throw new RunBudgetError(category);
    }
    spent[category] += 1;
    if (this.allowed && !this.allowed.includes(category)) this.step("check", "tool", { allowed: false, category });
    for (const run of this.lineage()) run.counts[category] += 1;
  }

  addTokens(usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheHitTokens?: number | null }): void {
    for (const run of this.lineage()) {
      run.counts.inputTokens += usage.inputTokens;
      run.counts.outputTokens += usage.outputTokens;
      run.counts.cacheHitTokens += usage.cacheHitTokens ?? 0;
    }
  }

  /** 自己和所有上级。 */
  private lineage(): AgentRun[] {
    return this.parent ? [this, ...this.parent.lineage()] : [this];
  }

  get root(): AgentRun {
    return this.parent ? this.parent.root : this;
  }

  /** 结束这个运行；根运行结束时把整棵树交给记录器，写不进去只打一条不含内容的警告。 */
  async finish(status: Exclude<RunStatus, "running">, outcome?: string | null): Promise<void> {
    if (this.finished) return;
    this.status = this.isRoot && this.state.exhausted ? "budget_exhausted" : status;
    this.outcome = outcome ?? null;
    this.finishedAt = new Date(this.state.now());
    if (this.dropped) this.attributes.droppedSteps = this.dropped;
    if (!this.isRoot) return;
    // 根运行结束时还没结束的子运行（取消、异常提前返回）记为取消。
    for (const run of this.state.runs) {
      if (!run.finished) {
        run.status = "cancelled";
        run.finishedAt = this.finishedAt;
      }
    }
    if (!this.state.sink) return;
    const spent = Object.values(this.state.spent).some((count) => count > 0);
    if (this.state.skipEmpty && !spent && this.state.runs.length === 1 && !this.state.steps.length) return;
    try {
      await this.state.sink.write(this.state.runs.map((run) => run.record()), this.state.steps);
    } catch {
      console.warn(`[runs] could not record run ${this.id}`);
    }
  }

  /** 这棵树里的所有运行（根运行可用；评测按 Agent 汇总时读）。 */
  tree(): { readonly runs: readonly RunRecord[]; readonly steps: readonly StepRecord[] } {
    return { runs: this.state.runs.map((run) => run.record()), steps: [...this.state.steps] };
  }

  record(): RunRecord {
    return {
      id: this.id,
      rootId: this.rootId,
      parentId: this.parent?.id ?? null,
      userId: this.userId,
      agent: this.agent,
      version: this.version,
      trigger: this.trigger,
      links: this.links,
      status: this.status,
      outcome: this.outcome,
      attributes: { ...this.attributes },
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      counts: { ...this.counts },
    };
  }
}

const storage = new AsyncLocalStorage<AgentRun>();

export function currentRun(): AgentRun | undefined {
  return storage.getStore();
}

export function withRun<T>(run: AgentRun, operation: () => Promise<T>): Promise<T> {
  return storage.run(run, operation);
}

export interface RunResult {
  readonly status: Exclude<RunStatus, "running">;
  readonly outcome?: string | null;
}

/** 异常时的结果码：带 code 的错误用它的 code（只取标识符形状的），其余记 internal_error。 */
export function errorOutcome(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (error instanceof RunBudgetError) return `budget_${error.category}`;
  return typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : "internal_error";
}

/** 在一个运行里执行：结束时按 classify 记状态，抛错记 failed。根运行结束时写入记录。 */
export async function runIn<T>(
  run: AgentRun,
  operation: (run: AgentRun) => Promise<T>,
  classify: (value: T) => RunResult,
): Promise<T> {
  let value: T;
  try {
    value = await withRun(run, () => operation(run));
  } catch (error) {
    await run.finish("failed", errorOutcome(error));
    throw error;
  }
  const result = classify(value);
  await run.finish(result.status, result.outcome);
  return value;
}

/**
 * 在当前运行下建一个 Agent 子运行再执行；没有当前运行时直接执行（不记录）。各 Agent 的入口用它。
 */
export function inChildRun<T>(
  agent: string,
  options: { readonly version?: string; readonly links?: RunLinks; readonly attributes?: Record<string, unknown> },
  operation: (run: AgentRun | null) => Promise<T>,
  classify: (value: T) => RunResult,
): Promise<T> {
  const parent = currentRun();
  if (!parent) return operation(null);
  return runIn(parent.child(agent, options), operation, classify);
}

/** 评测和测试用：把整棵树留在内存里。 */
export class MemoryRunSink implements RunSink {
  readonly runs: RunRecord[] = [];
  readonly steps: StepRecord[] = [];

  async write(runs: readonly RunRecord[], steps: readonly StepRecord[]): Promise<void> {
    this.runs.push(...runs);
    this.steps.push(...steps);
  }
}
