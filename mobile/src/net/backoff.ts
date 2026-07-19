// 断线重连退避：指数增长 + full jitter（AWS「Exponential Backoff And Jitter」）。
// delay = round(rng() * min(capMs, baseMs * factor^attempt))。
// full jitter（整段乘 rng）比固定 1s 重连更能摊平重连风暴，且窗口有上限 capMs。
// rng 注入（默认 Math.random）→ jitter 可确定性单测。

export interface BackoffOpts {
  baseMs?: number;
  factor?: number;
  capMs?: number;
}

export function backoffDelay(
  attempt: number,
  rng: () => number = Math.random,
  opts: BackoffOpts = {}
): number {
  const { baseMs = 500, factor = 2, capMs = 8000 } = opts;
  // 先 min 再乘 rng：baseMs*factor^attempt 对大 attempt 会溢到 Infinity，
  // Math.min(cap, Infinity) === cap，天然防溢出、无需限制 attempt 上界。
  const ceiling = Math.min(capMs, baseMs * Math.pow(factor, attempt));
  return Math.round(rng() * ceiling);
}
