export type ConnectionSnapshot = {
  activeHttpRequests: number
  activeStreams: number
  activeWebSockets: number
}

function once(fn: () => void): () => void {
  let called = false
  return () => {
    if (called) {
      return
    }
    called = true
    fn()
  }
}

export class ConnectionTracker {
  private activeHttpRequests = 0
  private activeStreams = 0
  private activeWebSockets = 0

  beginHttpRequest(): () => void {
    this.activeHttpRequests += 1
    return once(() => {
      this.activeHttpRequests = Math.max(0, this.activeHttpRequests - 1)
    })
  }

  beginStream(): () => void {
    this.activeStreams += 1
    return once(() => {
      this.activeStreams = Math.max(0, this.activeStreams - 1)
    })
  }

  beginWebSocket(): () => void {
    this.activeWebSockets += 1
    return once(() => {
      this.activeWebSockets = Math.max(0, this.activeWebSockets - 1)
    })
  }

  snapshot(): ConnectionSnapshot {
    return {
      activeHttpRequests: this.activeHttpRequests,
      activeStreams: this.activeStreams,
      activeWebSockets: this.activeWebSockets,
    }
  }
}
