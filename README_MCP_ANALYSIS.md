# MCP Server Loading & Passing Flow - Complete Analysis

This directory contains a comprehensive analysis of how the yoho-remote daemon loads and passes MCP (Model Context Protocol) servers to Claude Code sessions.

## Documents

### 1. **CRITICAL_CODE_PATH.md** - Start here!
**Best for**: Quick understanding of the mechanism
- Shows the one line that makes it all work (query.ts:336)
- Traces backwards from spawn to assembly
- Complete backwards flow diagram
- Actual CLI command executed

### 2. **MCP_FLOW_SUMMARY.txt** - Executive overview
**Best for**: High-level understanding
- Quick reference of the complete flow
- File paths and line numbers
- Key locations where MCP servers are assembled/used
- How to replicate with direct Claude Code
- Comparison table with static config

### 3. **MCP_FLOW_ANALYSIS.md** - Deep dive
**Best for**: Detailed understanding
- Complete 9-phase flow with explanations
- Configuration format details
- Auxiliary MCP server resolution logic
- Key findings and architectural decisions
- Complete call stack

---

## TL;DR - The Answer

**Question**: How does yoho-remote pass MCP servers to Claude Code?

**Answer**: It uses the standard `--mcp-config` CLI argument (not proprietary).

The process:
1. MCP servers are assembled at runtime (lines 499-587 in runClaude.ts)
2. They're passed through Session → claudeRemote → query() function
3. In query.ts:336, `appendMcpConfigArg()` serializes them to JSON
4. The JSON is appended as `--mcp-config` CLI argument
5. Claude Code SDK receives and parses this JSON
6. Each server (HTTP or stdio) is connected and tools are registered

---

## Key Insight

There is **NO special or proprietary mechanism**. Yoho-remote uses:

✅ Standard `--mcp-config` CLI argument (Claude Code feature)
✅ Standard JSON format (MCP protocol spec)
✅ Standard HTTP & stdio transports (MCP spec)
✅ Standard Node.js process spawning

The only difference is **runtime assembly** instead of static disk-based config.

---

## Critical Code Location

**The single point where MCP servers become CLI arguments:**

```
File: cli/src/claude/sdk/query.ts
Line: 336

cleanupMcpConfig = appendMcpConfigArg(spawnArgs, mcpServers)
```

This line:
1. Takes assembled mcpServers object
2. Serializes to JSON (or temp file on Windows)
3. Appends `--mcp-config` argument
4. Later: `spawn('claude', args)` executes with this argument

---

## File Paths Quick Reference

| What | File | Line(s) |
|------|------|---------|
| Initial assembly | runClaude.ts | 499-587 |
| MCP server object | runClaude.ts | 581-587 |
| Session storage | session.ts | 18, 68 |
| SDK options | claudeRemote.ts | 155 |
| Query function | query.ts | 256-434 |
| **CLI argument assembly** | **query.ts** | **336** |
| **JSON serialization** | **mcpConfig.ts** | **15-58** |
| Process spawn | query.ts | 342-349 |
| Aux servers | yohoMcpServers.ts | 126-168 |

---

## MCP Configuration Format

What gets passed as `--mcp-config`:

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
      "headers": { "x-org-id": "org-123" }
    },
    "skill": {
      "command": "bun",
      "args": ["run", "/path/to/skill-stdio.ts"],
      "cwd": "/repo/root",
      "env": { "PATH": "...", "YOHO_ORG_ID": "org-123" }
    }
  }
}
```

- **HTTP servers**: `type: 'http'` + `url` (+ optional `headers`)
- **Stdio servers**: `command`, `args`, `cwd`, `env`

---

## To Replicate with Direct Claude Code

### Option 1: Static `.mcp.json`
```bash
# Create ~/.claude/mcp.json
# (same JSON format as above)
claude
```

### Option 2: CLI `--mcp-config` (same as yoho-remote)
```bash
claude --mcp-config '{"mcpServers":{...}}'
# Or with file:
claude --mcp-config /path/to/config.json
```

### Option 3: `claude mcp add`
```bash
claude mcp add server-name "http://localhost:3100/mcp"
```

---

## Analysis Methodology

This analysis:
1. ✅ Traced all 8 key files you identified
2. ✅ Found the exact lines where MCP servers are assembled
3. ✅ Identified the critical single-point (query.ts:336)
4. ✅ Confirmed no proprietary mechanisms
5. ✅ Documented platform-specific behavior (Unix vs Windows)
6. ✅ Mapped the complete backwards flow from spawn to assembly
7. ✅ Verified HTTP & stdio transport are standard MCP
8. ✅ Showed how to replicate with direct Claude Code

---

## Dynamic vs Static Configuration

### Static (`.mcp.json` or `claude mcp add`)
- Stored on disk
- Read at Claude startup
- URLs hardcoded
- Fixed set of servers

### Dynamic (yoho-remote)
- Assembled at runtime
- Session-specific URLs (from startYohoRemoteServer)
- API-sourced project paths (from getYohoAuxMcpServers)
- Org isolation headers added automatically
- Per-session tool restrictions (allowedTools/disallowedTools)
- Runtime fallbacks (HTTP vs stdio based on availability)

**Transport**: Both use same mechanism (`--mcp-config` CLI argument)

---

## Why HTTP Servers Matter

Yoho-remote prefers HTTP servers because:
1. **No process spawning needed** - just HTTP client connection
2. **Shared resources** - single HTTP server serves multiple sessions
3. **Easier to manage** - URLs instead of process commands
4. **Org isolation** - headers passed in requests

That's why:
- `yoho_remote` always uses HTTP (startYohoRemoteServer)
- `yoho-vault` falls back to HTTP at `http://<host>:3100/mcp` when local files unavailable
- CLI tools with `claude mcp add` often use stdio for simplicity

---

## Auxiliary MCP Servers Resolution

How yoho-remote determines vault server:

1. Check `YOHO_MEMORY_PATH` env
2. Query API for project list (YohoVault / yoho-vault names)
3. Check legacy path `~/happy/yoho-memory`
4. If found & local files exist → use stdio
5. Else if Claude flavor → use HTTP fallback: `http://<host>:3100/mcp`

This smart fallback means yoho-remote works whether vault is:
- Locally available (uses stdio for lower latency)
- Deployed on server (uses HTTP)
- Not available at all (tools unavailable)

---

## What This Enables

The runtime assembly approach enables:
- ✅ Session-specific MCP server configurations
- ✅ Tool restrictions per session/source
- ✅ Org isolation at runtime
- ✅ Fallback strategies based on availability
- ✅ API-driven project discovery
- ✅ No need to modify Claude's config files
- ✅ Easy addition of new MCP servers without CLI management

All while using **standard Claude Code mechanisms**.

---

## Questions Answered

✅ **Where are MCP servers first assembled?**
   - runClaude.ts lines 499-587

✅ **How are they passed to the Claude process?**
   - Via `--mcp-config` CLI argument (query.ts:336)

✅ **What format does Claude Code expect?**
   - JSON: `{ "mcpServers": { "name": {...}, ... } }`

✅ **Is there something special yoho-remote does?**
   - No - it's runtime assembly instead of disk-based config

✅ **Can `claude mcp add` with HTTP work?**
   - Yes! Same mechanism as yoho-remote
   - `claude mcp add server-name "http://localhost:3100/mcp"`

---

## Conclusion

Yoho-remote uses **no proprietary or hidden mechanisms** to make MCP tools available to Claude Code. It leverages:

1. Standard `--mcp-config` CLI argument
2. Standard JSON configuration format
3. Standard HTTP and stdio MCP transports
4. Standard Node.js process spawning

The sophistication lies purely in:
- **Runtime assembly** from multiple sources
- **Dynamic URL generation** per session
- **Intelligent fallbacks** based on availability
- **Automatic org isolation** at the transport layer

This makes it a **reference implementation** for how to provide dynamic, session-scoped MCP tool access in Claude Code.

