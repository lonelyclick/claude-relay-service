/**
 * 全局模型名称映射中间件
 * 在请求到达路由处理器之前，将请求中的模型名替换为目标模型名
 */

const MODEL_MAPPING = {
  // 'claude-opus-4-6': 'claude-opus-4-6-thinking', // 已移至 relay service 的 -thinking 后缀处理
  'claude-haiku-4-5-20251001': 'claude-sonnet-4-6',
};

function modelMappingMiddleware(req, res, next) {
  if (req.method === 'POST' && req.body && req.body.model) {
    const originalModel = req.body.model;
    const mappedModel = MODEL_MAPPING[originalModel];
    if (mappedModel) {
      req.body.model = mappedModel;
      console.log(`[ModelMapping] ${originalModel} -> ${mappedModel}`);
    }
  }
  next();
}

module.exports = { modelMappingMiddleware, MODEL_MAPPING };
