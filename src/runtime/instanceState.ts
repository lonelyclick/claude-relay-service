export type RuntimePhase = 'starting' | 'ready' | 'draining' | 'stopped'
export type RuntimeServiceMode = 'relay' | 'server'

export type RuntimeSnapshot = {
  serviceMode: RuntimeServiceMode
  phase: RuntimePhase
  startedAt: string
  drainingStartedAt: string | null
  rejectNewRelayTrafficAt: string | null
  stoppedAt: string | null
  acceptsNewRelayTraffic: boolean
}

export class RuntimeState {
  private phase: RuntimePhase = 'starting'
  private readonly startedAtMs = Date.now()
  private drainingStartedAtMs: number | null = null
  private rejectNewRelayTrafficAtMs: number | null = null
  private stoppedAtMs: number | null = null

  constructor(
    private readonly serviceMode: RuntimeServiceMode,
    private readonly detachGraceMs: number,
  ) {}

  markReady(): void {
    if (this.phase === 'stopped') {
      return
    }
    this.phase = 'ready'
  }

  enterDraining(now = Date.now()): void {
    if (this.phase === 'stopped' || this.phase === 'draining') {
      return
    }
    this.phase = 'draining'
    this.drainingStartedAtMs = now
    this.rejectNewRelayTrafficAtMs =
      this.serviceMode === 'server'
        ? now
        : now + Math.max(0, this.detachGraceMs)
  }

  markStopped(now = Date.now()): void {
    this.phase = 'stopped'
    this.stoppedAtMs = now
  }

  isReady(): boolean {
    return this.phase === 'ready'
  }

  isLive(): boolean {
    return this.phase !== 'stopped'
  }

  acceptsNewRelayTraffic(now = Date.now()): boolean {
    if (this.serviceMode === 'server') {
      return false
    }
    if (this.phase === 'ready') {
      return true
    }
    if (this.phase !== 'draining') {
      return false
    }
    return now < (this.rejectNewRelayTrafficAtMs ?? now)
  }

  snapshot(now = Date.now()): RuntimeSnapshot {
    return {
      serviceMode: this.serviceMode,
      phase: this.phase,
      startedAt: new Date(this.startedAtMs).toISOString(),
      drainingStartedAt:
        this.drainingStartedAtMs === null
          ? null
          : new Date(this.drainingStartedAtMs).toISOString(),
      rejectNewRelayTrafficAt:
        this.rejectNewRelayTrafficAtMs === null
          ? null
          : new Date(this.rejectNewRelayTrafficAtMs).toISOString(),
      stoppedAt:
        this.stoppedAtMs === null ? null : new Date(this.stoppedAtMs).toISOString(),
      acceptsNewRelayTraffic: this.acceptsNewRelayTraffic(now),
    }
  }
}
