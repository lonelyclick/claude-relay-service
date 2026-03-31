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
    // 字段归一化：调用方可能传 data 或 body，Worker 端读 task.body
    const normalizedTask = this._normalizeTask(task)

    const result = await workerWsServer.sendRequest(
      workerId,
      {
        type: 'http_request',
        ...normalizedTask,
        stream: false
      },
      { timeout }
    )

    if (result.error) {
      const err = new Error(result.error)
      err.statusCode = result.statusCode || 500
      err.headers = result.headers || {}
      err.body = result.body
      throw err
    }

    // 响应归一化：Worker 返回 { statusCode, headers, body }
    // 部分调用方读 result.data，这里同时提供两个字段名
    return this._normalizeResponse(result)
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
    // 字段归一化：同 sendRequest
    const normalizedTask = this._normalizeTask(task)

    return new Promise((resolve, reject) => {
      // ✅ 修复 Bug #5: 缓存 SSE 数据以提取 usage
      const sseBuffer = []

      workerWsServer
        .sendRequest(
          workerId,
          {
            type: 'http_request',
            ...normalizedTask,
            stream: true
          },
          {
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
                const chunk =
                  data.encoding === 'base64' ? Buffer.from(data.chunk, 'base64') : data.chunk

                // ✅ 缓存 SSE 数据用于后续 usage 提取
                const chunkStr = chunk.toString('utf8')
                sseBuffer.push(chunkStr)

                if (callbacks.onData) {
                  callbacks.onData(chunk)
                }
              } catch (err) {
                logger.warn(`[Worker] onData callback error: ${err.message}`)
              }
            },

            onStreamEnd: (data) => {
              // ✅ 修复 Bug #5: 从缓存的 SSE 数据中提取 usage
              // Worker 发送的 data 为空对象，我们需要自己解析
              try {
                const sseData = sseBuffer.join('')
                const usage = this._extractUsageFromSSE(sseData)

                // 将提取的 usage 合并到 summary 中
                const summary = { ...data, usage }

                if (callbacks.onEnd) {
                  callbacks.onEnd(summary)
                }

                // 如果提取到 usage，记录日志
                if (usage) {
                  logger.info(
                    `📊 [Worker] Extracted usage from SSE: input=${usage.input_tokens}, output=${usage.output_tokens}`
                  )
                } else {
                  logger.warn(`⚠️  [Worker] Could not extract usage from SSE stream`)
                }

                resolve(summary)
              } catch (err) {
                logger.warn(`[Worker] onEnd callback error: ${err.message}`)
                resolve(data)
              }
            }
          }
        )
        .catch((err) => {
          if (callbacks.onError) {
            callbacks.onError(err)
          }
          reject(err)
        })
    })
  }

  /**
   * 归一化请求 task：确保 Worker 端收到 body 字段
   * 调用方可能传 data（axios 风格）或 body，统一为 body
   */
  _normalizeTask(task) {
    if (task.body !== undefined || task.data === undefined) {
      return task
    }
    // 调用方传了 data 但没传 body → 映射为 body
    const { data, ...rest } = task
    return { ...rest, body: data }
  }

  /**
   * 归一化 Worker 响应：同时提供 body 和 data 字段
   * Worker 返回 { statusCode, headers, body }
   * 部分调用方读 result.data（如 account service）
   */
  _normalizeResponse(result) {
    if (result.data === undefined && result.body !== undefined) {
      // 解析 body：如果是 JSON 字符串则解析为对象
      let parsed = result.body
      if (typeof parsed === 'string') {
        try {
          parsed = JSON.parse(parsed)
        } catch (_e) {
          // 保持原始字符串
        }
      }
      return { ...result, data: parsed }
    }
    return result
  }

  /**
   * 从 SSE 流数据中提取 usage 信息
   * Anthropic API 的 usage 数据在 message_delta 事件中
   *
   * @param {string} sseData - 完整的 SSE 数据
   * @returns {object|null} - { input_tokens, output_tokens, ... } 或 null
   */
  _extractUsageFromSSE(sseData) {
    try {
      const lines = sseData.split('\n')

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const jsonStr = line.slice(6).trim()
            if (jsonStr === '[DONE]' || !jsonStr) {
              continue
            }

            const eventData = JSON.parse(jsonStr)

            // Anthropic API 格式：message_delta 事件包含 usage
            if (eventData.type === 'message_delta' && eventData.usage) {
              return eventData.usage
            }

            // 也检查 delta.usage（某些格式）
            if (eventData.type === 'message_delta' && eventData.delta?.usage) {
              return eventData.delta.usage
            }
          } catch (e) {
            // 跳过无法解析的行
            continue
          }
        }
      }

      return null
    } catch (err) {
      logger.error(`Failed to extract usage from SSE: ${err.message}`)
      return null
    }
  }
}

module.exports = new RemoteWorkerProxy()
