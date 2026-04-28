# Critical Code Path: MCP Servers to Claude

## The One Line That Makes It Work

**File**: `cli/src/claude/sdk/query.ts:336`

```typescript
cleanupMcpConfig = appendMcpConfigArg(spawnArgs, mcpServers)
```

This line:
1. **Takes** the assembled `mcpServers` object (Record<string, MCP config>)
2. **Serializes** it to JSON: `JSON.stringify({ mcpServers })`
3. **Appends** as CLI argument: `--mcp-config '<JSON or file path>'`
4. **Spawns** Claude: `spawn('claude', ['--mcp-config', ...spawnArgs])`

---

## Code Path: Backwards from the Spawn

### 1. Process Spawn
**File**: `query.ts:342`
```typescript
const child = spawn(spawnCommand, spawnArgs, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: spawnEnv,
    shell: process.platform === 'win32'
})
```

**What gets spawned**:
```bash
claude --output-format stream-json --verbose --mcp-config '{"mcpServers":{...}}'
```

---

### 2. MCP Config Argument Assembly
**File**: `mcpConfig.ts:46-58`
```typescript
export function appendMcpConfigArg(
    args: string[],
    mcpServers?: Record<string, unknown>,
    options?: McpConfigOptions
): (() => void) | null {
    if (!mcpServers || Object.keys(mcpServers).length === 0) {
        return null;
    }

    const { value, cleanup } = resolveMcpConfigArg(mcpServers, options);
    args.push('--mcp-config', value);  // ← ADDS TO CLI
    return cleanup ?? null;
}
```

**Calls**:
```typescript
const { value, cleanup } = resolveMcpConfigArg(mcpServers, options);
```

---

### 3. MCP Config Serialization (Platform-dependent)
**File**: `mcpConfig.ts:15-44`

**Unix/macOS** (JSON passed directly):
```typescript
const configJson = JSON.stringify({ mcpServers });
const useFile = options?.useFile ?? process.platform === 'win32';
if (!useFile) {
    return { value: configJson };  // ← Returns JSON string
}
```

**Windows** (temp file):
```typescript
const filePath = join(dir, `mcp-config-${process.pid}-${Date.now()}-${Math.random()...}.json`);
writeFileSync(filePath, configJson, "utf8");
return {
    value: filePath,  // ← Returns file path
    cleanup: () => { unlinkSync(filePath); }
};
```

---

### 4. SDK Options with mcpServers
**File**: `claudeRemote.ts:152-167`
```typescript
const sdkOptions: Options = {
    cwd: opts.path,
    resume: startFrom ?? undefined,
    mcpServers: opts.mcpServers,  // ← LINE 155: STORED HERE
    permissionMode: initial.mode.permissionMode,
    model: initial.mode.model,
    fallbackModel: initial.mode.fallbackModel,
    customSystemPrompt: initial.mode.customSystemPrompt ? ... : undefined,
    appendSystemPrompt: initial.mode.appendSystemPrompt ? ... : systemPrompt,
    allowedTools: allAllowedTools,
    disallowedTools: effectiveDisallowedTools.length > 0 ? ... : undefined,
    canCallTool: (toolName: string, input: unknown, options: { signal: AbortSignal }) => opts.canCallTool(...),
    abort: opts.signal,
    pathToClaudeCodeExecutable: opts.executableCommand ?? 'claude',
    settingsPath: opts.hookSettingsPath,
};

const response = query({
    prompt: messages,
    options: sdkOptions,  // ← PASSED HERE
});
```

---

### 5. claudeRemote() Receives mcpServers
**File**: `claudeRemote.ts:25-50`
```typescript
export async function claudeRemote(opts: {
    // ...
    mcpServers?: Record<string, any>,  // ← RECEIVES HERE
    // ...
}) {
    // ...
    const sdkOptions: Options = {
        // ...
        mcpServers: opts.mcpServers,  // ← STORES HERE
        // ...
    };
    // ...
}
```

**Called from**: `claudeRemoteLauncher()` (not shown, but passes `session.mcpServers`)

---

### 6. Session Storage
**File**: `session.ts:15-76`
```typescript
export class Session extends AgentSessionBase<EnhancedMode> {
    // ...
    readonly mcpServers: Record<string, any>;  // ← LINE 18: PROPERTY

    constructor(opts: {
        // ...
        mcpServers: Record<string, any>;
        // ...
    }) {
        super({...});

        // ...
        this.mcpServers = opts.mcpServers;  // ← LINE 68: ASSIGNED
        // ...
    }
}
```

---

### 7. Session Creation in Loop
**File**: `loop.ts:44-86`
```typescript
export async function loop(opts: LoopOptions) {

    const logPath = logger.logFilePath;
    const startedBy = opts.startedBy ?? 'terminal';
    const startingMode = opts.startingMode ?? 'local';
    const modelMode: SessionModelMode = ...;

    let session = new Session({  // ← CREATES SESSION
        api: opts.api,
        client: opts.session,
        path: opts.path,
        sessionId: opts.sessionId ?? null,
        claudeEnvVars: opts.claudeEnvVars,
        claudeArgs: opts.claudeArgs,
        mcpServers: opts.mcpServers,  // ← PASSES mcpServers HERE
        logPath: logPath,
        messageQueue: opts.messageQueue,
        allowedTools: opts.allowedTools,
        onModeChange: opts.onModeChange,
        mode: startingMode,
        startedBy,
        startingMode,
        hookSettingsPath: opts.hookSettingsPath,
        permissionMode: opts.permissionMode ?? 'bypassPermissions',
        modelMode,
        executableCommand: opts.executableCommand
    });

    // ...
    await runLocalRemoteLoop({
        session,
        startingMode: opts.startingMode,
        logTag: 'loop',
        runLocal: claudeLocalLauncher,
        runRemote: claudeRemoteLauncher
    });
}
```

---

### 8. MCP Server Object Assembly
**File**: `runClaude.ts:499-587`
```typescript
// Get auxiliary servers (vault + skill)
const auxMcpServers = await getYohoAuxMcpServers('claude', {
    apiClient: api,
    sessionId: response.id,
    orgId: response.orgId ?? null,
});

// Start YohoRemote MCP HTTP server
const yohoRemoteServer = await startYohoRemoteServer(session, {
    sessionSource: sessionSource || undefined,
    sessionCaller: sessionCaller || undefined,
    apiClient: api,
    machineId,
    yohoRemoteSessionId: response.id,
});

// ... later in the same function ...

// Final assembly
await loop({
    path: workingDirectory,
    model: options.model,
    permissionMode: 'bypassPermissions',
    startingMode,
    sessionId: resumeSessionId,
    messageQueue,
    api,
    allowedTools: sessionSource === 'brain' ? [...] : [...],
    onModeChange: (newMode) => { ... },
    onSessionReady: (sessionInstance) => { ... },
    mcpServers: {  // ← ASSEMBLED HERE (lines 581-587)
        'yoho_remote': {
            type: 'http' as const,
            url: yohoRemoteServer.url,
        },
        ...auxMcpServers,  // Merges vault + skill
    },
    session,
    claudeEnvVars: options.claudeEnvVars,
    claudeArgs: options.claudeArgs,
    startedBy,
    hookSettingsPath,
    executableCommand: 'claude'
});
```

---

## Complete Backwards Flow

```
spawn('claude', args)
  ↑
  args contains '--mcp-config' + value
  ↑
  appendMcpConfigArg(args, mcpServers)
    ↑
    resolveMcpConfigArg(mcpServers)
      ↑
      JSON.stringify({ mcpServers })
        ↑
        sdkOptions.mcpServers = opts.mcpServers
          ↑
          claudeRemote({..., mcpServers, ...})
            ↑
            claudeRemoteLauncher() calls claudeRemote(session.mcpServers)
              ↑
              session.mcpServers (readonly property)
                ↑
                new Session({..., mcpServers, ...})
                  ↑
                  loop({..., mcpServers, ...})
                    ↑
                    loop() receives mcpServers in opts
                      ↑
                      runClaude() assembles mcpServers
                        ├─ yoho_remote from startYohoRemoteServer()
                        └─ auxMcpServers from getYohoAuxMcpServers()
```

---

## The Actual CLI Command Executed

What Claude Code receives:

```bash
claude \
  --output-format stream-json \
  --verbose \
  --mcp-config '{"mcpServers":{"yoho_remote":{"type":"http","url":"http://localhost:9999"},"yoho-vault":{"type":"http","url":"http://localhost:3100/mcp","headers":{"x-org-id":"org-123"}},"skill":{"command":"bun","args":["run","/path/to/skill-stdio.ts"],"cwd":"/repo","env":{"PATH":"...","YOHO_ORG_ID":"org-123"}}}}' \
  --permission-mode bypassPermissions \
  --allowedTools ... \
  --input-format stream-json
```

Claude Code SDK then:
1. Parses the `--mcp-config` JSON
2. For each server:
   - HTTP: Creates HTTP client to the URL
   - Stdio: Spawns the command with args/cwd/env
3. Registers tools from all servers
4. Makes them available in the session

---

## No Magic

This is **exactly the same mechanism** that:
- `.mcp.json` files use (static config read at startup)
- `claude mcp add` uses (stores config in settings)
- Direct `--mcp-config` CLI argument uses

The only difference is that yoho-remote **assembles the config at runtime** instead of reading from disk.

