# COR Managed Xray

COR 的 Network 模块现在可以作为上游 VLESS 资源池的主数据源，并生成一份由 COR 管理的 Xray 配置。目标是逐步下线 3x-ui，让 COR 直接管理：

- 买来的上游 VLESS 账号
- 本地 only 的 HTTP/SOCKS 出口
- COR account 到出口资源的复用绑定
- probe 健康检查、出口 IP、备注名、绑定 account 数

## 数据模型

`proxies` 表保留兼容字段：

- `url`：原始上游地址，例如 `vless://...`
- `local_url`：COR 实际使用的本地代理地址，例如 `http://127.0.0.1:10880`

新增管理字段：

- `kind`：`vless-upstream`、`local-http`、`local-socks`
- `enabled`：是否纳入 COR managed Xray 配置
- `source`：`manual`、`x-ui`、`generated`
- `listen`、`inbound_port`、`inbound_protocol`
- `outbound_tag`、`xray_config_path`
- `last_probe_status`、`last_probe_at`、`egress_ip`

## Xray 配置生成

Admin API：

- `POST /admin/proxies/import`，body `{ "text": "...", "portBase": 10880 }`：批量导入上游 VLESS
- `POST /admin/xray/sync`，body `{ "dryRun": true }`：预览生成结果，不写文件
- `POST /admin/xray/sync`，body `{ "validate": true, "restart": true }`：写入配置、执行配置校验、回填 `local_url` 并重启 Xray 服务

Internal Control API：

- `POST /internal/control/xray/sync`

默认配置：

- `COR_XRAY_CONFIG_PATH=/etc/xray/cor-managed.json`
- `COR_XRAY_LISTEN=127.0.0.1`
- `COR_XRAY_PORT_BASE=10880`
- `COR_XRAY_SERVICE_NAME=` 空值时不会自动重启 systemd 服务
- `COR_XRAY_BIN=xray`

如果需要让接口自动重启 Xray，设置：

```bash
COR_XRAY_SERVICE_NAME=xray
```

然后请求：

```bash
curl -X POST https://dash.tokenqiao.com/admin/xray/sync \
  -H 'content-type: application/json' \
  -d '{"restart":true}'
```

## 迁移流程

1. 在 Network 页面点 `Add VLESS`，录入备注名、原始 `vless://...` 和可选本地端口；也可以在 `Bulk Import` 中每行粘贴一个 `vless://...`。
2. 已存在的上游，在详情页把类型设置为 `VLESS upstream`。
3. 填写或保留 `Inbound Port`，未填写时从 `COR_XRAY_PORT_BASE` 递增分配。
4. 勾选 `Include in COR managed Xray config`。
5. 点击 `Preview Xray` 验证会生成哪些本地出口；页面会展示每条资源的 `localUrl` 和 `outboundTag`。
6. 点击 `Generate Xray Config` 写入配置，把本地出口回填到 `localUrl`，并重启 `xray-cor`。
7. 确认 Xray 服务加载 `/etc/xray/cor-managed.json` 后重启 Xray。
8. 在 Network 页面跑 `Probe All`，确认出口 IP 和健康状态。
9. 保持 account 绑定不变；多个 account 可以继续复用同一个 `localUrl`。
10. 生产稳定后再停用 3x-ui。

## 账号绑定

Network 卡片展开后可以直接：

- 从下拉框选择未绑定到该资源的 account 并 `Link`
- 对已绑定 account 点击 `×` 解绑

绑定仍复用原有 COR account 的 `proxyUrl` 机制：多个 account 可以指向同一个资源。

## 校验与回滚

`Generate Xray Config` 默认传 `validate: true`：

- 写入新配置前，如果旧文件存在，会生成 `.bak` 备份
- 调用 `xray test -config <path>` 校验配置
- 校验失败时自动把备份拷回原配置文件
- 页面会展示校验结果、备份路径和是否已回滚

## 健康状态

`Probe` 和 `Probe All` 会把最近一次状态持久化到 `proxies` 表：

- `last_probe_status`
- `last_probe_at`
- `egress_ip`

这样页面刷新后仍能看到最近一次健康状态，不依赖前端内存。

## 注意事项

- 生成器目前覆盖主流 `vless://` 参数：Reality、TLS、TCP、WS、gRPC。
- 只监听 `127.0.0.1`，不会暴露给公网。
- `3x-ui` 暂时保留为人工兜底，不再建议作为主数据源。
