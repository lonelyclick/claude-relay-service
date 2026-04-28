# 新版本 Claude Code 适配指南

当 Anthropic 发布新版本的 Claude Code（如 2.1.112），按本文步骤逐项检查和适配。

---

## 背景：relay 的规范化机制

relay 对每个请求做两层规范化，目的是让所有版本的客户端对 Anthropic 呈现相同的指纹：

| 层 | 配置文件 | 规范化内容 |
|----|---------|-----------|
| HTTP 请求头 | `vm-fingerprint.template.json` | User-Agent、X-Stainless-* 等 |
| 请求 body | `data/v*.json` body template | cc_version、cc_entrypoint、anthropic-beta、system blocks、tools |

body template 按版本分两档：
- `data/v2.1.98-body-template.json` — 用于客户端版本 ≤ 2.1.99
- `data/v2.1.112-body-template.json` — 用于客户端版本 ≥ 2.1.100

`anthropic-beta` header 从 body template 的 `anthropicBeta` 字段读取。如果模板中没有该字段，则 fallback 到 `src/proxy/headerPolicy.ts` 的硬编码常量。

**关于 `deviceId` / `accountUuid`：** 这两个值已改为 **per-account 隔离**，每个账号有独立的 `deviceId`（创建时随机生成）和 `accountUuid`（来自 OAuth profile）。body 重写时会用账号自身的值覆盖模板中的值。模板中的 `deviceId`/`accountUuid` 仅作为缺省 fallback，不再需要手动维护固定值。

---

## 一、确认新版本存在

```bash
npm view @anthropic-ai/claude-code versions --json | node -e "
const v = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
console.log(v.filter(x => x.startsWith('2.1.')).slice(-10).join('\n'));
"
```

> 注意：Anthropic 会跳过某些版本号（如 2.1.93、2.1.95、2.1.99 从未发布），确认版本真实存在后再继续。

---

## 二、在 ncu 上安装新版本并抓包

### 2.1 安装新版本

```bash
ssh ncu
source ~/.nvm/nvm.sh
nvm use v24.12.0
npm install -g @anthropic-ai/claude-code@2.1.112

# 确认版本
~/.nvm/versions/node/v24.12.0/bin/claude --version
# 预期输出：2.1.112 (Claude Code)
```

### 2.2 抓取请求 body（通过 relay 转发，获得真实响应）

```bash
cd /home/guang/happy/claude-oauth-relay

# 启动抓包代理（9998 端口，转发到 relay 3560）
node scripts/capture-response.mjs &>/tmp/capture-proxy.log &
CAPBODY_PID=$!

sleep 1

# 触发真实请求
ANTHROPIC_BASE_URL=http://127.0.0.1:9998 \
  ~/.nvm/versions/node/v24.12.0/bin/claude -p 'say ok' --max-turns 1

# 停止代理
kill $CAPBODY_PID 2>/dev/null
pkill -f capture-response.mjs 2>/dev/null

# 确认文件生成
ls scripts/captured-responses/ | grep 2.1.112
```

### 2.3 抓取 HTTP 请求头（独立代理，不转发，返回 mock 响应）

```bash
# 启动 capture-body（9999 端口）
node scripts/capture-body.mjs &>/tmp/capbody.log &
CAPBODY_PID=$!

sleep 1

ANTHROPIC_BASE_URL=http://127.0.0.1:9999 \
  ~/.nvm/versions/node/v24.12.0/bin/claude -p 'say ok' --max-turns 1

kill $CAPBODY_PID 2>/dev/null
pkill -f capture-body.mjs 2>/dev/null

# 确认文件生成
ls scripts/captured-bodies/ | grep 2.1.112
```

### 2.4 将抓包文件拉回本地

在**本地**执行：

```bash
rsync -av "ncu:/home/guang/happy/claude-oauth-relay/scripts/captured-responses/v2.1.112__*" \
  scripts/captured-responses/

rsync -av "ncu:/home/guang/happy/claude-oauth-relay/scripts/captured-bodies/v2.1.112__*" \
  scripts/captured-bodies/
```

---

## 三、对比分析

### 3.1 对比请求 body

在**本地**运行，将 `PREV` 和 `NEW` 改为实际版本号：

```bash
node -e "
const fs = require('fs');
const PREV = '2.1.101';
const NEW  = '2.1.112';
const DIR  = 'scripts/captured-responses';
const CC_VERSION_RE    = /cc_version=[\d.]+\.\w+/;
const CC_ENTRYPOINT_RE = /cc_entrypoint=\S+?(?=;|\s|$)/;

function parse(ver) {
  const body  = JSON.parse(fs.readFileSync(DIR+'/v'+ver+'__POST_v1_messages_beta_true__request.json'));
  const text0 = body.system[0].text;
  return {
    systemBlocks: body.system.length,
    tools:        body.tools.map(t => t.name).sort(),
    ccVersion:    (text0.match(CC_VERSION_RE)    || ['?'])[0],
    ccEntrypoint: (text0.match(CC_ENTRYPOINT_RE) || ['?'])[0],
    outputEffort: body.output_config?.effort ?? '(none)',
    model:        body.model,
  };
}

const prev = parse(PREV), next = parse(NEW);
console.log('=== body diff', PREV, '->', NEW, '===');
['systemBlocks','ccVersion','ccEntrypoint','outputEffort','model'].forEach(f => {
  const changed = String(prev[f]) !== String(next[f]);
  console.log(changed ? '✗' : '✓', f+':', prev[f], changed ? '-> '+next[f] : '');
});
const added   = next.tools.filter(t => !prev.tools.includes(t));
const removed = prev.tools.filter(t => !next.tools.includes(t));
console.log('\n工具:', prev.tools.length, '->', next.tools.length);
if (added.length)   console.log('  新增:', added.join(', '));
if (removed.length) console.log('  删除:', removed.join(', '));
if (!added.length && !removed.length) console.log('  无变化 ✓');
"
```

### 3.2 对比 HTTP 请求头

```bash
node -e "
const fs = require('fs');
const PREV = '2.1.101';
const NEW  = '2.1.112';
const DIR  = 'scripts/captured-bodies';

function parseHeaders(ver) {
  const f = DIR+'/v'+ver+'__POST_v1_messages_beta_true.headers.json';
  if (!fs.existsSync(f)) { console.log(ver+': 无 headers 文件'); return null; }
  const raw = JSON.parse(fs.readFileSync(f)).headers;
  const map = {};
  for (let i = 0; i < raw.length - 1; i += 2) map[raw[i].toLowerCase()] = raw[i+1];
  return map;
}

const prev = parseHeaders(PREV), next = parseHeaders(NEW);
if (!prev || !next) process.exit(1);

['user-agent','anthropic-beta','x-stainless-package-version','x-stainless-runtime-version'].forEach(k => {
  const changed = prev[k] !== next[k];
  console.log(changed ? '✗' : '✓', k+':');
  if (changed) { console.log('  旧:', prev[k]); console.log('  新:', next[k]); }
  else console.log(' ', prev[k]);
});
"
```

### 3.3 当前已验证的 2.1.112 结论

截至 `2026-04-17`，本仓库已用真实抓包验证过一次 `2.1.112`，结论如下：

- `ccVersion`：`2.1.112.e61`
- `ccEntrypoint`：`sdk-cli`
- `User-Agent`：`claude-cli/2.1.112 (external, sdk-cli)`
- `anthropic-beta`（公共部分）：`claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advisor-tool-2026-03-01,effort-2025-11-24`
- `X-Stainless-Package-Version`：`0.81.0`（未变化）
- `X-Stainless-Runtime-Version`：`v24.12.0`

**重要：`2.1.112` 不属于“只改 ccVersion”场景。**

虽然工具数量仍然是 25，没有新增 template 分档边界，但 `data/v2.1.112-body-template.json` 的 `systemBlocks` 和 `tools` 内容本体已经漂移，必须用新抓包整体替换，不能只更新 `ccVersion` 字段。

---

## 四、根据对比结果判断需要做什么

### 情况 A：什么都没变（较少见）

只需更新版本号相关的两处配置：

**4.A.1 提取新版本的 ccVersion**

```bash
node -e "
const fs = require('fs');
const body = JSON.parse(fs.readFileSync('scripts/captured-responses/v2.1.112__POST_v1_messages_beta_true__request.json'));
const m = body.system[0].text.match(/cc_version=([\d.]+\.\w+)/);
console.log('ccVersion:', m[1]);
"
# 示例输出：ccVersion: 2.1.112.e61
```

**4.A.2 更新所有 body template 的 ccVersion**

```bash
node -e "
const fs = require('fs');
const NEW_CC = '2.1.112.e61';  // 替换为上一步实际输出的值
const templates = ['data/v2.1.98-body-template.json', 'data/v2.1.112-body-template.json'];
for (const f of templates) {
  const t = JSON.parse(fs.readFileSync(f));
  const old = t.ccVersion;
  t.ccVersion = NEW_CC;
  fs.writeFileSync(f, JSON.stringify(t, null, 2));
  console.log(f + ': ' + old + ' -> ' + NEW_CC);
}
"
```

**4.A.3 更新 fingerprint 模板的 User-Agent 版本号**

```bash
# 本地
sed -i 's/claude-cli\/2\.1\.101/claude-cli\/2.1.112/g' vm-fingerprint.template.json
grep 'User-Agent' vm-fingerprint.template.json  # 确认

# ncu
ssh ncu "sed -i 's/claude-cli\/2\.1\.101/claude-cli\/2.1.112/g' \
  /home/guang/happy/claude-oauth-relay/vm-fingerprint.template.json && \
  grep 'User-Agent' /home/guang/happy/claude-oauth-relay/vm-fingerprint.template.json"
```

> 已验证：`2.1.112` 不是情况 A。它虽然没有新增工具，但 `data/v2.1.112-body-template.json` 需要按抓包整体替换，不能只改 `ccVersion`。

然后跳到**第五步（部署）**。

---

### 情况 B：新增了工具

说明新版本增加了新的客户端工具（如 ScheduleWakeup），需要为 ≥ 新版本的客户端生成新 body template。

> 下列命令用 `2.1.120` 作为“未来某个新增 template 的示例版本”。这只是占位示例，不代表本次 `2.1.112` 适配结果。

**4.B.1 生成新 body template**

```bash
node -e "
const fs = require('fs');
const NEW = '2.1.120';
const body = JSON.parse(fs.readFileSync('scripts/captured-responses/v'+NEW+'__POST_v1_messages_beta_true__request.json'));
const system = body.system;
const text0  = system[0].text;
const ccMatch = text0.match(/cc_version=([\d.]+\.\w+)/);
const epMatch = text0.match(/cc_entrypoint=(\S+?)(?=;|\s|$)/);
// 从抓包 headers 提取 anthropicBeta
const hdr = JSON.parse(fs.readFileSync('scripts/captured-bodies/v'+NEW+'__POST_v1_messages_beta_true.headers.json'));
const rawH = hdr.headers;
let anthropicBeta = null;
for (let i = 0; i < rawH.length - 1; i += 2)
  if (rawH[i].toLowerCase() === 'anthropic-beta') { anthropicBeta = rawH[i+1]; break; }

// 从 metadata.user_id 提取 deviceId/accountUuid（仅作为模板 fallback）
const meta = body.metadata ?? {};
let deviceId = null, accountUuid = null;
try { const u = JSON.parse(meta.user_id ?? '{}'); deviceId = u.device_id; accountUuid = u.account_uuid; } catch {}

const template = {
  ccVersion:    ccMatch[1],
  ccEntrypoint: epMatch ? epMatch[1].replace(/;$/, '') : 'sdk-cli',
  ...(anthropicBeta ? { anthropicBeta } : {}),
  systemBlocks: system.slice(1).map(b => ({
    type: b.type,
    ...(b.cache_control ? { cache_control: b.cache_control } : {}),
    text: b.text,
  })),
  tools: body.tools,
  deviceId,
  accountUuid,
};
const out = 'data/v'+NEW+'-body-template.json';
fs.writeFileSync(out, JSON.stringify(template, null, 2));
console.log('生成:', out);
console.log('ccVersion:', template.ccVersion);
console.log('ccEntrypoint:', template.ccEntrypoint);
console.log('anthropicBeta:', template.anthropicBeta ?? '(未提取到)');
console.log('systemBlocks:', template.systemBlocks.length);
console.log('tools:', template.tools.length, template.tools.map(t=>t.name).join(', '));
"
```

> 注：模板中的 `deviceId`/`accountUuid` 仅作为 fallback。实际运行时每个账号使用自己的 `deviceId`（随机生成）和 `accountUuid`（来自 OAuth profile）覆盖模板值。
> 也可以用 `extract-body-template.mjs` 脚本提取；该脚本现在会一并提取 `ccEntrypoint`、`anthropicBeta`、`deviceId`、`accountUuid`，但仍需要先修改脚本中的 `bodyPath` 和 `outPath` 为目标版本路径。

**4.B.2 更新所有旧 template 的 ccVersion（同 4.A.2）**

```bash
node -e "
const fs = require('fs');
const NEW_CC = '2.1.120.x00';  // 示例占位；替换为新 template 的 ccVersion 字段
const templates = ['data/v2.1.98-body-template.json', 'data/v2.1.112-body-template.json'];
for (const f of templates) {
  const t = JSON.parse(fs.readFileSync(f));
  t.ccVersion = NEW_CC;
  fs.writeFileSync(f, JSON.stringify(t, null, 2));
  console.log(f, '->', NEW_CC);
}
"
```

**4.B.3 更新 selectBodyTemplate 的版本边界**

打开 `src/proxy/relayService.ts`，找到 `selectBodyTemplate` 方法，修改边界版本号和对应 template：

```typescript
// 当前（添加前）：
const isNewEra = encode(clientVersion) >= encode([2, 1, 100])
if (isNewEra && appConfig.bodyTemplateNew) {
  return appConfig.bodyTemplateNew
}
return appConfig.bodyTemplate

// 修改后（假设 2.1.120 起使用新 template）：
if (encode(clientVersion) >= encode([2, 1, 120]) && appConfig.bodyTemplateV3) {
  return appConfig.bodyTemplateV3
}
if (encode(clientVersion) >= encode([2, 1, 100]) && appConfig.bodyTemplateNew) {
  return appConfig.bodyTemplateNew
}
return appConfig.bodyTemplate
```

**4.B.4 在 config.ts 中添加新 template 配置项**

在 `src/config.ts` 的 envSchema 中添加（参考 `BODY_TEMPLATE_NEW_PATH` 的写法）：

```typescript
BODY_TEMPLATE_V3_PATH: z.string().optional().transform((value) => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}),
```

在 `appConfig` 对象中加入：

```typescript
bodyTemplateV3Path: env.BODY_TEMPLATE_V3_PATH
  ? path.resolve(process.cwd(), env.BODY_TEMPLATE_V3_PATH)
  : null,
bodyTemplateV3: loadBodyTemplate(env.BODY_TEMPLATE_V3_PATH ?? null),
```

在 `types.ts` 或相关类型声明中同步更新。

**4.B.5 更新 fingerprint 模板 User-Agent（同 4.A.3）**

---

### 情况 C：`cc_entrypoint` 变了（如 `sdk-cli` → `sdk-web`）

这意味着架构发生了重大变化，同时需要处理：

**更新 fingerprint 模板：**
```bash
# 本地（将 sdk-cli 替换为新值，如 sdk-web）
sed -i 's/(external, sdk-cli)/(external, sdk-web)/g' vm-fingerprint.template.json

# ncu
ssh ncu "sed -i 's/(external, sdk-cli)/(external, sdk-web)/g' \
  /home/guang/happy/claude-oauth-relay/vm-fingerprint.template.json"
```

**更新相关 body template 的 ccEntrypoint：**
```bash
node -e "
const fs = require('fs');
// 更新负责处理新版本的那个 template
const f = 'data/v2.1.120-body-template.json';  // 示例；替换为实际新 template 文件名
const t = JSON.parse(fs.readFileSync(f));
t.ccEntrypoint = 'sdk-web';   // 改为新值
fs.writeFileSync(f, JSON.stringify(t, null, 2));
console.log('ccEntrypoint 已更新为:', t.ccEntrypoint);
"
```

---

### 情况 D：`anthropic-beta` 新增了 flag

`anthropic-beta` 现在存储在 body template 的 `anthropicBeta` 字段中，由 `extract-body-template.mjs` 从抓包 headers 自动提取。

```bash
# 查看新版本实际发送的 beta 列表
node -e "
const fs = require('fs');
const h = JSON.parse(fs.readFileSync('scripts/captured-bodies/v2.1.112__POST_v1_messages_beta_true.headers.json'));
const raw = h.headers;
for (let i = 0; i < raw.length - 1; i += 2)
  if (raw[i].toLowerCase() === 'anthropic-beta') console.log(raw[i+1]);
"
```

如有变化，更新所有 body template 的 `anthropicBeta` 字段：

```bash
node -e "
const fs = require('fs');
const NEW_BETA = '...';  // 从上面的输出中取
const templates = ['data/v2.1.98-body-template.json', 'data/v2.1.112-body-template.json'];
for (const f of templates) {
  const t = JSON.parse(fs.readFileSync(f));
  t.anthropicBeta = NEW_BETA;
  fs.writeFileSync(f, JSON.stringify(t, null, 2));
  console.log(f, '-> anthropicBeta updated');
}
"
```

> 注意：`headerPolicy.ts` 中的 `HARDCODED_ANTHROPIC_BETA` 仍作为 fallback 保留，但正常情况下不会被使用（模板值优先）。

---

### 情况 E：`X-Stainless-Package-Version` 变了

当前 fingerprint 模板硬编码为 `0.81.0`，如果新版本更新了：

```bash
# 本地
node -e "
const fs = require('fs');
const fp = JSON.parse(fs.readFileSync('vm-fingerprint.template.json'));
fp.headers['X-Stainless-Package-Version'] = '0.82.0';  // 替换为新版本实际值
fs.writeFileSync('vm-fingerprint.template.json', JSON.stringify(fp, null, 2));
"

# 同步到 ncu
scp vm-fingerprint.template.json ncu:/home/guang/happy/claude-oauth-relay/
```

---

## 五、部署

### 5.1 本地编译

```bash
npm run build
# 确认没有 TypeScript 编译错误
```

### 5.2 同步到 ncu

只同步有改动的文件：

```bash
# body templates（几乎每次都要同步）
scp data/v2.1.98-body-template.json  ncu:/home/guang/happy/claude-oauth-relay/data/
scp data/v2.1.112-body-template.json ncu:/home/guang/happy/claude-oauth-relay/data/

# fingerprint template（改了 User-Agent 版本号时）
scp vm-fingerprint.template.json ncu:/home/guang/happy/claude-oauth-relay/

# 源码（改了 headerPolicy / relayService / config 时）
scp src/proxy/headerPolicy.ts  ncu:/home/guang/happy/claude-oauth-relay/src/proxy/
scp src/proxy/relayService.ts  ncu:/home/guang/happy/claude-oauth-relay/src/proxy/
scp src/config.ts              ncu:/home/guang/happy/claude-oauth-relay/src/

# 新增的 body template（情况 B）
scp data/v2.1.120-body-template.json ncu:/home/guang/happy/claude-oauth-relay/data/
```

### 5.3 ncu 上编译

```bash
ssh ncu "cd /home/guang/happy/claude-oauth-relay && npm run build"
# 必须无报错才能继续
```

### 5.4 更新 ncu 的 .env

**只更新 ccVersion（情况 A）：** 不需要改 .env，body template 已通过 scp 同步。

**新增 body template（情况 B）：** 用 sed 修改已有配置项（注意不要用 `echo >>` 追加，会产生重复 key）：

```bash
# 修改已有的 BODY_TEMPLATE_NEW_PATH（旧 template 升级为新 template）
ssh ncu "sed -i 's|BODY_TEMPLATE_NEW_PATH=.*|BODY_TEMPLATE_NEW_PATH=./data/v2.1.120-body-template.json|' \
  /home/guang/happy/claude-oauth-relay/.env"

# 或者如果是新增第三个 template（BODY_TEMPLATE_V3_PATH 尚不存在）
ssh ncu "echo 'BODY_TEMPLATE_V3_PATH=./data/v2.1.120-body-template.json' >> \
  /home/guang/happy/claude-oauth-relay/.env"

# 确认 .env 内容正确
ssh ncu "grep BODY_TEMPLATE /home/guang/happy/claude-oauth-relay/.env"
```

**更新最低版本限制（可选）：**
```bash
ssh ncu "sed -i 's|MIN_CLAUDE_VERSION=.*|MIN_CLAUDE_VERSION=2.1.120|' \
  /home/guang/happy/claude-oauth-relay/.env"
```

### 5.5 重启 relay

```bash
ssh ncu "pm2 restart cor --update-env && pm2 save"
ssh ncu "pm2 status cor"  # 确认 status=online，restarts 只增加了 1
```

### 5.6 恢复 ncu 上的 Claude Code 版本

抓包时临时安装了 2.1.112，适配完成后恢复为新版本（即 2.1.112 本身就是要用的版本，保持即可）：

```bash
ssh ncu "~/.nvm/versions/node/v24.12.0/bin/claude --version"
```

---

## 六、验证

### 6.1 功能验证

```bash
ssh ncu "ANTHROPIC_BASE_URL=http://127.0.0.1:3560 \
  ~/.nvm/versions/node/v24.12.0/bin/claude -p 'say ok' --max-turns 1"
# 预期：输出 ok
```

### 6.2 规范化验证

在本地运行，确认新版本经 relay 处理后与 User-Agent 完全一致：

```bash
node -e "
const fs = require('fs');
const NEW_VER  = '2.1.112';
const TMPL_FILE = 'data/v2.1.112-body-template.json';  // 或新生成的 template
const CC_VERSION_RE    = /cc_version=[\d.]+\.\w+/;
const CC_ENTRYPOINT_RE = /cc_entrypoint=\S+?(?=;|\s|$)/;

const tmpl = JSON.parse(fs.readFileSync(TMPL_FILE));
const fp   = JSON.parse(fs.readFileSync('vm-fingerprint.template.json'));
const body = JSON.parse(fs.readFileSync('scripts/captured-responses/v'+NEW_VER+'__POST_v1_messages_beta_true__request.json'));

const text0   = body.system[0].text;
const newText = text0
  .replace(CC_VERSION_RE,    'cc_version='    + tmpl.ccVersion)
  .replace(CC_ENTRYPOINT_RE, 'cc_entrypoint=' + tmpl.ccEntrypoint);

const bodyEntry = (newText.match(CC_ENTRYPOINT_RE)||['?'])[0].replace('cc_entrypoint=','');
const bodyVer   = tmpl.ccVersion.split('.').slice(0,3).join('.');
const uaEntry   = fp.headers['User-Agent'].match(/sdk-\w+/)?.[0];
const uaVer     = fp.headers['User-Agent'].match(/[\d.]+/)?.[0];

console.log('cc_version    :', bodyVer, uaVer === bodyVer ? '✓' : '✗  UA版本不一致，UA='+uaVer);
console.log('cc_entrypoint :', bodyEntry, uaEntry === bodyEntry ? '✓' : '✗  UA entrypoint不一致，UA='+uaEntry);
console.log('system blocks :', body.system.length, '->', 1 + tmpl.systemBlocks.length, body.system.length >= 1 ? '✓' : '✗');
console.log('tools         :', body.tools.length, '->', tmpl.tools.length);
"
```

---

## 七、检查清单

每次适配时按顺序勾选（未涉及的项直接跳过）：

- [ ] npm 确认新版本存在
- [ ] ncu 安装新版本并确认 `--version`
- [ ] capture-response.mjs 抓取请求 body，确认文件生成
- [ ] capture-body.mjs 抓取请求 headers，确认文件生成
- [ ] 将抓包文件 rsync 到本地
- [ ] 运行 body 对比脚本，记录所有差异
- [ ] 运行 headers 对比脚本，记录所有差异
- [ ] 提取新 ccVersion，更新所有 body template 的 ccVersion 字段
- [ ] fingerprint 模板 User-Agent 版本号更新
- [ ] （如有）工具列表新增 → 生成新 body template，更新 selectBodyTemplate 边界
- [ ] （如有）cc_entrypoint 变化 → 更新 fingerprint 模板和 body template
- [ ] （如有）anthropic-beta 新增 flag → 更新所有 body template 的 `anthropicBeta` 字段
- [ ] （如有）X-Stainless-Package-Version 变化 → 更新 fingerprint 模板
- [ ] 本地 `npm run build` 通过
- [ ] scp 同步所有变更文件到 ncu
- [ ] ncu `npm run build` 通过
- [ ] 更新 ncu `.env`（如有新 template 路径或版本配置）
- [ ] `pm2 restart cor --update-env && pm2 save`
- [ ] 验证 6.1：`say ok` 返回成功
- [ ] 验证 6.2：规范化脚本全部 ✓

---

## 八、关键文件速查

| 文件 | 用途 | 何时修改 |
|------|------|---------|
| `data/v2.1.98-body-template.json` | ≤2.1.99 客户端的 body 规范化 | 每次更新 ccVersion |
| `data/v2.1.112-body-template.json` | ≥2.1.100 客户端的 body 规范化 | 每次更新 ccVersion；工具变化时替换 |
| `vm-fingerprint.template.json` | HTTP 请求头规范化 | User-Agent 版本号、cc_entrypoint、X-Stainless-Package-Version 变化时 |
| `src/proxy/headerPolicy.ts:10` | `HARDCODED_ANTHROPIC_BETA`（fallback，正常由 body template 的 `anthropicBeta` 字段提供） | 仅当需要更新 fallback 值时 |
| `src/proxy/relayService.ts:selectBodyTemplate` | 按版本选 template 的逻辑 | 新增 body template 且需要新版本边界时 |
| `src/proxy/bodyRewriter.ts` | body 规范化具体实现 | system block 结构发生根本性变化时 |
| `src/config.ts` | env 变量解析，含 template 路径 | 新增 template 配置项时 |
| `.env` (ncu) | 运行时配置 | 新增/修改 template 路径、MIN_CLAUDE_VERSION 时 |
| `scripts/extract-body-template.mjs` | 从抓包文件提取 body template（含 `ccEntrypoint`、`anthropicBeta`、`deviceId`、`accountUuid`） | 生成新 body template 时（需先修改脚本中的路径） |
| `scripts/captured-responses/` | 各版本请求 body 抓包 | 只读参考 |
| `scripts/captured-bodies/` | 各版本请求 headers + body 抓包 | 只读参考 |

---

## 九、历史版本变化记录

| 版本 | 相对上版本的变化 |
|------|----------------|
| 2.1.90–96 | 基准（4 system blocks，23 工具，sdk-ts） |
| 2.1.97 | system blocks 从 4 减少为 3 |
| 2.1.98 | 工具增至 24（+Monitor），anthropic-beta 加 advisor-tool-2026-03-01 |
| 2.1.100 | cc_entrypoint sdk-ts→sdk-cli，output_effort high→medium |
| 2.1.101 | 工具增至 25（+ScheduleWakeup） |
| 2.1.112 | 未新增工具分档，但公共 `anthropic-beta` 增加 `context-1m-2025-08-07`，`v2.1.101-body-template.json` 的 `systemBlocks/tools` 内容漂移，需按抓包整体替换（并重命名为 `v2.1.112-body-template.json`）；`X-Stainless-Runtime-Version` 为 `v24.12.0` |
| 2.1.93/95/99 | 未发布，版本号被跳过 |
