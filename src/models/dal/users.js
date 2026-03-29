const pg = require('../pg')

/**
 * Users DAL
 */

function rowToUser(row) {
  if (!row) return null
  return {
    id: row.id,
    username: row.username,
    email: row.email || '',
    displayName: row.display_name || '',
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    role: row.role || 'user',
    isActive: row.is_active,
    authType: row.auth_type || 'local',
    passwordHash: row.password_hash || '',
    createdAt: row.created_at?.toISOString(),
    updatedAt: row.updated_at?.toISOString(),
    lastLoginAt: row.last_login_at?.toISOString() || '',
    deletedAt: row.deleted_at?.toISOString() || ''
  }
}

async function createUser(userData) {
  const {
    id, username, email, displayName = '', firstName = '', lastName = '',
    role = 'user', isActive = true, authType = 'local', passwordHash = ''
  } = userData
  await pg.query(
    `INSERT INTO users (id, username, email, display_name, first_name, last_name, role, is_active, auth_type, password_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, username, email || null, displayName, firstName, lastName, role, isActive, authType, passwordHash]
  )
}

async function getUser(userId) {
  const { rows } = await pg.query('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [userId])
  return rowToUser(rows[0])
}

async function getUserByUsername(username) {
  const { rows } = await pg.query('SELECT * FROM users WHERE username = $1 AND deleted_at IS NULL', [username])
  return rowToUser(rows[0])
}

async function getUserByEmail(email) {
  const { rows } = await pg.query('SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL', [email])
  return rowToUser(rows[0])
}

async function getAllUsers() {
  const { rows } = await pg.query('SELECT * FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC')
  return rows.map(rowToUser)
}

async function updateUser(userId, fields) {
  const sets = []
  const values = [userId]
  let idx = 2
  const allowed = {
    username: 'username', email: 'email', displayName: 'display_name',
    firstName: 'first_name', lastName: 'last_name', role: 'role',
    isActive: 'is_active', passwordHash: 'password_hash', lastLoginAt: 'last_login_at'
  }
  for (const [camel, snake] of Object.entries(allowed)) {
    if (fields[camel] !== undefined) {
      sets.push(`${snake} = $${idx++}`)
      values.push(fields[camel])
    }
  }
  if (sets.length === 0) return
  await pg.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, values)
}

async function deleteUser(userId) {
  // 软删除
  await pg.query('UPDATE users SET deleted_at = NOW(), is_active = FALSE WHERE id = $1', [userId])
}

module.exports = {
  createUser,
  getUser,
  getUserByUsername,
  getUserByEmail,
  getAllUsers,
  updateUser,
  deleteUser,
  rowToUser
}
