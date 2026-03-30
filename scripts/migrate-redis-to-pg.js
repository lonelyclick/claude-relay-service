#!/usr/bin/env node
/**
 * Redis → PostgreSQL 一次性迁移脚本
 *
 * 迁移内容：
 * 1. Claude 账户 (claude:account:*)
 * 2. Claude Console 账户 (claude_console_account:*)
 * 3. Bedrock 账户 (bedrock_account:*)
 * 4. Gemini 账户 (gemini_account:*)
 * 5. Gemini API 账户 (gemini_api_account:*)
 * 6. OpenAI 账户 (openai:account:*)
 * 7. OpenAI Responses 账户 (openai_responses_account:*)
 * 8. Azure OpenAI 账户 (azure_openai:account:*)
 * 9. CCR 账户 (ccr_account:*)
 * 11. API Keys (apikey:*)
 * 12. Users (user:*)
 * 13. Account Groups (account_group:*)
 * 14. Account Test Configs (account:test_config:*)
 * 15. Balance Script Configs (account_balance_script:*)
 *
 * 用法: node scripts/migrate-redis-to-pg.js [--dry-run]
 */

require('dotenv').config()
const Redis = require('ioredis')
const config = require('../config/config')
const pg = require('../src/models/pg')
const dal = require('../src/models/dal')

const DRY_RUN = process.argv.includes('--dry-run')

let redis

function createRedis() {
  const opts = {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password || undefined,
    db: config.redis.db || 0,
    lazyConnect: false
  }
  if (config.redis.enableTLS) {
    opts.tls = { rejectUnauthorized: false }
  }
  return new Redis(opts)
}

async function scanKeys(pattern) {
  const keys = []
  let cursor = '0'
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200)
    cursor = next
    keys.push(...batch)
  } while (cursor !== '0')
  return keys
}

// ============================================================
// 账户迁移（10 种平台）
// ============================================================

const ACCOUNT_PLATFORMS = [
  { pattern: 'claude:account:*', platform: 'claude', index: 'claude:account:index', type: 'hash' },
  {
    pattern: 'claude_console_account:*',
    platform: 'claude-console',
    index: 'claude_console_account:index',
    type: 'hash'
  },
  {
    pattern: 'bedrock_account:*',
    platform: 'bedrock',
    index: 'bedrock_account:index',
    type: 'json'
  },
  { pattern: 'gemini_account:*', platform: 'gemini', index: 'gemini_account:index', type: 'hash' },
  {
    pattern: 'gemini_api_account:*',
    platform: 'gemini-api',
    index: 'gemini_api_account:index',
    type: 'hash'
  },
  { pattern: 'openai:account:*', platform: 'openai', index: 'openai:account:index', type: 'hash' },
  {
    pattern: 'openai_responses_account:*',
    platform: 'openai-responses',
    index: 'openai_responses_account:index',
    type: 'hash'
  },
  {
    pattern: 'azure_openai:account:*',
    platform: 'azure-openai',
    index: 'azure_openai:account:index',
    type: 'hash'
  },
  { pattern: 'ccr_account:*', platform: 'ccr', index: 'ccr_account:index', type: 'hash' }
]

async function migrateAccounts() {
  let total = 0

  for (const { pattern, platform, index, type } of ACCOUNT_PLATFORMS) {
    // 优先用 index set 获取 ID，fallback 到 scan
    let accountIds = []
    try {
      accountIds = await redis.smembers(index)
    } catch {
      /* ignore */
    }

    if (!accountIds.length) {
      const keys = await scanKeys(pattern)
      // 过滤掉 index 和 empty 标记
      accountIds = keys
        .filter((k) => !k.endsWith(':index') && !k.endsWith(':empty'))
        .map((k) => {
          // 从 key 中提取 ID
          const parts = k.split(':')
          // claude:account:{id} → id 在最后
          // claude_console_account:{id} → id 在最后
          return parts[parts.length - 1]
        })
    }

    if (!accountIds.length) {
      console.log(`  ⏭️  ${platform}: 0 accounts`)
      continue
    }

    let migrated = 0
    for (const id of accountIds) {
      try {
        let data
        // 根据存储类型读取
        if (type === 'json') {
          // Bedrock 用 JSON string 存储
          const keyName = pattern.replace('*', id)
          const raw = await redis.get(keyName)
          if (!raw) {
            continue
          }
          data = JSON.parse(raw)
        } else {
          // 其他用 Hash 存储
          const keyName = pattern.replace('*', id)
          data = await redis.hgetall(keyName)
          if (!data || Object.keys(data).length === 0) {
            continue
          }
        }

        if (!data.id) {
          data.id = id
        }

        if (!DRY_RUN) {
          await dal.accounts.setAccount(id, data, platform)
        }
        migrated++
      } catch (err) {
        console.error(`  ❌ ${platform}:${id} failed:`, err.message)
      }
    }

    console.log(`  ✅ ${platform}: ${migrated}/${accountIds.length} accounts migrated`)
    total += migrated
  }

  return total
}

// ============================================================
// API Keys 迁移
// ============================================================

async function migrateApiKeys() {
  // 先尝试用 index
  let keyIds = []
  try {
    keyIds = await redis.smembers('apikey:idx:all')
  } catch {
    /* ignore */
  }

  if (!keyIds.length) {
    const keys = await scanKeys('apikey:*')
    keyIds = keys
      .filter(
        (k) =>
          !k.includes('hash_map') &&
          !k.includes('apikey_hash:') &&
          !k.includes(':index') &&
          !k.includes(':tags:') &&
          !k.includes(':idx:')
      )
      .map((k) => k.replace('apikey:', ''))
  }

  console.log(`  Found ${keyIds.length} API keys`)

  let migrated = 0
  for (const keyId of keyIds) {
    try {
      const data = await redis.hgetall(`apikey:${keyId}`)
      if (!data || Object.keys(data).length === 0) {
        continue
      }

      if (!DRY_RUN) {
        await dal.apiKeys.setApiKey(keyId, data)
      }
      migrated++
    } catch (err) {
      console.error(`  ❌ apikey:${keyId} failed:`, err.message)
    }
  }

  console.log(`  ✅ API Keys: ${migrated}/${keyIds.length} migrated`)
  return migrated
}

// ============================================================
// Users 迁移
// ============================================================

async function migrateUsers() {
  // Users 存储为 JSON string
  const keys = await scanKeys('user:*')
  const userKeys = keys.filter(
    (k) =>
      !k.startsWith('user_session:') &&
      !k.startsWith('username:') &&
      !k.startsWith('email:') &&
      !k.includes(':index')
  )

  console.log(`  Found ${userKeys.length} users`)

  let migrated = 0
  for (const key of userKeys) {
    try {
      const raw = await redis.get(key)
      if (!raw) {
        continue
      }
      const data = JSON.parse(raw)
      if (!data.id) {
        data.id = key.replace('user:', '')
      }

      if (!DRY_RUN) {
        // 检查用户是否已存在（避免 unique 冲突）
        const existing = await dal.users.getUser(data.id)
        if (!existing) {
          await dal.users.createUser({
            id: data.id,
            username: data.username,
            email: data.email || null,
            displayName: data.displayName || '',
            firstName: data.firstName || '',
            lastName: data.lastName || '',
            role: data.role || 'user',
            isActive: data.isActive !== false,
            authType: data.authType || 'local',
            passwordHash: data.passwordHash || ''
          })
        }
      }
      migrated++
    } catch (err) {
      console.error(`  ❌ ${key} failed:`, err.message)
    }
  }

  console.log(`  ✅ Users: ${migrated}/${userKeys.length} migrated`)
  return migrated
}

// ============================================================
// Account Groups 迁移
// ============================================================

async function migrateAccountGroups() {
  const groupIds = await redis.smembers('account_groups')

  console.log(`  Found ${groupIds.length} groups`)

  let migrated = 0
  for (const groupId of groupIds) {
    try {
      const data = await redis.hgetall(`account_group:${groupId}`)
      if (!data || Object.keys(data).length === 0) {
        continue
      }

      if (!DRY_RUN) {
        await dal.accountGroups.createGroup({
          id: groupId,
          name: data.name || '',
          platform: data.platform || 'claude',
          description: data.description || ''
        })

        // 迁移成员
        const members = await redis.smembers(`account_group_members:${groupId}`)
        for (const memberId of members) {
          await dal.accountGroups.addMember(groupId, memberId, data.platform || 'claude')
        }
      }
      migrated++
    } catch (err) {
      console.error(`  ❌ group:${groupId} failed:`, err.message)
    }
  }

  console.log(`  ✅ Groups: ${migrated}/${groupIds.length} migrated`)
  return migrated
}

// ============================================================
// Account Test Configs 迁移
// ============================================================

async function migrateTestConfigs() {
  const keys = await scanKeys('account:test_config:*')

  console.log(`  Found ${keys.length} test configs`)

  let migrated = 0
  for (const key of keys) {
    try {
      const data = await redis.hgetall(key)
      if (!data || Object.keys(data).length === 0) {
        continue
      }

      // key format: account:test_config:{platform}:{accountId}
      const parts = key.split(':')
      const platform = parts[2]
      const accountId = parts.slice(3).join(':')

      if (!DRY_RUN) {
        await dal.saveTestConfig(accountId, platform, {
          enabled: data.enabled === 'true',
          cronExpression: data.cronExpression || '0 8 * * *',
          model: data.model || 'claude-sonnet-4-5-20250929'
        })
      }
      migrated++
    } catch (err) {
      console.error(`  ❌ ${key} failed:`, err.message)
    }
  }

  console.log(`  ✅ Test Configs: ${migrated}/${keys.length} migrated`)
  return migrated
}

// ============================================================
// Balance Script Configs 迁移
// ============================================================

async function migrateBalanceScripts() {
  const keys = await scanKeys('account_balance_script:*')

  console.log(`  Found ${keys.length} balance script configs`)

  let migrated = 0
  for (const key of keys) {
    try {
      const raw = await redis.get(key)
      if (!raw) {
        continue
      }

      // key format: account_balance_script:{platform}:{accountId}
      const parts = key.split(':')
      const platform = parts[1]
      const accountId = parts.slice(2).join(':')

      const config = JSON.parse(raw)

      if (!DRY_RUN) {
        await dal.setBalanceScriptConfig(accountId, platform, config)
      }
      migrated++
    } catch (err) {
      console.error(`  ❌ ${key} failed:`, err.message)
    }
  }

  console.log(`  ✅ Balance Scripts: ${migrated}/${keys.length} migrated`)
  return migrated
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log(`\n🚀 Redis → PostgreSQL Migration ${DRY_RUN ? '(DRY RUN)' : ''}\n`)
  console.log(`Redis: ${config.redis.host}:${config.redis.port} db=${config.redis.db}`)
  console.log(`PG: ${process.env.PG_HOST || '127.0.0.1'}/${process.env.PG_DATABASE || 'ccqiao'}\n`)

  redis = createRedis()
  await pg.connect()

  const results = {}

  console.log('📦 1/6 Migrating accounts...')
  results.accounts = await migrateAccounts()

  console.log('\n🔑 2/6 Migrating API keys...')
  results.apiKeys = await migrateApiKeys()

  console.log('\n👤 3/6 Migrating users...')
  results.users = await migrateUsers()

  console.log('\n📂 4/6 Migrating account groups...')
  results.groups = await migrateAccountGroups()

  console.log('\n🧪 5/6 Migrating test configs...')
  results.testConfigs = await migrateTestConfigs()

  console.log('\n💰 6/6 Migrating balance scripts...')
  results.balanceScripts = await migrateBalanceScripts()

  console.log(`\n${'='.repeat(50)}`)
  console.log('📊 Migration Summary:')
  for (const [key, count] of Object.entries(results)) {
    console.log(`  ${key}: ${count}`)
  }
  console.log('='.repeat(50))

  if (DRY_RUN) {
    console.log('\n⚠️  DRY RUN — no data was written to PG')
  } else {
    console.log('\n✅ Migration complete!')
  }

  redis.disconnect()
  await pg.close()
}

main().catch((err) => {
  console.error('\n❌ Migration failed:', err)
  process.exit(1)
})
