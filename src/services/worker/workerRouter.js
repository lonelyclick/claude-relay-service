/**
 * Worker Router
 *
 * 根据账户绑定的 workerId 决定请求走 LocalWorker 还是 RemoteWorkerProxy。
 * - 无 workerId 或 workerId 对应的 Worker 不在线 → 本地执行（LocalWorker）
 * - workerId 对应在线 Worker → 远程执行（RemoteWorkerProxy）
 *
 * 本地执行 = 当前进程直接调用 HTTP（与改造前行为一致，零开销）
 * 远程执行 = 通过 WebSocket 下发到 Worker 节点执行
 */

const workerService = require('./workerService')
const logger = require('../../utils/logger')

class WorkerRouter {
  /**
   * 判断账户应由本地还是远程 Worker 处理
   *
   * @param {string|null} workerId - 账户绑定的 workerId
   * @returns {{ mode: 'local'|'remote', workerId: string|null }}
   */
  resolve(workerId) {
    if (!workerId) {
      return { mode: 'local', workerId: null }
    }

    if (workerService.isOnline(workerId)) {
      return { mode: 'remote', workerId }
    }

    // Worker 不在线
    logger.warn(`Worker ${workerId} not online`)
    return { mode: 'local', workerId: null }
  }
}

module.exports = new WorkerRouter()
