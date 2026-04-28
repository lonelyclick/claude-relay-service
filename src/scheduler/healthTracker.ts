export interface HealthTrackerConfig {
  windowMs: number
  errorThreshold: number
}

interface ErrorRecord {
  kind: 'connection_error' | 'rate_limit' | 'server_error'
  timestamp: number
  weight: number
}

interface AccountHealth {
  errors: ErrorRecord[]
  rateLimitedUntil: number | null
}

export class AccountHealthTracker {
  private readonly states = new Map<string, AccountHealth>()

  constructor(private readonly config: HealthTrackerConfig) {}

  /**
   * Record an upstream HTTP response for an account.
   * 429 → weight 1 + sets rateLimitedUntil from retry-after header.
   * 5xx → weight 2.
   * 2xx/3xx/4xx (non-429) → no error recorded.
   */
  recordResponse(accountId: string, statusCode: number, retryAfterSeconds?: number): void {
    if (statusCode === 429) {
      const state = this.ensureState(accountId)
      state.errors.push({ kind: 'rate_limit', timestamp: Date.now(), weight: 1 })
      if (typeof retryAfterSeconds === 'number' && retryAfterSeconds > 0) {
        const until = Date.now() + retryAfterSeconds * 1000
        state.rateLimitedUntil =
          state.rateLimitedUntil !== null ? Math.max(state.rateLimitedUntil, until) : until
      }
      return
    }

    if (statusCode >= 500) {
      const state = this.ensureState(accountId)
      state.errors.push({ kind: 'server_error', timestamp: Date.now(), weight: 2 })
      return
    }
  }

  /**
   * Record a connection-level error (timeout, DNS failure, etc.).
   */
  recordError(accountId: string): void {
    const state = this.ensureState(accountId)
    state.errors.push({ kind: 'connection_error', timestamp: Date.now(), weight: 2 })
  }

  getRecentFailureCount(
    accountId: string,
    kinds: ReadonlyArray<ErrorRecord['kind']>,
  ): number {
    const state = this.states.get(accountId)
    if (!state) {
      return 0
    }
    this.pruneExpired(state)
    const kindSet = new Set(kinds)
    return state.errors.filter((entry) => kindSet.has(entry.kind)).length
  }

  /**
   * Get the current health score for an account (0.0 ~ 1.0).
   * 1.0 = fully healthy, 0.0 = at or above error threshold.
   */
  getHealthScore(accountId: string): number {
    const state = this.states.get(accountId)
    if (!state) {
      return 1.0
    }
    this.pruneExpired(state)
    const weightedSum = state.errors.reduce((sum, e) => sum + e.weight, 0)
    return Math.max(0, 1 - weightedSum / this.config.errorThreshold)
  }

  /**
   * Get the rate-limited-until timestamp for an account.
   * Returns null if the account is not currently rate-limited.
   */
  getRateLimitedUntil(accountId: string): number | null {
    const state = this.states.get(accountId)
    if (!state?.rateLimitedUntil) {
      return null
    }
    if (state.rateLimitedUntil <= Date.now()) {
      return null
    }
    return state.rateLimitedUntil
  }

  /**
   * Prune expired rate-limit state. Call periodically or before writes.
   */
  pruneRateLimits(): void {
    const now = Date.now()
    for (const state of this.states.values()) {
      if (state.rateLimitedUntil !== null && state.rateLimitedUntil <= now) {
        state.rateLimitedUntil = null
      }
    }
  }

  /**
   * Check if account is currently rate-limited.
   */
  isRateLimited(accountId: string): boolean {
    return this.getRateLimitedUntil(accountId) !== null
  }

  /**
   * Get a snapshot of all tracked accounts' health.
   */
  getSnapshot(): Map<string, { healthScore: number; errorCount: number; rateLimitedUntil: number | null }> {
    const result = new Map<string, { healthScore: number; errorCount: number; rateLimitedUntil: number | null }>()
    for (const [accountId, state] of this.states) {
      this.pruneExpired(state)
      result.set(accountId, {
        healthScore: this.getHealthScore(accountId),
        errorCount: state.errors.length,
        rateLimitedUntil: this.getRateLimitedUntil(accountId),
      })
    }
    return result
  }

  /**
   * Restore rateLimitedUntil from persistent storage on startup.
   */
  restoreRateLimitedUntil(accountId: string, until: number): void {
    const state = this.ensureState(accountId)
    if (state.rateLimitedUntil === null || until > state.rateLimitedUntil) {
      state.rateLimitedUntil = until
    }
  }

  /**
   * Clear all health state for an account (errors + rate-limit ban).
   * Call after successful re-login so stale fault data doesn't persist.
   */
  clearAccountHealth(accountId: string): void {
    const state = this.states.get(accountId)
    if (state) {
      state.errors = []
      state.rateLimitedUntil = null
    }
  }

  /**
   * Remove tracking state for a deleted account.
   */
  removeAccount(accountId: string): void {
    this.states.delete(accountId)
  }

  clear(): void {
    this.states.clear()
  }

  private ensureState(accountId: string): AccountHealth {
    let state = this.states.get(accountId)
    if (!state) {
      state = { errors: [], rateLimitedUntil: null }
      this.states.set(accountId, state)
    }
    return state
  }

  private pruneExpired(state: AccountHealth): void {
    const cutoff = Date.now() - this.config.windowMs
    state.errors = state.errors.filter((e) => e.timestamp > cutoff)
  }
}
