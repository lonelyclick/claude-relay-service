import { appConfig } from '../config.js'
import type { AccountHealthTracker } from '../scheduler/healthTracker.js'
import type { ProxyPool } from '../scheduler/proxyPool.js'
import { probeRateLimits } from '../usage/rateLimitProbe.js'
import { OAuthService } from './service.js'

const MAX_PROBE_BACKOFF_MS = 60 * 60 * 1000
const HEALTH_ERROR_PROBE_BACKOFF_THRESHOLD = 3

export class KeepAliveRefresher {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly consecutiveProbeFailures = new Map<string, number>()

  constructor(
    private readonly oauthService: OAuthService,
    private readonly proxyPool: ProxyPool | null = null,
    private readonly healthTracker: AccountHealthTracker | null = null,
  ) {}

  start(): void {
    if (!appConfig.accountKeepAliveEnabled || this.timer) {
      return
    }

    this.runTickSafely('startup')
    this.timer = setInterval(() => {
      this.runTickSafely('interval')
    }, appConfig.accountKeepAliveIntervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return
    }
    this.running = true

    try {
      const results = await this.oauthService.refreshDueAccountsForKeepAlive()
      if (results.length > 0) {
        const refreshed = results.filter((result) => result.ok)
        const failed = results.filter((result) => !result.ok)
        const parts = [
          `[keepalive] checked=${results.length}`,
          `refreshed=${refreshed.length}`,
          `failed=${failed.length}`,
        ]
        if (failed.length > 0) {
          const details = failed
            .slice(0, 3)
            .map((item) => `${item.accountId}:${item.error ?? 'unknown_error'}`)
            .join(', ')
          parts.push(`errors=${details}`)
        }
        process.stdout.write(`${parts.join(' ')}\n`)
      }

      const probeTargets = await this.oauthService.getAccountsForRateLimitProbe()
      const now = Date.now()
      const probeIntervalMs = appConfig.rateLimitProbeIntervalMs
      let probeOk = 0
      let probeErr = 0
      let probeSkipped = 0
      for (const account of probeTargets) {
        // Sync in-memory probe backoff from health tracker connection errors.
        // If the relay is seeing ≥3 connection errors in the window, treat it as a probe failure.
        if (this.healthTracker) {
          const recentErrors = this.healthTracker.getRecentFailureCount(account.id, ['connection_error', 'server_error'])
          if (recentErrors >= HEALTH_ERROR_PROBE_BACKOFF_THRESHOLD) {
            const cur = this.consecutiveProbeFailures.get(account.id) ?? 0
            this.consecutiveProbeFailures.set(account.id, Math.max(cur, 1))
          }
        }

        // Exponential backoff: skip if within the extended interval for failed accounts
        const failures = this.consecutiveProbeFailures.get(account.id) ?? 0
        if (failures > 0) {
          // lastProbeAttemptAt=null signals the account was re-enabled or re-logged-in;
          // reset in-memory failure count so backoff doesn't persist past account recovery.
          if (account.lastProbeAttemptAt == null) {
            this.consecutiveProbeFailures.delete(account.id)
          } else {
            const backoffMs = Math.min(probeIntervalMs * Math.pow(2, failures), MAX_PROBE_BACKOFF_MS)
            const lastAttempt = Math.max(
              account.lastRateLimitAt ? new Date(account.lastRateLimitAt).getTime() : 0,
              account.lastProbeAttemptAt,
            )
            if (now - lastAttempt < backoffMs) {
              probeSkipped++
              continue
            }
          }
        }

        // Record attempt time immediately (fire-and-forget)
        void this.oauthService.persistLastProbeAttemptAt(account.id, now)

        try {
          const proxyUrl = await this.oauthService.resolveProxyUrl(account.proxyUrl)
          const result = await probeRateLimits({
            accessToken: account.accessToken,
            proxyDispatcher: proxyUrl && this.proxyPool
              ? this.proxyPool.getHttpDispatcher(proxyUrl)
              : undefined,
            apiBaseUrl: appConfig.anthropicApiBaseUrl,
            anthropicVersion: appConfig.anthropicVersion,
            anthropicBeta: appConfig.oauthBetaHeader,
          })
          if (!result.error || result.error === 'rate_limited') {
            await this.oauthService.recordRateLimitSnapshot({
              accountId: account.id,
              status: result.status,
              fiveHourUtilization: result.fiveHourUtilization,
              sevenDayUtilization: result.sevenDayUtilization,
              resetTimestamp: result.reset,
              observedAt: new Date(result.probedAt).getTime(),
            })
            this.consecutiveProbeFailures.delete(account.id)
            probeOk++
          } else {
            // Re-read from map: if the reset path ran (delete), this yields 0+1=1 instead of stale+1
            this.consecutiveProbeFailures.set(account.id, (this.consecutiveProbeFailures.get(account.id) ?? 0) + 1)
            probeErr++
          }
        } catch {
          // Re-read from map: if the reset path ran (delete), this yields 0+1=1 instead of stale+1
          this.consecutiveProbeFailures.set(account.id, (this.consecutiveProbeFailures.get(account.id) ?? 0) + 1)
          probeErr++
        }
      }
      if (probeTargets.length > 0) {
        const parts = [`[keepalive] probe_targets=${probeTargets.length}`, `probe_ok=${probeOk}`, `probe_err=${probeErr}`]
        if (probeSkipped > 0) parts.push(`probe_skipped=${probeSkipped}`)
        process.stdout.write(`${parts.join(' ')}\n`)
      }
    } finally {
      this.running = false
    }
  }

  private runTickSafely(trigger: 'startup' | 'interval'): void {
    void this.tick().catch((error) => {
      process.stderr.write(
        `[keepalive] trigger=${trigger} error=${error instanceof Error ? error.message : String(error)}\n`,
      )
    })
  }
}
