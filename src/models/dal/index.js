/**
 * DAL — 统一数据访问层入口
 *
 * 持久数据全部走 PostgreSQL (ccqiao)
 * 临时数据（锁、限流、缓存、会话、统计）仍走 Redis
 */
const accounts = require('./accounts')
const apiKeys = require('./apiKeys')
const accountGroups = require('./accountGroups')
const users = require('./users')
const workers = require('./workers')
const misc = require('./misc')

module.exports = {
  accounts,
  apiKeys,
  accountGroups,
  users,
  workers,
  ...misc
}
