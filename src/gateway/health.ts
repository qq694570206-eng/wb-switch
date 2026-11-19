/**
 * 后端健康表：熔断器 + 冷却 + 统计（纯内存，随进程重启清零——本地工具可接受）。
 *
 * 三层状态，全部以 profile/model 为 key（同一源不同模型独立计数）：
 *
 *  1. 熔断器（瞬时故障用）：
 *     closed --连续 threshold 次瞬时失败--> open
 *     open --冷却到期--> half-open（放行 1 个探测请求）
 *     half-open --探测成功--> closed（清零）
 *     half-open --探测失败--> open（冷却翻倍，上限 maxCooldown）
 *
 *  2. 冷却（确定性故障用，与熔断计数无关）：
 *     速率型 429 → 冷却至 Retry-After 到期
 *     配额型 429 / 401 / 403 → 长冷却（30min / 60min）
 *
 *  3. 统计（可观测性）：成功/失败计数、成功率窗口、p95 延迟、当前 inflight
 */

/** 失败的分类（与转发层的判定一一对应） */
export type FailureKind =
  | 'transient' // 网络错误 / 超时 / 5xx / 408 → 计熔断、可重试
  | 'rate' // 429 速率型 → 冷却至 Retry-After
  | 'quota' // 429 配额型 / 余额不足 → 长冷却 30min
  | 'auth' // 401 / 403 → 长冷却 60min
  | 'client' // 400 / 404 等客户端错误 → 不计健康（多半是模型名错配）
  | 'stream' // 流式中断 → 轻度计数（阈值×2）
  | 'aborted'; // 客户端取消 → 不计健康

export interface HealthConfig {
  /** 连续瞬时失败多少次进 open */
  threshold: number;
  /** open 初始冷却（ms） */
  cooldownMs: number;
  /** 冷却上限（翻倍封顶） */
  maxCooldownMs: number;
  /** 配额型长冷却（ms） */
  quotaCooldownMs: number;
  /** 鉴权长冷却（ms） */
  authCooldownMs: number;
}

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  threshold: 5,
  cooldownMs: 30_000,
  maxCooldownMs: 300_000,
  quotaCooldownMs: 30 * 60_000,
  authCooldownMs: 60 * 60_000,
};

interface CircuitState {
  status: 'closed' | 'open' | 'half-open' | 'cooldown';
  consecutiveFails: number;
  /** open/cooldown 状态下的冷却到期时间戳 */
  cooldownUntil: number;
  /** 当前冷却时长（探测失败后翻倍） */
  currentCooldown: number;
  /** half-open 期间是否有探测请求在途 */
  probing: boolean;
  /** cooldown 前的熔断状态（冷却到期后回到该状态） */
  prevStatus: 'closed' | 'open';
}

interface StatsState {
  ok: number;
  fail: number;
  inflight: number;
  /** 最近延迟样本（环形，最多 64 个） */
  latencies: number[];
  lastError?: string;
  lastOkAt?: number;
}

export interface BackendSnapshot {
  key: string;
  circuit: 'closed' | 'open' | 'half-open' | 'cooldown';
  available: boolean;
  cooldownRemainMs: number;
  consecutiveFails: number;
  ok: number;
  fail: number;
  inflight: number;
  p95: number | null;
  successRate: number | null;
  lastError?: string;
  lastOkAt?: string | null;
}

export class BackendHealthTable {
  private circuits = new Map<string, CircuitState>();
  private stats = new Map<string, StatsState>();
  constructor(private config: HealthConfig = DEFAULT_HEALTH_CONFIG) {}

  // ─────────────────────────── 查询 ───────────────────────────

  /** 后端当前是否可被调度（closed 或 half-open 有探测名额；cooldown 未到期不可用） */
  isAvailable(key: string): boolean {
    const c = this.circuits.get(key);
    if (!c) return true;
    if (c.status === 'closed') return true;
    if (c.status === 'cooldown') return Date.now() >= c.cooldownUntil;
    if (c.status === 'open') return Date.now() >= c.cooldownUntil;
    // half-open：放行一个探测
    return !c.probing;
  }

  /** 调度前领取探测名额（half-open 时只允许 1 个在途） */
  acquireProbeSlot(key: string): boolean {
    const c = this.circuits.get(key);
    if (!c || c.status !== 'half-open') return true; // 非 half-open 无限制
    if (c.probing) return false;
    c.probing = true;
    return true;
  }

  releaseProbeSlot(key: string): void {
    const c = this.circuits.get(key);
    if (c) c.probing = false;
  }

  cooldownRemainMs(key: string): number {
    const c = this.circuits.get(key);
    if (!c || (c.status !== 'open' && c.status !== 'cooldown')) return 0;
    return Math.max(0, c.cooldownUntil - Date.now());
  }

  /** inflight 计数（信号量用） */
  inflightOf(key: string): number {
    return this.stats.get(key)?.inflight ?? 0;
  }

  // ─────────────────────────── 写入 ───────────────────────────

  beginInflight(key: string): void {
    const s = this.ensureStats(key);
    s.inflight++;
  }

  endInflight(key: string): void {
    const s = this.ensureStats(key);
    s.inflight = Math.max(0, s.inflight - 1);
  }

  /** 记一次成功：清零失败、关闭熔断 */
  recordOk(key: string, latencyMs: number): void {
    const s = this.ensureStats(key);
    s.ok++;
    s.latencies.push(latencyMs);
    if (s.latencies.length > 64) s.latencies.shift();
    s.lastOkAt = Date.now();

    const c = this.circuits.get(key);
    if (c) {
      // 任何成功（含 half-open 探测 / cooldown 期间）→ 完全恢复
      c.status = 'closed';
      c.prevStatus = 'closed';
      c.consecutiveFails = 0;
      c.currentCooldown = this.config.cooldownMs;
      c.probing = false;
      c.cooldownUntil = 0;
    }
  }

  /** 记一次失败（按分类走不同路径） */
  recordFail(key: string, kind: FailureKind, detail = '', retryAfterMs?: number): void {
    const s = this.ensureStats(key);
    s.fail++;
    s.lastError = `${kind}${detail ? ': ' + detail : ''}`;

    switch (kind) {
      case 'transient':
        this.bumpCircuit(key);
        break;
      case 'rate':
        // 速率冷却：Retry-After 到期即恢复，不进熔断计数
        this.applyCooldown(key, Math.max(retryAfterMs ?? 5_000, 1_000));
        break;
      case 'quota':
        this.applyCooldown(key, this.config.quotaCooldownMs);
        break;
      case 'auth':
        this.applyCooldown(key, this.config.authCooldownMs);
        break;
      case 'stream':
        // 轻度：阈值 ×2 才熔断——半计数（两次 stream 记 1 次 transient）
        this.bumpCircuit(key, 0.5);
        break;
      case 'client':
      case 'aborted':
        break; // 不计健康
    }
  }

  /** 熔断推进（weight 支持流式半计数） */
  private bumpCircuit(key: string, weight = 1): void {
    const c = this.ensureCircuit(key);
    if (c.status === 'half-open') {
      // 探测失败：冷却翻倍再 open
      c.currentCooldown = Math.min(c.currentCooldown * 2, this.config.maxCooldownMs);
      c.status = 'open';
      c.probing = false;
      c.cooldownUntil = Date.now() + c.currentCooldown;
      c.consecutiveFails = 0;
      return;
    }
    if (c.status === 'open' || c.status === 'cooldown') {
      // cooldown 期间再遇瞬时失败：升级回 open（沿用熔断冷却）
      if (c.status === 'cooldown') {
        c.status = 'open';
        c.prevStatus = 'open';
      }
      return;
    }
    c.consecutiveFails += weight;
    if (c.consecutiveFails >= this.config.threshold) {
      c.status = 'open';
      c.cooldownUntil = Date.now() + c.currentCooldown;
      c.consecutiveFails = 0;
    }
  }

  /** 冷却到期后，调度层发现可用时把 open/cooldown → half-open / closed（懒转换） */
  tryEnterHalfOpen(key: string): void {
    const c = this.circuits.get(key);
    if (!c) return;
    if (c.status === 'open' && Date.now() >= c.cooldownUntil) {
      c.status = 'half-open';
      return;
    }
    if (c.status === 'cooldown' && Date.now() >= c.cooldownUntil) {
      // 冷却到期：回到之前的熔断状态（原 closed → closed；原 open → half-open 走探测）
      c.status = c.prevStatus === 'open' ? 'half-open' : 'closed';
      if (c.status === 'closed') c.cooldownUntil = 0;
    }
  }

  private applyCooldown(key: string, ms: number): void {
    const c = this.ensureCircuit(key);
    const until = Date.now() + ms;
    if (until > c.cooldownUntil) {
      c.cooldownUntil = until;
      if (c.status === 'closed') {
        c.status = 'cooldown';
        c.prevStatus = 'closed';
      } else if (c.status === 'open') {
        // open 期间收到确定性失败（如配额）：保持 open 语义但延长冷却
        c.prevStatus = 'open';
      }
    }
  }

  // ─────────────────────────── 快照 ───────────────────────────

  snapshot(): BackendSnapshot[] {
    const out: BackendSnapshot[] = [];
    for (const [key, s] of this.stats) {
      const c = this.circuits.get(key);
      const status = c?.status ?? 'closed';
      out.push({
        key,
        circuit: status === 'cooldown' ? 'cooldown' : status,
        available: this.isAvailable(key),
        cooldownRemainMs: this.cooldownRemainMs(key),
        consecutiveFails: c?.consecutiveFails ?? 0,
        ok: s.ok,
        fail: s.fail,
        inflight: s.inflight,
        p95: p95(s.latencies),
        successRate: s.ok + s.fail > 0 ? s.ok / (s.ok + s.fail) : null,
        lastError: s.lastError,
        lastOkAt: s.lastOkAt ? new Date(s.lastOkAt).toISOString() : null,
      });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  // ─────────────────────────── 内部 ───────────────────────────

  private ensureCircuit(key: string): CircuitState {
    let c = this.circuits.get(key);
    if (!c) {
      c = {
        status: 'closed',
        consecutiveFails: 0,
        cooldownUntil: 0,
        currentCooldown: this.config.cooldownMs,
        probing: false,
        prevStatus: 'closed',
      };
      this.circuits.set(key, c);
    }
    return c;
  }

  private ensureStats(key: string): StatsState {
    let s = this.stats.get(key);
    if (!s) {
      s = { ok: 0, fail: 0, inflight: 0, latencies: [] };
      this.stats.set(key, s);
    }
    return s;
  }
}

function p95(latencies: number[]): number | null {
  if (latencies.length === 0) return null;
  const sorted = [...latencies].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx]!;
}
