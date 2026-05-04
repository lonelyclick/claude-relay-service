import pg from 'pg'

export type AccountRiskBand = 'safe' | 'watch' | 'cautious' | 'critical'

export type AccountRiskFactor = {
  code: string
  category: 'upstream' | 'behavior' | 'warmup' | 'identity' | 'sibling' | 'local_error' | 'recovery' | 'floor' | 'shadow'
  weight: number
  rawValue: unknown
  contribution: number
  description: string
}

export type AccountRiskRecommendedAction = {
  code: string
  label: string
  description: string
  shadowOnly: boolean
}

export type AccountRiskSnapshot = {
  accountId: string
  scoredAt: string
  score: number
  band: AccountRiskBand
  floorScore: number
  factors: AccountRiskFactor[]
  recommendedActions: AccountRiskRecommendedAction[]
  shadow: {
    wouldAvoidNewSessions: boolean
    wouldDeprioritize: boolean
    reason: string | null
  }
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS account_risk_scores (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  score INTEGER NOT NULL,
  band TEXT NOT NULL,
  floor_score INTEGER NOT NULL DEFAULT 0,
  factors_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommended_actions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  shadow_json JSONB NOT NULL DEFAULT '{}'::jsonb
);
`

const CREATE_INDEXES_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_account_risk_scores_account_scored ON account_risk_scores (account_id, scored_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_account_risk_scores_scored ON account_risk_scores (scored_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_account_risk_scores_band_scored ON account_risk_scores (band, scored_at DESC)',
]

export class AccountRiskStore {
  private readonly pool: pg.Pool

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 3 })
  }

  async ensureTable(): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query(CREATE_TABLE_SQL)
      for (const sql of CREATE_INDEXES_SQL) {
        await client.query(sql)
      }
    } finally {
      client.release()
    }
  }

  async insertSnapshot(snapshot: AccountRiskSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO account_risk_scores (
        account_id, scored_at, score, band, floor_score,
        factors_json, recommended_actions_json, shadow_json
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb)`,
      [
        snapshot.accountId,
        snapshot.scoredAt,
        snapshot.score,
        snapshot.band,
        snapshot.floorScore,
        JSON.stringify(snapshot.factors),
        JSON.stringify(snapshot.recommendedActions),
        JSON.stringify(snapshot.shadow),
      ],
    )
  }

  async listLatest(input: { limit?: number; band?: AccountRiskBand | null } = {}): Promise<AccountRiskSnapshot[]> {
    const params: unknown[] = []
    const bandFilter = input.band ? `WHERE band = $${params.push(input.band)}` : ''
    const limit = Math.max(1, Math.min(input.limit ?? 200, 1000))
    params.push(limit)
    const { rows } = await this.pool.query(
      `WITH ranked AS (
         SELECT *, row_number() OVER (PARTITION BY account_id ORDER BY scored_at DESC, id DESC) AS rn
         FROM account_risk_scores
       )
       SELECT * FROM ranked
       WHERE rn = 1
       ${bandFilter ? `AND account_id IN (SELECT account_id FROM ranked ${bandFilter} AND rn = 1)` : ''}
       ORDER BY score DESC, scored_at DESC
       LIMIT $${params.length}`,
      params,
    )
    return rows.map(mapSnapshotRow)
  }

  async getHistory(accountId: string, limit: number = 96): Promise<AccountRiskSnapshot[]> {
    const capped = Math.max(1, Math.min(limit, 500))
    const { rows } = await this.pool.query(
      `SELECT * FROM account_risk_scores WHERE account_id = $1 ORDER BY scored_at DESC, id DESC LIMIT $2`,
      [accountId, capped],
    )
    return rows.map(mapSnapshotRow).reverse()
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

function mapSnapshotRow(row: Record<string, unknown>): AccountRiskSnapshot {
  return {
    accountId: String(row.account_id ?? ''),
    scoredAt: (row.scored_at as Date)?.toISOString?.() ?? String(row.scored_at ?? ''),
    score: Number(row.score ?? 0),
    band: String(row.band ?? 'safe') as AccountRiskBand,
    floorScore: Number(row.floor_score ?? 0),
    factors: Array.isArray(row.factors_json) ? row.factors_json as AccountRiskFactor[] : [],
    recommendedActions: Array.isArray(row.recommended_actions_json)
      ? row.recommended_actions_json as AccountRiskRecommendedAction[]
      : [],
    shadow: typeof row.shadow_json === 'object' && row.shadow_json
      ? row.shadow_json as AccountRiskSnapshot['shadow']
      : { wouldAvoidNewSessions: false, wouldDeprioritize: false, reason: null },
  }
}
