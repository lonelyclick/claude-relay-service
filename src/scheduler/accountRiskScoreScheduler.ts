import { appConfig } from '../config.js'
import type { AccountRiskService } from '../usage/accountRiskService.js'
import type { OAuthService } from '../oauth/service.js'

export class AccountRiskScoreScheduler {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private deprioritizedAccountIds = new Set<string>()

  constructor(
    private readonly oauthService: OAuthService,
    private readonly accountRiskService: AccountRiskService,
    private readonly intervalMs: number,
  ) {
    this.oauthService.setDeprioritizedAccountIdsProvider(() => this.deprioritizedAccountIds)
  }

  getDeprioritizedAccountIds(): ReadonlySet<string> {
    return this.deprioritizedAccountIds
  }

  start(): void {
    if (this.timer || this.intervalMs <= 0) return
    const run = () => {
      void this.refresh().catch((error) => {
        process.stderr.write(`[account-risk-score] refresh_failed error=${error instanceof Error ? error.message : String(error)}\n`)
      })
    }
    run()
    this.timer = setInterval(run, this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async refresh(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const accounts = await this.oauthService.listAccounts()
      const snapshots = await this.accountRiskService.scoreAccounts(accounts, { persist: true })
      const targetBands = new Set(appConfig.accountRiskDeprioritizeBands)
      const next = new Set<string>()
      for (const snap of snapshots) {
        if (targetBands.has(snap.band)) next.add(snap.accountId)
      }
      this.deprioritizedAccountIds = next
      process.stdout.write(
        `[account-risk-score] refreshed accounts=${snapshots.length} deprioritized=${next.size} bands=${appConfig.accountRiskDeprioritizeBands.join(',')} enabled=${appConfig.accountRiskDeprioritizeEnabled}\n`,
      )
    } finally {
      this.running = false
    }
  }
}
