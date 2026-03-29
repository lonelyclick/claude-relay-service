const pg = require('../pg')

/**
 * Workers DAL
 */

function rowToWorker(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name || '',
    tokenHash: row.token_hash,
    type: row.type || 'remote',
    status: row.status || 'offline',
    ip: row.ip || '',
    region: row.region || '',
    maxConcurrency: row.max_concurrency ?? 10,
    metadata: row.metadata || {},
    createdAt: row.created_at ? row.created_at.toISOString() : null,
    updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
    lastHeartbeat: row.last_heartbeat ? row.last_heartbeat.toISOString() : null
  }
}

async function createWorker(workerData) {
  const {
    id, name = '', tokenHash, type = 'remote',
    maxConcurrency = 10, region = '', metadata = {}
  } = workerData
  await pg.query(
    `INSERT INTO workers (id, name, token_hash, type, status, max_concurrency, region, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'offline', $5, $6, $7::jsonb, NOW(), NOW())`,
    [id, name, tokenHash, type, maxConcurrency, region, JSON.stringify(metadata)]
  )
}

async function getWorker(workerId) {
  const { rows } = await pg.query('SELECT * FROM workers WHERE id = $1', [workerId])
  return rowToWorker(rows[0])
}

async function getWorkerByTokenHash(tokenHash) {
  const { rows } = await pg.query('SELECT * FROM workers WHERE token_hash = $1', [tokenHash])
  return rowToWorker(rows[0])
}

async function getAllWorkers() {
  const { rows } = await pg.query('SELECT * FROM workers ORDER BY created_at ASC')
  return rows.map(rowToWorker)
}

async function updateWorker(workerId, fields) {
  const sets = []
  const values = [workerId]
  let idx = 2
  const allowed = {
    name: 'name', status: 'status', ip: 'ip', region: 'region',
    maxConcurrency: 'max_concurrency', metadata: 'metadata',
    lastHeartbeat: 'last_heartbeat', tokenHash: 'token_hash'
  }
  for (const [camel, snake] of Object.entries(allowed)) {
    if (fields[camel] !== undefined) {
      let val = fields[camel]
      if (snake === 'metadata') val = JSON.stringify(val)
      sets.push(`${snake} = $${idx++}`)
      values.push(val)
    }
  }
  if (sets.length === 0) return
  await pg.query(`UPDATE workers SET ${sets.join(', ')} WHERE id = $1`, values)
}

async function deleteWorker(workerId) {
  await pg.query('DELETE FROM workers WHERE id = $1', [workerId])
}

async function setWorkerOnline(workerId, ip) {
  await pg.query(
    `UPDATE workers SET status = 'online', ip = $2, last_heartbeat = NOW() WHERE id = $1`,
    [workerId, ip]
  )
}

async function setWorkerOffline(workerId) {
  await pg.query(
    `UPDATE workers SET status = 'offline' WHERE id = $1`,
    [workerId]
  )
}

async function heartbeat(workerId) {
  await pg.query(
    'UPDATE workers SET last_heartbeat = NOW() WHERE id = $1',
    [workerId]
  )
}

module.exports = {
  createWorker,
  getWorker,
  getWorkerByTokenHash,
  getAllWorkers,
  updateWorker,
  deleteWorker,
  setWorkerOnline,
  setWorkerOffline,
  heartbeat,
  rowToWorker
}
