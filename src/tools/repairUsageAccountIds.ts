import 'dotenv/config'

import pg from 'pg'

type AccountRow = {
  id: string
  email: string | null
  label: string | null
  provider: string | null
}

type OrphanUsageRow = {
  account_id: string
  total_requests: number
  first_at: Date | string | null
  last_at: Date | string | null
}

type RepairCandidate = {
  fromAccountId: string
  toAccountId: string
  reason: string
  requestCount: number
}

type ParsedArgs = {
  execute: boolean
  manualMappings: Map<string, string>
}

function parseArgs(argv: string[]): ParsedArgs {
  const manualMappings = new Map<string, string>()
  let execute = false

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--execute') {
      execute = true
      continue
    }
    if (arg === '--map') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('Missing value for --map, expected oldAccountId=newAccountId')
      }
      index += 1
      const separatorIndex = value.indexOf('=')
      if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
        throw new Error(`Invalid --map value "${value}", expected oldAccountId=newAccountId`)
      }
      const from = value.slice(0, separatorIndex).trim()
      const to = value.slice(separatorIndex + 1).trim()
      if (!from || !to) {
        throw new Error(`Invalid --map value "${value}", expected oldAccountId=newAccountId`)
      }
      manualMappings.set(from, to)
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  return { execute, manualMappings }
}

function toIso(value: Date | string | null): string | null {
  if (!value) {
    return null
  }
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}

function summarizeAccount(account: AccountRow | undefined): string {
  if (!account) {
    return '(missing)'
  }
  return `${account.id} [${account.provider ?? 'unknown'} | ${account.email ?? 'no-email'} | ${account.label ?? 'no-label'}]`
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required')
  }

  const args = parseArgs(process.argv.slice(2))
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()

  try {
    const accountsResult = await client.query<AccountRow>(`
      SELECT
        id,
        data->>'emailAddress' AS email,
        data->>'label' AS label,
        data->>'provider' AS provider
      FROM accounts
      ORDER BY id
    `)

    const orphanUsageResult = await client.query<OrphanUsageRow>(`
      SELECT
        account_id,
        COUNT(*)::int AS total_requests,
        MIN(created_at) AS first_at,
        MAX(created_at) AS last_at
      FROM usage_records
      WHERE account_id IS NOT NULL
        AND account_id NOT IN (SELECT id FROM accounts)
      GROUP BY account_id
      ORDER BY account_id
    `)

    const accounts = accountsResult.rows
    const orphanUsage = orphanUsageResult.rows

    if (orphanUsage.length === 0) {
      console.log('No orphan usage account ids found.')
      return
    }

    const accountById = new Map(accounts.map((account) => [account.id, account]))
    const accountsByEmail = new Map<string, AccountRow[]>()
    for (const account of accounts) {
      const email = account.email?.trim().toLowerCase()
      if (!email) {
        continue
      }
      const group = accountsByEmail.get(email) ?? []
      group.push(account)
      accountsByEmail.set(email, group)
    }

    const candidates: RepairCandidate[] = []
    const unresolved: Array<{ accountId: string; requestCount: number; reason: string }> = []

    for (const orphan of orphanUsage) {
      const fromAccountId = orphan.account_id
      const manualTarget = args.manualMappings.get(fromAccountId)
      if (manualTarget) {
        if (!accountById.has(manualTarget)) {
          throw new Error(`Manual mapping target does not exist in accounts: ${manualTarget}`)
        }
        candidates.push({
          fromAccountId,
          toAccountId: manualTarget,
          reason: 'manual_mapping',
          requestCount: Number(orphan.total_requests),
        })
        continue
      }

      if (fromAccountId.startsWith('email:')) {
        const derivedEmail = fromAccountId.slice('email:'.length).trim().toLowerCase()
        const matches = derivedEmail ? (accountsByEmail.get(derivedEmail) ?? []) : []
        if (matches.length === 1) {
          candidates.push({
            fromAccountId,
            toAccountId: matches[0].id,
            reason: `matched_email:${derivedEmail}`,
            requestCount: Number(orphan.total_requests),
          })
          continue
        }
        if (matches.length > 1) {
          unresolved.push({
            accountId: fromAccountId,
            requestCount: Number(orphan.total_requests),
            reason: `multiple_accounts_share_email:${derivedEmail}`,
          })
          continue
        }
      }

      unresolved.push({
        accountId: fromAccountId,
        requestCount: Number(orphan.total_requests),
        reason: 'no_safe_mapping',
      })
    }

    console.log(`Mode: ${args.execute ? 'EXECUTE' : 'DRY_RUN'}`)
    console.log(`Orphan account ids found: ${orphanUsage.length}`)
    console.log('')
    console.log('Repair candidates:')
    if (candidates.length === 0) {
      console.log('  (none)')
    } else {
      for (const candidate of candidates) {
        console.log(`  - ${candidate.fromAccountId} -> ${candidate.toAccountId}`)
        console.log(`    reason=${candidate.reason} requests=${candidate.requestCount}`)
        console.log(`    target=${summarizeAccount(accountById.get(candidate.toAccountId))}`)
      }
    }

    console.log('')
    console.log('Unresolved:')
    if (unresolved.length === 0) {
      console.log('  (none)')
    } else {
      for (const item of unresolved) {
        console.log(`  - ${item.accountId} requests=${item.requestCount} reason=${item.reason}`)
      }
    }

    console.log('')
    console.log('Current orphan usage windows:')
    for (const orphan of orphanUsage) {
      console.log(
        `  - ${orphan.account_id} requests=${Number(orphan.total_requests)} first=${toIso(orphan.first_at)} last=${toIso(orphan.last_at)}`,
      )
    }

    if (!args.execute) {
      console.log('')
      console.log('Dry run only. Re-run with --execute to apply safe mappings.')
      return
    }

    if (candidates.length === 0) {
      console.log('')
      console.log('No safe mappings to apply.')
      return
    }

    await client.query('BEGIN')
    try {
      for (const candidate of candidates) {
        const result = await client.query(
          `UPDATE usage_records
           SET account_id = $2
           WHERE account_id = $1`,
          [candidate.fromAccountId, candidate.toAccountId],
        )
        console.log(`Applied: ${candidate.fromAccountId} -> ${candidate.toAccountId} (${result.rowCount ?? 0} rows)`)
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    }

    const remainingResult = await client.query<{ account_id: string }>(`
      SELECT DISTINCT account_id
      FROM usage_records
      WHERE account_id IS NOT NULL
        AND account_id NOT IN (SELECT id FROM accounts)
      ORDER BY account_id
    `)

    console.log('')
    console.log(`Remaining orphan account ids: ${remainingResult.rowCount ?? remainingResult.rows.length}`)
    for (const row of remainingResult.rows) {
      console.log(`  - ${row.account_id}`)
    }
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error('Repair failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
