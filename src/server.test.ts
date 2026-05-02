import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import test from 'node:test'
import pg from 'pg'

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'test-admin-token-1234567890'
process.env.ADMIN_UI_SESSION_SECRET = process.env.ADMIN_UI_SESSION_SECRET ?? 'test-admin-session-secret-1234567890'
delete process.env.INTERNAL_TOKEN
delete process.env.RELAY_CONTROL_URL
delete process.env.BETTER_AUTH_DATABASE_URL

const { appConfig } = await import('./config.js')
const { closeCorPgPool, createServer } = await import('./server.js')
const mutableAppConfig = appConfig as {
  relayControlUrl: string | null
  internalToken: string | null
  betterAuthDatabaseUrl: string | null
}
const mutablePoolPrototype = pg.Pool.prototype as unknown as {
  query: any
  connect: any
}

type MockQueryHandler = (sql: string, params: unknown[]) => Promise<unknown> | unknown
type HttpRequestListener = (req: unknown, res: unknown) => void

function normalizeSql(sql: unknown) {
  return String(sql).replace(/\s+/g, ' ').trim()
}

async function withMockCorPgPool(
  handlers: {
    query?: MockQueryHandler
    connectQuery?: MockQueryHandler
  },
  run: () => Promise<void>,
) {
  const previousBetterAuthDatabaseUrl = mutableAppConfig.betterAuthDatabaseUrl
  const originalQuery = mutablePoolPrototype.query
  const originalConnect = mutablePoolPrototype.connect
  const defaultQuery: MockQueryHandler = async (sql) => {
    throw new Error(`unexpected SQL: ${sql}`)
  }
  const queryHandler = handlers.query ?? defaultQuery
  const connectQueryHandler = handlers.connectQuery ?? queryHandler

  await closeCorPgPool()
  mutableAppConfig.betterAuthDatabaseUrl = 'postgresql://tester:secret@127.0.0.1:5432/cor'

  mutablePoolPrototype.query = async function patchedQuery(text: unknown, params?: unknown[]) {
    return queryHandler(normalizeSql(text), params ?? []) as never
  }

  mutablePoolPrototype.connect = async function patchedConnect() {
    return {
      query: async (text: unknown, params?: unknown[]) =>
        connectQueryHandler(normalizeSql(text), params ?? []) as never,
      release: () => {},
    } as never
  }

  try {
    await run()
  } finally {
    await closeCorPgPool()
    mutablePoolPrototype.query = originalQuery
    mutablePoolPrototype.connect = originalConnect
    mutableAppConfig.betterAuthDatabaseUrl = previousBetterAuthDatabaseUrl
  }
}

async function startHttpServer(listener: HttpRequestListener) {
  const server = createHttpServer(listener)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('failed to resolve test server address')
  }
  const baseUrl = `http://127.0.0.1:${address.port}`
  return {
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    },
  }
}

async function startServer(serviceOverrides: Record<string, unknown> = {}) {
  const baseServices = {
    serviceMode: 'server',
    oauthService: {
      listAccounts: async () => [],
      getDefaultAccountPreview: async () => null,
    },
    userStore: null,
    apiKeyStore: null,
    billingStore: null,
    supportStore: null,
    proxyPool: null,
    geminiLoopback: null,
    runtimeState: null,
    connectionTracker: null,
  }
  const app = createServer({
    ...baseServices,
    ...serviceOverrides,
    oauthService: {
      ...baseServices.oauthService,
      ...(serviceOverrides.oauthService as Record<string, unknown> | undefined),
    },
  })
  return startHttpServer(app as unknown as HttpRequestListener)
}

const adminHeaders = {
  authorization: 'Bearer test-admin-token-1234567890',
}

test('admin user delete returns relay_control_unavailable when relay control is not configured', async () => {
  const server = await startServer()
  try {
    const response = await fetch(`${server.baseUrl}/admin/users/test-user/delete`, {
      method: 'POST',
      headers: adminHeaders,
    })
    const body = await response.json()

    assert.equal(response.status, 503)
    assert.equal(body.error, 'relay_control_unavailable')
    assert.match(String(body.message ?? ''), /RELAY_CONTROL_URL|INTERNAL_TOKEN/)
  } finally {
    await server.close()
  }
})

test('better-auth admin list-users returns better_auth_db_unavailable when local DB is not configured', async () => {
  const server = await startServer()
  try {
    const response = await fetch(`${server.baseUrl}/admin/better-auth/admin/list-users`, {
      headers: adminHeaders,
    })
    const body = await response.json()

    assert.equal(response.status, 503)
    assert.equal(body.error, 'better_auth_db_unavailable')
    assert.equal(body.message, 'BETTER_AUTH_DATABASE_URL is not configured')
  } finally {
    await server.close()
  }
})

test('better-auth users overview preserves upstream better-auth DB unavailability as 503', async () => {
  const server = await startServer()
  try {
    const response = await fetch(`${server.baseUrl}/admin/better-auth/users`, {
      headers: adminHeaders,
    })
    const body = await response.json()

    assert.equal(response.status, 503)
    assert.equal(body.error, 'better_auth_db_unavailable')
    assert.equal(body.message, 'BETTER_AUTH_DATABASE_URL is not configured')
  } finally {
    await server.close()
  }
})

test('admin user delete keeps relay 200 when Better Auth cleanup is unavailable', async () => {
  const previousRelayControlUrl = mutableAppConfig.relayControlUrl
  const previousInternalToken = mutableAppConfig.internalToken
  mutableAppConfig.relayControlUrl = null
  mutableAppConfig.internalToken = null

  const relayControl = await startHttpServer((req: any, res: any) => {
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/internal/control/users/test-user/delete')
    assert.equal(req.headers.authorization, 'Bearer relay-control-token-123456')
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, deletedUserId: 'test-user' }))
  })

  mutableAppConfig.relayControlUrl = relayControl.baseUrl
  mutableAppConfig.internalToken = 'relay-control-token-123456'

  const server = await startServer({
    userStore: {
      getUserById: async (userId: string) => ({
        id: userId,
        externalUserId: 'better-auth-user-1',
        name: 'Test User',
      }),
    },
  })

  try {
    const response = await fetch(`${server.baseUrl}/admin/users/test-user/delete`, {
      method: 'POST',
      headers: adminHeaders,
    })
    const body = await response.json()

    assert.equal(response.status, 200)
    assert.deepEqual(body, { ok: true, deletedUserId: 'test-user' })
  } finally {
    mutableAppConfig.relayControlUrl = previousRelayControlUrl
    mutableAppConfig.internalToken = previousInternalToken
    await server.close()
    await relayControl.close()
  }
})

test('better-auth user create reports partial warning when relay profile sync fails', async () => {
  await withMockCorPgPool(
    {
      connectQuery: async (sql, params) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') {
          return { rows: [] }
        }
        if (sql.includes('SELECT id FROM "user" WHERE LOWER(email) = LOWER($1) LIMIT 1')) {
          assert.deepEqual(params, ['alice@example.com'])
          return { rows: [] }
        }
        if (sql.includes('INSERT INTO "user"')) {
          return {
            rows: [{
              id: 'better-user-1',
              name: 'Alice',
              email: 'alice@example.com',
              emailVerified: false,
              image: null,
              role: 'user',
              banned: false,
              banReason: null,
              banExpires: null,
              createdAt: '2026-04-30T00:00:00.000Z',
              updatedAt: '2026-04-30T00:00:00.000Z',
            }],
          }
        }
        throw new Error(`unexpected SQL in connectQuery: ${sql}`)
      },
    },
    async () => {
      const server = await startServer({
        userStore: {
          findOrCreateByExternalId: async () => {
            throw new Error('relay profile sync exploded')
          },
        },
      })

      try {
        const response = await fetch(`${server.baseUrl}/admin/better-auth/users`, {
          method: 'POST',
          headers: {
            ...adminHeaders,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            email: 'alice@example.com',
            name: 'Alice',
          }),
        })
        const body = await response.json()

        assert.equal(response.status, 200)
        assert.equal(body.ok, true)
        assert.equal(body.user.id, 'better-user-1')
        assert.equal(body.partial, true)
        assert.equal(body.warnings.length, 1)
        assert.equal(body.warnings[0].code, 'followup_operation_failed')
        assert.match(body.warnings[0].operation, /sync relay user after Better Auth create better-user-1/)
        assert.match(body.warnings[0].message, /relay profile sync exploded/)
      } finally {
        await server.close()
      }
    },
  )
})

test('better-auth user create reports partial warning when organization membership step fails', async () => {
  await withMockCorPgPool(
    {
      query: async (sql) => {
        if (sql.includes('INSERT INTO member')) {
          throw new Error('organization membership exploded')
        }
        if (sql.includes('FROM organization ORDER BY "createdAt" DESC NULLS LAST')) {
          return {
            rows: [{
              id: 'org-1',
              name: 'Org One',
              slug: 'org-one',
              logo: null,
              metadata: { relayOrgId: 'relay-org-1' },
              createdAt: '2026-04-30T00:00:00.000Z',
              updatedAt: '2026-04-30T00:00:00.000Z',
            }],
          }
        }
        throw new Error(`unexpected SQL in query: ${sql}`)
      },
      connectQuery: async (sql, params) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') {
          return { rows: [] }
        }
        if (sql.includes('SELECT id FROM "user" WHERE LOWER(email) = LOWER($1) LIMIT 1')) {
          assert.deepEqual(params, ['alice@example.com'])
          return { rows: [] }
        }
        if (sql.includes('INSERT INTO "user"')) {
          return {
            rows: [{
              id: 'better-user-2',
              name: 'Alice',
              email: 'alice@example.com',
              emailVerified: false,
              image: null,
              role: 'user',
              banned: false,
              banReason: null,
              banExpires: null,
              createdAt: '2026-04-30T00:00:00.000Z',
              updatedAt: '2026-04-30T00:00:00.000Z',
            }],
          }
        }
        throw new Error(`unexpected SQL in connectQuery: ${sql}`)
      },
    },
    async () => {
      const server = await startServer({
        userStore: {
          findOrCreateByExternalId: async () => ({
            user: { id: 'relay-user-1' },
            created: true,
          }),
        },
      })

      try {
        const response = await fetch(`${server.baseUrl}/admin/better-auth/users`, {
          method: 'POST',
          headers: {
            ...adminHeaders,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            email: 'alice@example.com',
            name: 'Alice',
            organizationId: 'org-1',
          }),
        })
        const body = await response.json()

        assert.equal(response.status, 200)
        assert.equal(body.ok, true)
        assert.equal(body.user.id, 'better-user-2')
        assert.equal(body.partial, true)
        assert.equal(body.warnings.length, 1)
        assert.equal(body.warnings[0].code, 'followup_operation_failed')
        assert.match(body.warnings[0].operation, /add Better Auth user better-user-2 to organization org-1/)
        assert.match(body.warnings[0].message, /organization membership exploded/)
      } finally {
        await server.close()
      }
    },
  )
})

test('better-auth user delete reports partial warning when relay cleanup fails', async () => {
  await withMockCorPgPool(
    {
      query: async (sql, params) => {
        if (sql === 'DELETE FROM "user" WHERE id = $1') {
          assert.deepEqual(params, ['better-user-1'])
          return { rows: [] }
        }
        throw new Error(`unexpected SQL in query: ${sql}`)
      },
    },
    async () => {
      const server = await startServer({
        userStore: {
          getUserByExternalId: async (externalUserId: string) => {
            assert.equal(externalUserId, 'better-user-1')
            return { id: 'relay-user-1' }
          },
          deleteUser: async () => {
            throw new Error('relay delete exploded')
          },
        },
      })

      try {
        const response = await fetch(`${server.baseUrl}/admin/better-auth/users/better-user-1/delete`, {
          method: 'POST',
          headers: adminHeaders,
        })
        const body = await response.json()

        assert.equal(response.status, 200)
        assert.equal(body.success, true)
        assert.equal(body.partial, true)
        assert.equal(body.warnings.length, 1)
        assert.equal(body.warnings[0].code, 'followup_operation_failed')
        assert.match(body.warnings[0].operation, /delete relay user after Better Auth delete better-user-1/)
        assert.match(body.warnings[0].message, /relay delete exploded/)
      } finally {
        await server.close()
      }
    },
  )
})

test('better-auth users overview keeps serving data when relay backfill fails', async () => {
  await withMockCorPgPool(
    {
      query: async (sql) => {
        if (sql.includes('FROM "user"') && sql.includes('ORDER BY "createdAt" DESC')) {
          return {
            rows: [{
              id: 'better-user-1',
              name: 'Alice',
              email: 'alice@example.com',
              emailVerified: false,
              image: null,
              role: 'user',
              banned: false,
              banReason: null,
              banExpires: null,
              createdAt: '2026-04-30T00:00:00.000Z',
              updatedAt: '2026-04-30T00:00:00.000Z',
            }],
          }
        }
        if (sql === 'SELECT COUNT(*)::int AS total FROM "user"') {
          return { rows: [{ total: 1 }] }
        }
        if (sql.includes('FROM organization ORDER BY "createdAt" DESC NULLS LAST')) {
          return { rows: [] }
        }
        throw new Error(`unexpected SQL in query: ${sql}`)
      },
    },
    async () => {
      const server = await startServer({
        userStore: {
          listUsersWithUsage: async () => [],
          findOrCreateByExternalId: async () => {
            throw new Error('relay backfill exploded')
          },
        },
      })

      try {
        const response = await fetch(`${server.baseUrl}/admin/better-auth/users`, {
          headers: adminHeaders,
        })
        const body = await response.json()

        assert.equal(response.status, 200)
        assert.equal(body.ok, true)
        assert.equal(body.users.length, 1)
        assert.equal(body.users[0].id, 'better-user-1')
        assert.equal(body.users[0].relay, null)
      } finally {
        await server.close()
      }
    },
  )
})

test('better-auth users overview queries Better Auth user table schema', async () => {
  await withMockCorPgPool(
    {
      query: async (sql) => {
        if (sql.includes('FROM "user"') && sql.includes('ORDER BY "createdAt" DESC')) {
          return {
            rows: [{
              id: 'better-user-1',
              name: 'Alice',
              email: 'alice@example.com',
              emailVerified: false,
              image: null,
              role: 'user',
              banned: false,
              banReason: null,
              banExpires: null,
              createdAt: '2026-04-30T00:00:00.000Z',
              updatedAt: '2026-04-30T00:00:00.000Z',
            }],
          }
        }
        if (sql === 'SELECT COUNT(*)::int AS total FROM "user"') {
          return { rows: [{ total: 1 }] }
        }
        if (sql.includes('FROM organization ORDER BY "createdAt" DESC NULLS LAST')) {
          return { rows: [] }
        }
        throw new Error(`unexpected SQL in query: ${sql}`)
      },
    },
    async () => {
      const server = await startServer({
        userStore: {
          listUsersWithUsage: async () => [],
          findOrCreateByExternalId: async () => null,
        },
      })

      try {
        const response = await fetch(`${server.baseUrl}/admin/better-auth/users`, {
          headers: adminHeaders,
        })
        const body = await response.json()

        assert.equal(response.status, 200)
        assert.equal(body.ok, true)
        assert.equal(body.users.length, 1)
        assert.equal(body.users[0].id, 'better-user-1')
      } finally {
        await server.close()
      }
    },
  )
})
