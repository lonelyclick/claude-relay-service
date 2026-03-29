const pg = require('../pg')

/**
 * Account Groups DAL
 */

async function createGroup(groupData) {
  const { id, name, platform, description = '' } = groupData
  await pg.query(
    `INSERT INTO account_groups (id, name, platform, description)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET name = $2, platform = $3, description = $4`,
    [id, name, platform, description]
  )
}

async function getGroup(groupId) {
  const { rows } = await pg.query(
    `SELECT g.*, COUNT(m.account_id) AS member_count
     FROM account_groups g
     LEFT JOIN account_group_members m ON g.id = m.group_id
     WHERE g.id = $1
     GROUP BY g.id`,
    [groupId]
  )
  if (!rows[0]) return null
  const r = rows[0]
  return {
    id: r.id,
    name: r.name,
    platform: r.platform,
    description: r.description,
    memberCount: parseInt(r.member_count),
    createdAt: r.created_at?.toISOString(),
    updatedAt: r.updated_at?.toISOString()
  }
}

async function getAllGroups(platform = null) {
  let sql = `SELECT g.*, COUNT(m.account_id) AS member_count
             FROM account_groups g
             LEFT JOIN account_group_members m ON g.id = m.group_id`
  const params = []
  if (platform) {
    sql += ' WHERE g.platform = $1'
    params.push(platform)
  }
  sql += ' GROUP BY g.id ORDER BY g.created_at ASC'
  const { rows } = await pg.query(sql, params)
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    platform: r.platform,
    description: r.description,
    memberCount: parseInt(r.member_count),
    createdAt: r.created_at?.toISOString(),
    updatedAt: r.updated_at?.toISOString()
  }))
}

async function deleteGroup(groupId) {
  // CASCADE 会删除 account_group_members
  await pg.query('DELETE FROM account_groups WHERE id = $1', [groupId])
}

async function updateGroup(groupId, fields) {
  const sets = []
  const values = [groupId]
  let idx = 2
  if (fields.name !== undefined) { sets.push(`name = $${idx++}`); values.push(fields.name) }
  if (fields.description !== undefined) { sets.push(`description = $${idx++}`); values.push(fields.description) }
  if (fields.platform !== undefined) { sets.push(`platform = $${idx++}`); values.push(fields.platform) }
  if (sets.length === 0) return
  await pg.query(`UPDATE account_groups SET ${sets.join(', ')} WHERE id = $1`, values)
}

// ============================================================
// 成员管理
// ============================================================

async function addMember(groupId, accountId, platform) {
  await pg.query(
    `INSERT INTO account_group_members (group_id, account_id, platform)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [groupId, accountId, platform]
  )
}

async function removeMember(groupId, accountId) {
  await pg.query(
    'DELETE FROM account_group_members WHERE group_id = $1 AND account_id = $2',
    [groupId, accountId]
  )
}

async function getMembers(groupId) {
  const { rows } = await pg.query(
    'SELECT account_id FROM account_group_members WHERE group_id = $1',
    [groupId]
  )
  return rows.map(r => r.account_id)
}

async function getGroupsByAccount(accountId, platform = null) {
  let sql = `SELECT g.* FROM account_groups g
             JOIN account_group_members m ON g.id = m.group_id
             WHERE m.account_id = $1`
  const params = [accountId]
  if (platform) {
    sql += ' AND m.platform = $2'
    params.push(platform)
  }
  const { rows } = await pg.query(sql, params)
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    platform: r.platform,
    description: r.description,
    createdAt: r.created_at?.toISOString(),
    updatedAt: r.updated_at?.toISOString()
  }))
}

async function batchGetGroupsByAccounts(accountIds, platform = null) {
  if (!accountIds.length) return {}
  let sql = `SELECT m.account_id, g.id, g.name, g.platform
             FROM account_group_members m
             JOIN account_groups g ON g.id = m.group_id
             WHERE m.account_id = ANY($1::text[])`
  const params = [accountIds]
  if (platform) {
    sql += ' AND m.platform = $2'
    params.push(platform)
  }
  const { rows } = await pg.query(sql, params)
  const result = {}
  for (const r of rows) {
    if (!result[r.account_id]) result[r.account_id] = []
    result[r.account_id].push({ id: r.id, name: r.name, platform: r.platform })
  }
  return result
}

module.exports = {
  createGroup,
  getGroup,
  getAllGroups,
  deleteGroup,
  updateGroup,
  addMember,
  removeMember,
  getMembers,
  getGroupsByAccount,
  batchGetGroupsByAccounts
}
