import { DAY_LIMITS, DayRunError, type DayLimits } from "./day-contracts";

/** 运行配置只能收紧生产预算；测试或调用方不能借覆盖配置扩大模型、路线和耗时上限。 */
export function dayLimits(overrides: Partial<DayLimits> = {}): DayLimits {
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in DAY_LIMITS) || !Number.isSafeInteger(value) || value < 1 || value > DAY_LIMITS[key as keyof DayLimits]) {
      throw new TypeError("Day limits may only tighten the production bounds");
    }
  }
  return { ...DAY_LIMITS, ...overrides };
}

/** 对外部依赖同时施加父级取消与单次超时；即使依赖不响应取消，调用方也会停止等待。 */
export async function dayOperation<T>(options: {
  signal: AbortSignal;
  timeoutMs: number;
  operation: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  if (options.signal.aborted) throw new DayRunError("timeout");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, options.timeoutMs);
  let abort: () => void = () => {};
  try {
    // 只发 AbortSignal 依赖于对方配合；额外的拒绝 Promise 保证本层及时退出，迟到结果不会恢复流程。
    return await Promise.race([
      new Promise<never>((_, reject) => {
        abort = () => reject(new DayRunError("timeout"));
        controller.signal.addEventListener("abort", abort, { once: true });
      }),
      options.operation(controller.signal),
    ]);
  // 逐次移除监听器和计时器，避免多轮工具调用把取消监听累积在同一个父信号上。
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", abort);
    controller.abort();
  }
}
