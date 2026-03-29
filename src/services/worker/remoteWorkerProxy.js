/**
 * Remote Worker Proxy
 *
 * 将 HTTP 请求任务通过 WebSocket 下发到远程 Worker。
 * 支持非流式（一次性返回）和流式（SSE 逐块转发）两种模式。
 *
 * Worker 收到 task 后：
 * 1. 用 task.credentials 直接发 HTTPS 请求到 Anthropic
 * 2. 非流式：收到完整响应后回传 { type: 'response', data: {...} }
 * 3. 流式：逐块回传 stream_start → stream_data* → stream_end
 */

const workerWsServer = require('./workerWsServer')
const logger = require('../../utils/logger')

class RemoteWorkerProxy {
  /**
   * 非流式请求：通过 Worker 发送请求，返回完整响应
   *
   * @param {string} workerId
   * @param {object} task - 包含发送请求所需的一切信息
   * @param {string} task.url - 目标 URL
   * @param {string} task.method - HTTP 方法
   * @param {object} task.headers - 请求头
   * @param {object|string} task.body - 请求体
   * @param {object} task.proxyConfig - 代理配置（可选）
   * @param {number} [timeout=600000] - 超时 ms
   * @returns {Promise<{ statusCode: number, headers: object, body: object|string }>}
   */
  async sendRequest(workerId, task, timeout = 600000) {
    const result = await workerWsServer.sendRequest(workerId, {
      type: 'http_request',
      ...task,
      stream: false
    }, { timeout })

    if (result.error) {
      const err = new Error(result.error)
      err.statusCode = result.statusCode || 500
      err.headers = result.headers || {}
      err.body = result.body
      throw err
    }

    return result
  }

  /**
   * 流式请求：通过 Worker 发送请求，逐块转发 SSE
   *
   * @param {string} workerId
   * @param {object} task - 请求信息（同 sendRequest）
   * @param {object} callbacks
   * @param {function} callbacks.onResponseStart - (statusCode, headers) => void
   * @param {function} callbacks.onData - (chunk: Buffer|string) => void
   * @param {function} callbacks.onEnd - (summary) => void
   * @param {function} callbacks.onError - (error) => void
   * @param {number} [timeout=600000]
   * @returns {Promise<void>}
   */
  async sendStreamRequest(workerId, task, callbacks, timeout = 600000) {
    return new Promise((resolve, reject) => {
      workerWsServer.sendRequest(workerId, {
        type: 'http_request',
        ...task,
        stream: true
      }, {
        timeout,

        onStreamStart: (data) => {
          // data: { statusCode, headers }
          try {
            if (callbacks.onResponseStart) {
              callbacks.onResponseStart(data.statusCode, data.headers)
            }
          } catch (err) {
            logger.warn(`[Worker] onResponseStart callback error: ${err.message}`)
          }
        },

        onStreamData: (data) => {
          // data: { chunk } — base64 编码的二进制数据或纯文本
          try {
            if (callbacks.onData) {
              const chunk = data.encoding === 'base64'
                ? Buffer.from(data.chunk, 'base64')
                : data.chunk
              callbacks.onData(chunk)
            }
          } catch (err) {
            logger.warn(`[Worker] onData callback error: ${err.message}`)
          }
        },

        onStreamEnd: (data) => {
          // data: { summary }（可能包含 usage 数据等）
          try {
            if (callbacks.onEnd) {
              callbacks.onEnd(data)
            }
          } catch (err) {
            logger.warn(`[Worker] onEnd callback error: ${err.message}`)
          }
          resolve(data)
        }
      }).catch((err) => {
        if (callbacks.onError) {
          callbacks.onError(err)
        }
        reject(err)
      })
    })
  }
}

module.exports = new RemoteWorkerProxy()
