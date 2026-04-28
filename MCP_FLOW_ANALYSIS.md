# Yoho-Remote MCP Server Loading & Passing Flow

## Executive Summary

The yoho-remote daemon **does NOT use anything special or proprietary** to pass MCP servers to Claude Code. It uses Claude Code's standard `--mcp-config` CLI argument mechanism. The key difference is:

1. **Configuration format**: MCP servers are passed as JSON via `--mcp-config` (either inline JSON or path to a JSON file)
2. **HTTP transport**: Yoho-remote uses HTTP-based MCP servers (like `yoho_remote` and `yoho-vault`), which are standard MCP protocol over HTTP
3. **Dynamic assembly**: MCP servers are assembled at runtime from multiple sources and passed to the Claude process before execution

## Complete Data Flow: MCP Servers from Assembly to Claude Execution

### Phase 1: Assembly (RunClaude) - Lines 499-587

**File**: `cli/src/claude/runClaude.ts` - `runClaude()` function

The process starts by assembling MCP servers from multiple sources:

```
┌─────────────────────────────────────────┐
│ 1. Auxiliary MCP Servers (Line 499)     │
├─────────────────────────────────────────┤
│ getYohoAuxMcpServers('claude', {        │
│   apiClient: api,                        │
│   sessionId: response.id,                │
│   orgId: response.orgId ?? null,         │
│ })                                       │
└──────────────────────────────────────────┘
         ↓
  Returns: Record<string, MCP server config>
  - yoho-vault (HTTP or stdio based on availability)
  - skill (optional)
  
┌──────────────────────────────────────────────────────────┐
│ 2. YohoRemote MCP Server (Lines 190-197)                 │
├──────────────────────────────────────────────────────────┤
│ const yohoRemoteServer =                                  │
│   await startYohoRemoteServer(session, {...})            │
│                                                           │
│ Provides:                                                 │
│ - url: HTTP endpoint (e.g., http://localhost:9999)      │
│ - toolNames: Available tool names                         │
└──────────────────────────────────────────────────────────┘
         ↓
    HTTP Server Started
```

**Key Line**: Line 581-587 - **Final MCP Server Object Assembled**:

```typescript
mcpServers: {
    'yoho_remote': {
        type: 'http' as const,
        url: yohoRemoteServer.url,
    },
    ...auxMcpServers,  // Merges yoho-vault and skill servers
}
```

This object is the **single source of truth** for all MCP servers. It gets passed to the `loop()` function.

---

### Phase 2: Session Creation (loop.ts) - Line 44-86

**File**: `cli/src/claude/loop.ts` - `loop()` function

The loop function receives `mcpServers` as a parameter:

```typescript
interface LoopOptions {
    ...
    mcpServers: Record<string, any>  // Line 32: Receives assembled MCP config
    ...
}
```

The loop creates a new `Session` object:

```typescript
// Lines 53-72
let session = new Session({
    ...
    mcpServers: opts.mcpServers,  // Pass through to Session
    ...
});
```

---

### Phase 3: Session Storage - session.ts

**File**: `cli/src/claude/session.ts` - `Session` class

The Session class stores mcpServers as a readonly property:

```typescript
export class Session extends AgentSessionBase<EnhancedMode> {
    ...
    readonly mcpServers: Record<string, any>;  // Line 18
    
    constructor(opts: {...}) {
        ...
        this.mcpServers = opts.mcpServers;  // Line 68
    }
}
```

The mcpServers stay in memory during the entire session lifecycle.

---

### Phase 4: Remote/Local Launcher Selection (loop.ts)

**File**: `cli/src/claude/loop.ts` - Lines 79-85

The loop determines which launcher to use (local interactive or remote):

```typescript
await runLocalRemoteLoop({
    session,  // Contains mcpServers
    startingMode: opts.startingMode,
    logTag: 'loop',
    runLocal: claudeLocalLauncher,      // Not used in daemon
    runRemote: claudeRemoteLauncher     // Used in daemon
});
```

---

### Phase 5: Remote Mode - claudeRemoteLauncher (Claude SDK Path)

**File**: `cli/src/claude/claudeRemoteLauncher.ts` - `claudeRemoteLauncher()` function

The remote launcher calls `claudeRemote()` which interfaces with the Claude SDK:

```typescript
// Lines 150+ (not fully shown, but orchestrates)
await claudeRemote({
    sessionId: session.sessionId,
    path: session.path,
    mcpServers: session.mcpServers,  // ← PASSED HERE
    ...
});
```

---

### Phase 6: SDK Integration (claudeRemote.ts)

**File**: `cli/src/claude/claudeRemote.ts` - `claudeRemote()` function

The mcpServers are placed into SDK options:

```typescript
// Lines 152-167
const sdkOptions: Options = {
    cwd: opts.path,
    resume: startFrom ?? undefined,
    mcpServers: opts.mcpServers,  // ← Line 155: STORED IN SDK OPTIONS
    permissionMode: initial.mode.permissionMode,
    model: initial.mode.model,
    ...
};

// Lines 194-197: SDK query is called with options
const response = query({
    prompt: messages,
    options: sdkOptions,  // ← Passed to SDK query function
});
```

---

### Phase 7: MCP Config Serialization (query.ts)

**File**: `cli/src/claude/sdk/query.ts` - `query()` function (Lines 256-434)

This is where the **actual mechanism** occurs:

```typescript
// Lines 256-280: Function signature
export function query(config: {
    prompt: QueryPrompt
    options?: QueryOptions
}): Query {
    const {
        ...
        mcpServers,  // ← Line 269: Extract from options
        ...
    } = config.options

    // Lines 287-307: Build command-line arguments
    const args = ['--output-format', 'stream-json', '--verbose']
    let cleanupMcpConfig: (() => void) | null = null

    if (customSystemPrompt) args.push('--system-prompt', customSystemPrompt)
    if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt)
    if (maxTurns) args.push('--max-turns', maxTurns.toString())
    if (model) args.push('--model', model)
    ...
    if (permissionMode) args.push('--permission-mode', permissionMode)
    
    // Lines 317-321: Handle prompt
    if (typeof prompt === 'string') {
        args.push('--print', prompt.trim())
    } else {
        args.push('--input-format', 'stream-json')
    }

    // ↓ ↓ ↓ CRITICAL: MCP CONFIG APPENDED HERE ↓ ↓ ↓
    // Line 336
    cleanupMcpConfig = appendMcpConfigArg(spawnArgs, mcpServers)
    // ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑ ↑
```

### Phase 7a: MCP Config Argument Assembly (mcpConfig.ts)

**File**: `cli/src/claude/utils/mcpConfig.ts` - `appendMcpConfigArg()` (Lines 46-58)

This function serializes the MCP servers object into a CLI argument:

```typescript
export function appendMcpConfigArg(
    args: string[],
    mcpServers?: Record<string, unknown>,
    options?: McpConfigOptions
): (() => void) | null {
    if (!mcpServers || Object.keys(mcpServers).length === 0) {
        return null;
    }

    // Lines 55-57: Serialize config
    const { value, cleanup } = resolveMcpConfigArg(mcpServers, options);
    args.push('--mcp-config', value);  // ← ADDS TO CLI ARGS
    return cleanup ?? null;
}
```

The `resolveMcpConfigArg()` function (Lines 15-44) handles two cases:

**Case 1: Non-Windows (stdin passes JSON)**:
```typescript
const configJson = JSON.stringify({ mcpServers });  // ← SERIALIZES TO JSON
const useFile = options?.useFile ?? process.platform === 'win32';
if (!useFile) {
    return { value: configJson };  // ← Returns JSON string directly
}
```

**Case 2: Windows (uses temp file)**:
```typescript
const filePath = join(dir, `mcp-config-${process.pid}-${Date.now()}-...json`);
writeFileSync(filePath, configJson, "utf8");  // ← Writes to temp file
return {
    value: filePath,  // ← Returns file path
    cleanup: () => { unlinkSync(filePath); }
};
```

**Result**: The `args` array now contains:
```
['--output-format', 'stream-json', '--verbose', '--mcp-config', '<JSON or file path>', ...]
```

---

### Phase 8: Claude Code Process Spawn (query.ts continued)

**File**: `cli/src/claude/sdk/query.ts` - Lines 338-349

The Claude process is spawned with the assembled arguments:

```typescript
// Line 339: Determine executable
const spawnCommand = pathToClaudeCodeExecutable  // Usually 'claude'
const spawnArgs = args  // Contains '--mcp-config' argument

// Lines 342-349: Spawn process
const child = spawn(spawnCommand, spawnArgs, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: config.options?.abort,
    env: spawnEnv,
    shell: process.platform === 'win32'  // Use shell on Windows for command resolution
}) as ChildProcessWithoutNullStreams
```

**Actual command executed**:
```bash
claude --output-format stream-json --verbose --mcp-config '{"mcpServers":{"yoho_remote":{"type":"http","url":"http://localhost:9999"},"yoho-vault":{...}}}' --permission-mode bypassPermissions ...
```

---

### Phase 9: Claude Code SDK Processing (Internal to Claude)

The Claude Code SDK receives the `--mcp-config` argument and:

1. **Parses the JSON** (or reads file if path provided)
2. **Extracts `mcpServers` object** from the JSON
3. **Connects to each MCP server**:
   - For HTTP servers: Creates HTTP client to the specified URL
   - For stdio servers: Spawns process and communicates via stdin/stdout
4. **Registers tools** from each server
5. **Makes tools available** in the Claude session

---

## MCP Server Configuration Format

The JSON structure passed via `--mcp-config`:

```json
{
  "mcpServers": {
    "yoho_remote": {
      "type": "http",
      "url": "http://localhost:9999"
    },
    "yoho-vault": {
      "type": "http",
      "url": "http://localhost:3100/mcp",
      "headers": {
        "x-org-id": "org-123"
      }
    },
    "skill": {
      "command": "bun",
      "args": ["run", "/path/to/skill-stdio.ts"],
      "cwd": "/repo/root",
      "env": {
        "PATH": "/home/user/.bun/bin:...",
        "YOHO_ORG_ID": "org-123"
      }
    }
  }
}
```

**Key differences**:
- **HTTP servers**: Only need `type: 'http'` and `url`
- **Stdio servers**: Use `command`, `args`, `cwd`, `env` for process spawning
- **Headers**: Optional, passed in HTTP requests (e.g., for org isolation)

---

## Where Auxiliary MCP Servers Are Assembled (yohoMcpServers.ts)

**File**: `cli/src/utils/yohoMcpServers.ts` - `getYohoAuxMcpServers()` (Lines 126-168)

This function builds the auxiliary MCP servers:

```typescript
export async function getYohoAuxMcpServers(
    flavor: 'claude' | 'codex',
    options?: YohoAuxMcpServerOptions
): Promise<Record<string, YohoMcpServerConfig>> {
    ...
    // Lines 135-139: Resolve repo paths
    const vaultRepoRoot = resolveRepoRoot(...) ?? await resolveProjectRepoRoot(...) ?? ...;
    const vaultLocalPath = vaultRepoRoot ? join(vaultRepoRoot, 'src/mcp/stdio.ts') : null;
    const skillLocalPath = vaultRepoRoot ? join(vaultRepoRoot, 'src/mcp/skill-stdio.ts') : null;

    const result: Record<string, YohoMcpServerConfig> = {};

    // Lines 143-149: If local files exist → use stdio
    if (vaultLocalPath && existsSync(vaultLocalPath)) {
        result[serverName] = {
            command: 'bun',
            args: ['run', vaultLocalPath],
            cwd: vaultRepoRoot ?? `${homeDir}/happy/yoho-memory`,
            env: { PATH: buildPathEnv(homeDir), ...orgHeaders },
        };
        ...
    } 
    // Lines 158-164: Else if Claude flavor → use HTTP fallback
    else if (flavor === 'claude') {
        const host = deriveAuxMcpHost();  // From YOHO_REMOTE_URL env
        if (host) {
            result[serverName] = {
                type: 'http',
                url: `http://${host}:3100/mcp`,  // ← VAULT_HTTP_PORT = 3100
                headers: orgHeaders
            };
        }
    }

    return result;
}
```

**Resolution order**:
1. Check `YOHO_MEMORY_PATH` env
2. Query API for project list (yoho-vault, yoho-memory)
3. Check legacy path `~/happy/yoho-memory`
4. If none found and Claude flavor: Fall back to HTTP endpoint

---

## Key Findings

### 1. **No Special/Proprietary Mechanism**
Yoho-remote uses **exactly the same mechanism** as static `.mcp.json` files or `claude mcp add`:
- The `--mcp-config` CLI argument is standard Claude Code SDK feature
- The JSON format is standard MCP server configuration
- HTTP and stdio transports are standard MCP protocol

### 2. **HTTP Transport is the Key Difference**
Most `claude mcp add` configurations use stdio (spawns processes). Yoho-remote prefers:
- **HTTP servers**: `yoho_remote` MCP server runs as HTTP service (started by `startYohoRemoteServer()`)
- **Fallback to HTTP for vault**: If local yoho-vault not available, uses HTTP endpoint at `http://<host>:3100/mcp`

### 3. **Dynamic vs. Static Configuration**
- **Static** (`.mcp.json` or `claude mcp add`): Configuration is read from disk at each Claude startup
- **Dynamic** (yoho-remote): Configuration is assembled at runtime with:
  - Session-specific URLs (yoho_remote server URL)
  - API-sourced project paths (for yoho-vault)
  - Org isolation headers
  - Runtime-determined fallbacks (HTTP vs. stdio)

### 4. **Where the Magic Happens**
The actual transmission to Claude Code is in **query.ts line 336**:
```typescript
cleanupMcpConfig = appendMcpConfigArg(spawnArgs, mcpServers)
```

This single line:
1. Takes the assembled `mcpServers` object
2. Serializes it to JSON
3. Passes it as `--mcp-config` CLI argument
4. Claude Code SDK reads this and connects to all servers

---

## To Make MCP Tools Available in Direct Claude Code Usage

If you want to use Claude Code directly (not through yoho-remote daemon) with MCP servers:

### Option 1: Static `.mcp.json` (Recommended for development)
```bash
# Create ~/.claude/mcp.json
{
  "mcpServers": {
    "example": {
      "type": "http",
      "url": "http://localhost:3100/mcp"
    }
  }
}

# Claude Code will read this automatically
claude
```

### Option 2: CLI `--mcp-config` (Same mechanism as yoho-remote)
```bash
# Pass JSON directly
claude --mcp-config '{"mcpServers":{"example":{"type":"http","url":"http://localhost:3100/mcp"}}}'

# Or use a file (same as .mcp.json)
claude --mcp-config /path/to/mcp-config.json
```

### Option 3: `claude mcp add` (User-friendly)
```bash
claude mcp add example "http://localhost:3100/mcp"  # HTTP transport
claude mcp add example "command" "arg1" "arg2"      # Stdio transport
```

This stores configuration in Claude's settings files and reads it automatically on startup.

---

## Complete Call Stack (Top to Bottom)

```
runClaude() [runClaude.ts:66]
  ↓
  getYohoAuxMcpServers('claude', {...}) [yohoMcpServers.ts:126]
    ↓
    Returns: { 'yoho-vault': {...}, 'skill': {...} }
  ↓
  startYohoRemoteServer(session, {...}) [runClaude.ts:190]
    ↓
    Returns: { url: 'http://localhost:9999', toolNames: [...] }
  ↓
  mcpServers = {
    'yoho_remote': { type: 'http', url: '...' },
    ...auxMcpServers
  } [runClaude.ts:581-587]
  ↓
  loop({..., mcpServers, ...}) [runClaude.ts:506]
    ↓
    new Session({..., mcpServers, ...}) [session.ts:27]
    ↓
    runLocalRemoteLoop({session, ...}) [loop.ts:79]
      ↓
      claudeRemoteLauncher(session) [loop.ts:84]
        ↓
        claudeRemote({..., mcpServers: session.mcpServers, ...}) [claudeRemote.ts:25]
          ↓
          sdkOptions.mcpServers = opts.mcpServers [claudeRemote.ts:155]
          ↓
          query({prompt, options: sdkOptions}) [claudeRemote.ts:194]
            ↓
            query() function [query.ts:256]
              ↓
              appendMcpConfigArg(spawnArgs, mcpServers) [query.ts:336]
                ↓
                resolveMcpConfigArg(mcpServers) [mcpConfig.ts:15]
                  ↓
                  JSON.stringify({ mcpServers }) [mcpConfig.ts:19]
                  ↓
                  args.push('--mcp-config', value) [mcpConfig.ts:56]
              ↓
              spawn('claude', args) [query.ts:342]
                ↓
                Claude Code SDK receives:
                  claude --mcp-config '{"mcpServers":{...}}'
                  ↓
                  Parses JSON, connects to servers, registers tools
```

---

## Summary Table

| Aspect | yoho-remote | Direct claude command | Static .mcp.json |
|--------|------------|----------------------|------------------|
| **How config is provided** | `--mcp-config` CLI arg (assembled at runtime) | `--mcp-config` CLI arg (passed manually) | Auto-read from `~/.claude/mcp.json` |
| **Configuration source** | Runtime assembly from API + environment | Manual/hardcoded | Static file |
| **HTTP server support** | ✅ Full support (primary method) | ✅ Full support | ✅ Full support |
| **Stdio server support** | ✅ Full support | ✅ Full support | ✅ Full support |
| **Dynamic URL resolution** | ✅ Session-specific URLs | ❌ Must be hardcoded | ❌ Must be hardcoded |
| **Org isolation** | ✅ Headers included automatically | ❌ Manual headers needed | ❌ Manual headers needed |
| **Transport mechanism** | Claude SDK's `--mcp-config` parser | Claude SDK's `--mcp-config` parser | Claude SDK's config loader |
