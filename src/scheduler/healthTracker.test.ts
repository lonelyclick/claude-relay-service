import assert from 'node:assert/strict'
import test from 'node:test'
import { AccountHealthTracker } from './healthTracker.js'

function makeTracker(windowMs = 5 * 60 * 1000, errorThreshold = 10) {
  return new AccountHealthTracker({ windowMs, errorThreshold })
}

// ─── Health score ────────────────────────────────────────────────────────────

test('new account has perfect health score', () => {
  const tracker = makeTracker()
  assert.equal(tracker.getHealthScore('unknown'), 1.0)
})

test('429 responses reduce health score', () => {
  const tracker = makeTracker()
  tracker.recordResponse('acct-1', 429)
  const score = tracker.getHealthScore('acct-1')
  assert.ok(score < 1.0)
  assert.ok(score > 0)
})

test('5xx responses reduce health score more than 429', () => {
  const tracker = makeTracker()
  const tracker2 = makeTracker()

  tracker.recordResponse('acct', 429)
  tracker2.recordResponse('acct', 500)

  assert.ok(tracker2.getHealthScore('acct') < tracker.getHealthScore('acct'))
})

test('2xx/4xx responses do not affect health score', () => {
  const tracker = makeTracker()
  tracker.recordResponse('acct', 200)
  tracker.recordResponse('acct', 403)
  tracker.recordResponse('acct', 404)
  assert.equal(tracker.getHealthScore('acct'), 1.0)
})

test('health score floors at 0 when errors exceed threshold', () => {
  const tracker = makeTracker(5 * 60 * 1000, 10)
  // 5xx has weight 2, so 5 errors × 2 weight = 10 = threshold
  for (let i = 0; i < 5; i++) {
    tracker.recordResponse('acct', 500)
  }
  assert.equal(tracker.getHealthScore('acct'), 0)
})

test('recordError adds connection-level error with weight 2', () => {
  const tracker = makeTracker()
  tracker.recordError('acct')
  const scoreAfterError = tracker.getHealthScore('acct')
  // weight 2 / threshold 10 = 0.2 reduction
  assert.equal(scoreAfterError, 0.8)
})

// ─── Rate limiting ──────────────────────────────────────────────────────────

test('429 with retry-after sets rate limit', () => {
  const tracker = makeTracker()
  tracker.recordResponse('acct', 429, 60)

  assert.ok(tracker.isRateLimited('acct'))
  const until = tracker.getRateLimitedUntil('acct')
  assert.ok(until !== null)
  assert.ok(until! > Date.now())
})

test('429 without retry-after does not set rate limit', () => {
  const tracker = makeTracker()
  tracker.recordResponse('acct', 429)

  assert.equal(tracker.isRateLimited('acct'), false)
  assert.equal(tracker.getRateLimitedUntil('acct'), null)
})

test('expired rate limit returns null without mutating state', () => {
  const tracker = makeTracker()
  // Set rate limit that expires immediately
  tracker.recordResponse('acct', 429, -1)

  assert.equal(tracker.getRateLimitedUntil('acct'), null)
  assert.equal(tracker.isRateLimited('acct'), false)
})

test('multiple 429s extend rate limit to the latest', () => {
  const tracker = makeTracker()
  tracker.recordResponse('acct', 429, 30)
  tracker.recordResponse('acct', 429, 120)

  const until = tracker.getRateLimitedUntil('acct')!
  // Should be ~120s from now, not 30s
  assert.ok(until > Date.now() + 100_000)
})

// ─── pruneRateLimits ────────────────────────────────────────────────────────

test('pruneRateLimits clears expired rate limits', () => {
  const tracker = makeTracker()
  tracker.recordResponse('acct', 429, -1) // already expired

  tracker.pruneRateLimits()
  // After pruning, the internal state should be cleaned up
  assert.equal(tracker.isRateLimited('acct'), false)
})

// ─── Snapshot ───────────────────────────────────────────────────────────────

test('getSnapshot returns health info for all tracked accounts', () => {
  const tracker = makeTracker()
  tracker.recordResponse('acct-1', 500)
  tracker.recordResponse('acct-2', 429, 60)

  const snapshot = tracker.getSnapshot()
  assert.equal(snapshot.size, 2)
  assert.ok(snapshot.get('acct-1')!.healthScore < 1)
  assert.equal(snapshot.get('acct-1')!.errorCount, 1)
  assert.ok(snapshot.get('acct-2')!.rateLimitedUntil !== null)
})

// ─── Lifecycle ──────────────────────────────────────────────────────────────

test('removeAccount clears tracking state', () => {
  const tracker = makeTracker()
  tracker.recordResponse('acct', 500)
  tracker.removeAccount('acct')
  assert.equal(tracker.getHealthScore('acct'), 1.0)
})

test('clear removes all tracking state', () => {
  const tracker = makeTracker()
  tracker.recordResponse('acct-1', 500)
  tracker.recordResponse('acct-2', 429, 60)
  tracker.clear()
  assert.equal(tracker.getHealthScore('acct-1'), 1.0)
  assert.equal(tracker.getHealthScore('acct-2'), 1.0)
  assert.equal(tracker.getSnapshot().size, 0)
})
