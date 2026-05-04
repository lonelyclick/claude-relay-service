import { appConfig } from '../config.js'
import { isGeminiOauthAccount, retrieveGeminiUserQuota } from '../providers/googleGeminiOauth.js'
import type { AccountHealthTracker } from '../scheduler/healthTracker.js'
import type { ProxyPool } from '../scheduler/proxyPool.js'
import { probeRateLimits } from '../usage/rateLimitProbe.js'
import { OAuthService } from './service.js'

const MAX_PROBE_BACKOFF_MS = 60 * 60 * 1000
const HEALTH_ERROR_PROBE_BACKOFF_THRESHOLD = 3
const OVERAGE_PROBE_LEAD_MS = 60 * 1000
const OVERAGE_PROBE_MIN_INTERVAL_MS = 30 * 60 * 1000
const OVERAGE_PROBE_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000

export class KeepAliveRefresher {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly consecutiveProbeFailures = new Map<string, number>()
  private readonly overageProbeLastAt = new Map<string, number>()
  private readonly overageProbeBackoffMs = new Map<string, number>()

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

        // Record attempt time immediately (fire-and-forget; failure must be logged
        // or the next tick will keep retrying without backoff).
        void this.oauthService.persistLastProbeAttemptAt(account.id, now).catch((error) => {
          process.stderr.write(
            `[keepalive] persist_last_probe_at_failed account=${account.id} error=${error instanceof Error ? error.message : String(error)}\n`,
          )
        })

        try {
          const proxyUrl = await this.oauthService.resolveProxyUrl(account.proxyUrl)
          const proxyDispatcher = proxyUrl && this.proxyPool
            ? this.proxyPool.getHttpDispatcher(proxyUrl)
            : undefined
          const result = isGeminiOauthAccount(account)
            ? await retrieveGeminiUserQuota({
              accessToken: account.accessToken,
              account,
              proxyDispatcher,
            })
            : await probeRateLimits({
              accessToken: account.accessToken,
              proxyDispatcher,
              apiBaseUrl: appConfig.anthropicApiBaseUrl,
              anthropicVersion: appConfig.anthropicVersion,
              anthropicBeta: appConfig.oauthBetaHeader,
            })
          if (!result.error || result.error === 'rate_limited' || result.error.startsWith('rate_limited:')) {
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

      await this.tickOverageGuardProbes(now)
    } finally {
      this.running = false
    }
  }

  private async tickOverageGuardProbes(now: number): Promise<void> {
    const accounts = await this.oauthService.listAccounts()
    const candidates = accounts.filter((account) => {
      if (account.provider !== 'claude-official') return false
      if (account.status === 'revoked' || account.status === 'banned') return false
      if (!account.accessToken) return false
      const reason = account.autoBlockedReason ?? ''
      if (!reason.includes('anthropic_overage_disabled')) return false
      const cooldownUntil = account.cooldownUntil ?? 0
      if (cooldownUntil <= 0) return false
      const lead = cooldownUntil - now
      if (lead < -60_000) return false
      if (lead > OVERAGE_PROBE_LEAD_MS) return false
      const lastAt = this.overageProbeLastAt.get(account.id) ?? 0
      if (now - lastAt < OVERAGE_PROBE_MIN_INTERVAL_MS) return false
      return true
    })
    if (candidates.length === 0) return

    let probedReasonStillPresent = 0
    let probedReasonCleared = 0
    for (const account of candidates) {
      this.overageProbeLastAt.set(account.id, now)
      try {
        const proxyUrl = await this.oauthService.resolveProxyUrl(account.proxyUrl)
        const proxyDispatcher = proxyUrl && this.proxyPool
          ? this.proxyPool.getHttpDispatcher(proxyUrl)
          : undefined
        const result = await probeRateLimits({
          accessToken: account.accessToken,
          proxyDispatcher,
          apiBaseUrl: appConfig.anthropicApiBaseUrl,
          anthropicVersion: appConfig.anthropicVersion,
          anthropicBeta: appConfig.oauthBetaHeader,
        })
        const stillDisabled =
          typeof result.overageDisabledReason === 'string' &&
          result.overageDisabledReason.trim() !== '' &&
          result.overageDisabledReason !== 'no_overage_purchased'
        if (stillDisabled) {
          probedReasonStillPresent++
          const previous = this.overageProbeBackoffMs.get(account.id) ?? 30 * 60 * 1000
          const next = Math.min(previous * 2, OVERAGE_PROBE_MAX_BACKOFF_MS)
          this.overageProbeBackoffMs.set(account.id, next)
          const guardReason = [
            'anthropic_overage_disabled',
            'phase=cooldown_expiry_probe',
            `headerReason=${result.overageDisabledReason}`,
            `overageStatus=${result.overageStatus ?? '-'}`,
            `unifiedStatus=${result.status ?? '-'}`,
            `representativeClaim=${result.representativeClaim ?? '-'}`,
            `fallback=${result.fallbackPercentage ?? '-'}`,
            `backoffMs=${next}`,
          ].join('|')
          await this.oauthService.markAccountRiskGuardrail(account.id, guardReason, next)
          process.stdout.write(
            `[overage-probe] still_disabled account=${account.id} reason=${result.overageDisabledReason} backoff=${next}\n`,
          )
        } else {
          probedReasonCleared++
          this.overageProbeBackoffMs.delete(account.id)
          process.stdout.write(
            `[overage-probe] cleared account=${account.id} unifiedStatus=${result.status ?? '-'}\n`,
          )
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        process.stderr.write(
          `[overage-probe] probe_failed account=${account.id} error=${message}\n`,
        )
      }
    }
    if (candidates.length > 0) {
      process.stdout.write(
        `[overage-probe] probed=${candidates.length} still_disabled=${probedReasonStillPresent} cleared=${probedReasonCleared}\n`,
      )
    }
  }

  private runTickSafely(trigger: 'startup' | 'interval'): void {
    void this.tick().catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      const stack = error instanceof Error && error.stack ? error.stack.split('\n').slice(0, 4).join(' | ') : ''
      process.stderr.write(
        `[keepalive] tick_failed trigger=${trigger} error=${message}${stack ? ` stack=${stack}` : ''}\n`,
      )
    })
  }
}
