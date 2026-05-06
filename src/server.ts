// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import express from "express";
import pg from "pg";
import { ProxyAgent, request } from "undici";
import {
  AdminSessionAuthError,
  buildAdminSessionLogoutCookie,
  exchangeAdminSession,
  extractBearerToken,
  getAdminSession,
} from "./adminSession.js";
import { appConfig } from "./config.js";
import { applyMultiplier as applyMultiplierString } from "./billing/engine.js";
import {
  RELAY_ERROR_CODES,
  classifyClientFacingRelayError,
} from "./proxy/clientFacingErrors.js";
import {
  InputValidationError,
  normalizeBillingCurrency,
  sanitizeErrorMessage,
} from "./security/inputValidation.js";
import { probeRateLimits } from "./usage/rateLimitProbe.js";
import { probeOpenAICodexRateLimits } from "./usage/openaiRateLimitProbe.js";
import { probeClaudeCompatibleConnectivity } from "./usage/claudeCompatibleProbe.js";
import { providerRequiresProxy } from "./providers/catalog.js";
import {
  isGeminiOauthAccount,
  retrieveGeminiUserQuota,
} from "./providers/googleGeminiOauth.js";
import { notifyCcwebappAgentReply } from "./support/ccwebappNotify.js";
import { sendEmail } from "./emailService.js";
import { projectRoot } from "./projectRoot.js";
import {
  createRelayControlClient,
  RelayControlConfigError,
} from "./control/relayControlClient.js";
// Probe 用多个 captive-portal 端点做 fallback：任一通过即视为链路通。
// 单一端点（如 cp.cloudflare.com）会被某些出口 ISP/路由器拦截，导致节点能正常上网却被误判 unhealthy。
const PROXY_CONNECTIVITY_CHECK_URLS = [
  "https://www.gstatic.com/generate_204",
  "https://cp.cloudflare.com/generate_204",
  "https://captive.apple.com/hotspot-detect.html",
];
const PROXY_EGRESS_IP_URL = "http://api64.ipify.org?format=json";
const PROXY_PROBE_TIMEOUT_MS = 12_000;
const XRAY_MANAGED_CONFIG_PATH = process.env.COR_XRAY_CONFIG_PATH || "/etc/xray/cor-managed.json";
const XRAY_MANAGED_LISTEN = process.env.COR_XRAY_LISTEN || "127.0.0.1";
const XRAY_MANAGED_PORT_BASE = Number(process.env.COR_XRAY_PORT_BASE || 10880);
const XRAY_MANAGED_SERVICE = process.env.COR_XRAY_SERVICE_NAME || "";
const XRAY_MANAGED_BIN = process.env.COR_XRAY_BIN || "xray";
const XRAY_SYSTEMCTL_BIN = process.env.COR_SYSTEMCTL_BIN || "systemctl";
const execFileAsync = promisify(execFile);
const XRAY_TEST_UNSUPPORTED_PATTERN = /unknown command|Run 'xray help' for usage/i;

function splitShellWords(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTcpPort(host, port, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      const done = (result) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(750);
      socket.once("connect", () => done(true));
      socket.once("timeout", () => done(false));
      socket.once("error", () => done(false));
    });
    if (ok) return true;
    await sleep(200);
  }
  return false;
}
const ADMIN_UI_DIST_DIR = path.join(projectRoot, "web/dist");
const ADMIN_UI_INDEX_PATH = path.join(ADMIN_UI_DIST_DIR, "index.html");
let ADMIN_UI_INDEX_CACHE = null;
function readAdminUiIndex() {
  if (ADMIN_UI_INDEX_CACHE !== null) {
    return ADMIN_UI_INDEX_CACHE;
  }
  ADMIN_UI_INDEX_CACHE = fs.readFileSync(ADMIN_UI_INDEX_PATH, "utf8");
  return ADMIN_UI_INDEX_CACHE;
}
const STATIC_ASSET_EXTENSIONS = new Set([
  ".avif",
  ".css",
  ".gif",
  ".html",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".map",
  ".mjs",
  ".png",
  ".svg",
  ".txt",
  ".webmanifest",
  ".webp",
  ".woff",
  ".woff2",
]);

function isEventStreamContentType(value) {
  if (typeof value === "string") {
    return value.toLowerCase().includes("text/event-stream");
  }
  if (Array.isArray(value)) {
    return value.some((item) => isEventStreamContentType(item));
  }
  return false;
}

function readContentTypeFromHeaderBag(headers) {
  if (!headers || typeof headers !== "object") {
    return null;
  }
  if (Array.isArray(headers)) {
    for (let index = 0; index < headers.length - 1; index += 2) {
      if (String(headers[index]).toLowerCase() === "content-type") {
        return headers[index + 1];
      }
    }
    return null;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "content-type") {
      return value;
    }
  }
  return null;
}

function isOpenAIStyleRelayPath(pathname) {
  return (
    pathname === "/chat/completions" ||
    pathname === "/responses" ||
    pathname.startsWith("/responses/") ||
    pathname === "/v1/chat/completions" ||
    pathname === "/v1/models" ||
    pathname === "/v1/responses" ||
    pathname.startsWith("/v1/responses/")
  );
}

function relayDrainingResponseBody(pathname) {
  const message =
    "Relay instance is draining. Please retry on another instance.";
  if (isOpenAIStyleRelayPath(pathname)) {
    return {
      error: {
        message,
        type: "server_error",
        code: RELAY_ERROR_CODES.SERVICE_UNAVAILABLE,
      },
    };
  }
  return {
    type: "error",
    error: {
      type: "api_error",
      message,
      internal_code: RELAY_ERROR_CODES.SERVICE_UNAVAILABLE,
    },
  };
}

function buildProxyProbeHeaders() {
  return {};
}
function requireAdminToken(req, res, next) {
  const bearerToken = extractBearerToken(req);
  if (bearerToken === appConfig.adminToken) {
    next();
    return;
  }
  const session = getAdminSession(req);
  if (!session) {
    res.status(401).json({
      error: "unauthorized",
      message: "缺少有效的管理台会话或 admin token",
    });
    return;
  }
  if (req.header("x-admin-csrf") !== session.csrfToken) {
    res.status(403).json({
      error: "invalid_admin_session",
      message: "管理台会话缺少有效的 CSRF 校验",
    });
    return;
  }
  next();
}

let corPgPool: pg.Pool | null = null;
class BetterAuthDatabaseConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "BetterAuthDatabaseConfigError";
  }
}
class BetterAuthRequestError extends Error {
  constructor(statusCode, responseBody, message) {
    super(message);
    this.name = "BetterAuthRequestError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}
function getCorPgPool(): pg.Pool {
  if (!appConfig.betterAuthDatabaseUrl) {
    throw new BetterAuthDatabaseConfigError(
      "BETTER_AUTH_DATABASE_URL is not configured",
    );
  }
  if (!corPgPool) {
    corPgPool = new pg.Pool({
      connectionString: appConfig.betterAuthDatabaseUrl,
      max: 2,
      idleTimeoutMillis: 60000,
    });
  }
  return corPgPool;
}
export async function closeCorPgPool(): Promise<void> {
  const pool = corPgPool;
  corPgPool = null;
  if (!pool) {
    return;
  }
  await pool.end();
}

function betterAuthResult(status, data) {
  return { ok: status >= 200 && status < 300, status, data };
}
function unwrapBetterAuthResult(result, message) {
  if (result.ok) {
    return result.data;
  }
  throw new BetterAuthRequestError(result.status, result.data, message);
}

function normalizeCorUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: Boolean(row.emailVerified),
    image: row.image ?? null,
    role: row.role ?? "user",
    banned: Boolean(row.banned),
    banReason: row.banReason ?? null,
    banExpires: row.banExpires ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

function normalizeCorOrganization(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    logo: row.logo ?? null,
    metadata: row.metadata ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

function normalizeCorMember(row) {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    role: row.role,
    createdAt: row.createdAt ?? null,
    user: row.user_id
      ? {
          id: row.user_id,
          name: row.user_name,
          email: row.user_email,
          image: row.user_image ?? null,
        }
      : undefined,
  };
}

async function hashBetterAuthPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = await new Promise((resolve, reject) => {
    crypto.scrypt(
      password.normalize("NFKC"),
      salt,
      64,
      {
        N: 16384,
        r: 16,
        p: 1,
        maxmem: 128 * 16384 * 16 * 2,
      },
      (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey);
      },
    );
  });
  return `${salt}:${key.toString("hex")}`;
}

async function listCorBetterAuthUsers(query = {}) {
  const pool = getCorPgPool();
  const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 1000);
  const offset = Math.max(Number(query.offset) || 0, 0);
  const sortBy = ["createdAt", "updatedAt", "email", "name", "role"].includes(
    String(query.sortBy),
  )
    ? String(query.sortBy)
    : "createdAt";
  const sortDirection =
    String(query.sortDirection).toLowerCase() === "asc" ? "ASC" : "DESC";
  const where = [];
  const values = [];
  if (query.searchValue) {
    const field = query.searchField === "name" ? "name" : "email";
    values.push(`%${String(query.searchValue)}%`);
    where.push(`"${field}" ILIKE $${values.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const usersResult = await pool.query(
    `SELECT id, name, email, "emailVerified", image, role, banned, "banReason", "banExpires", "createdAt", "updatedAt"
         FROM "user" ${whereSql}
         ORDER BY "${sortBy}" ${sortDirection}
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limit, offset],
  );
  const totalResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM "user" ${whereSql}`,
    values,
  );
  return betterAuthResult(200, {
    users: usersResult.rows.map(normalizeCorUser),
    total: totalResult.rows[0]?.total ?? 0,
    limit,
    offset,
  });
}

async function createCorBetterAuthUser(body = {}) {
  const email = getOptionalString(body.email)?.toLowerCase();
  const name = getOptionalString(body.name);
  if (!email || !name)
    return betterAuthResult(400, {
      error: "bad_request",
      message: "email and name are required",
    });
  const pool = getCorPgPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      'SELECT id FROM "user" WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [email],
    );
    if (existing.rows.length > 0) {
      await client.query("ROLLBACK");
      return betterAuthResult(400, {
        error: "user_already_exists",
        message: "User already exists",
      });
    }
    const userId = crypto.randomUUID();
    const userResult = await client.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", image, role, banned, "createdAt", "updatedAt")
             VALUES ($1, $2, $3, false, $4, $5, false, NOW(), NOW())
             RETURNING id, name, email, "emailVerified", image, role, banned, "banReason", "banExpires", "createdAt", "updatedAt"`,
      [
        userId,
        name,
        email,
        body.image ?? null,
        getOptionalString(body.role) ?? "user",
      ],
    );
    if (getOptionalString(body.password)) {
      await client.query(
        `INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
                 VALUES ($1, $2, 'credential', $3, $4, NOW(), NOW())`,
        [
          crypto.randomUUID(),
          userId,
          userId,
          await hashBetterAuthPassword(String(body.password)),
        ],
      );
    }
    await client.query("COMMIT");
    return betterAuthResult(200, {
      user: normalizeCorUser(userResult.rows[0]),
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function updateCorBetterAuthUser(body = {}) {
  const userId = getOptionalString(body.userId);
  const data = body.data && typeof body.data === "object" ? body.data : {};
  if (!userId || Object.keys(data).length === 0)
    return betterAuthResult(400, {
      error: "bad_request",
      message: "userId and data are required",
    });
  const allowed = new Map([
    ["name", "name"],
    ["email", "email"],
    ["role", "role"],
    ["banned", "banned"],
    ["banReason", "banReason"],
    ["banExpires", "banExpires"],
    ["image", "image"],
    ["emailVerified", "emailVerified"],
  ]);
  const sets = ['"updatedAt" = NOW()'];
  const values = [];
  for (const [key, column] of allowed.entries()) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      values.push(data[key]);
      sets.push(`"${column}" = $${values.length}`);
    }
  }
  values.push(userId);
  const result = await getCorPgPool().query(
    `UPDATE "user" SET ${sets.join(", ")} WHERE id = $${values.length}
         RETURNING id, name, email, "emailVerified", image, role, banned, "banReason", "banExpires", "createdAt", "updatedAt"`,
    values,
  );
  if (!result.rows[0])
    return betterAuthResult(404, {
      error: "user_not_found",
      message: "User not found",
    });
  return betterAuthResult(200, normalizeCorUser(result.rows[0]));
}

async function removeCorBetterAuthUser(body = {}) {
  const userId = getOptionalString(body.userId);
  if (!userId)
    return betterAuthResult(400, {
      error: "bad_request",
      message: "userId is required",
    });
  await getCorPgPool().query('DELETE FROM "user" WHERE id = $1', [userId]);
  return betterAuthResult(200, { success: true });
}

async function banCorBetterAuthUser(body = {}) {
  const userId = getOptionalString(body.userId);
  if (!userId)
    return betterAuthResult(400, {
      error: "bad_request",
      message: "userId is required",
    });
  const result = await getCorPgPool().query(
    `UPDATE "user" SET banned = true, "banReason" = $2, "banExpires" = $3, "updatedAt" = NOW()
         WHERE id = $1
         RETURNING id, name, email, "emailVerified", image, role, banned, "banReason", "banExpires", "createdAt", "updatedAt"`,
    [
      userId,
      getOptionalString(body.banReason) ?? "No reason",
      body.banExpiresIn
        ? new Date(Date.now() + Number(body.banExpiresIn) * 1000)
        : null,
    ],
  );
  await getCorPgPool().query('DELETE FROM session WHERE "userId" = $1', [
    userId,
  ]);
  if (!result.rows[0])
    return betterAuthResult(404, {
      error: "user_not_found",
      message: "User not found",
    });
  return betterAuthResult(200, { user: normalizeCorUser(result.rows[0]) });
}

async function unbanCorBetterAuthUser(body = {}) {
  const userId = getOptionalString(body.userId);
  if (!userId)
    return betterAuthResult(400, {
      error: "bad_request",
      message: "userId is required",
    });
  const result = await getCorPgPool().query(
    `UPDATE "user" SET banned = false, "banReason" = NULL, "banExpires" = NULL, "updatedAt" = NOW()
         WHERE id = $1
         RETURNING id, name, email, "emailVerified", image, role, banned, "banReason", "banExpires", "createdAt", "updatedAt"`,
    [userId],
  );
  if (!result.rows[0])
    return betterAuthResult(404, {
      error: "user_not_found",
      message: "User not found",
    });
  return betterAuthResult(200, { user: normalizeCorUser(result.rows[0]) });
}

async function listCorBetterAuthOrganizations() {
  const result = await getCorPgPool().query(
    'SELECT id, name, slug, logo, metadata, "createdAt", "updatedAt" FROM organization ORDER BY "createdAt" DESC NULLS LAST',
  );
  return betterAuthResult(200, result.rows.map(normalizeCorOrganization));
}

async function createCorBetterAuthOrganization(body = {}) {
  const name = getOptionalString(body.name);
  const slug = getOptionalString(body.slug) ?? makeOrgSlug(name);
  if (!name || !slug)
    return betterAuthResult(400, {
      error: "bad_request",
      message: "name and slug are required",
    });
  const result = await getCorPgPool().query(
    `INSERT INTO organization (id, name, slug, logo, metadata, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         RETURNING id, name, slug, logo, metadata, "createdAt", "updatedAt"`,
    [crypto.randomUUID(), name, slug, body.logo ?? null, body.metadata ?? null],
  );
  return betterAuthResult(200, normalizeCorOrganization(result.rows[0]));
}

async function updateCorBetterAuthOrganization(body = {}) {
  const organizationId = getOptionalString(body.organizationId);
  const data = body.data && typeof body.data === "object" ? body.data : {};
  if (!organizationId || Object.keys(data).length === 0)
    return betterAuthResult(400, {
      error: "bad_request",
      message: "organizationId and data are required",
    });
  const allowed = new Map([
    ["name", "name"],
    ["slug", "slug"],
    ["logo", "logo"],
    ["metadata", "metadata"],
  ]);
  const sets = ['"updatedAt" = NOW()'];
  const values = [];
  for (const [key, column] of allowed.entries()) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      values.push(data[key]);
      sets.push(`"${column}" = $${values.length}`);
    }
  }
  values.push(organizationId);
  const result = await getCorPgPool().query(
    `UPDATE organization SET ${sets.join(", ")} WHERE id = $${values.length}
         RETURNING id, name, slug, logo, metadata, "createdAt", "updatedAt"`,
    values,
  );
  if (!result.rows[0])
    return betterAuthResult(404, {
      error: "organization_not_found",
      message: "Organization not found",
    });
  return betterAuthResult(200, normalizeCorOrganization(result.rows[0]));
}

async function deleteCorBetterAuthOrganization(body = {}) {
  const organizationId = getOptionalString(body.organizationId);
  if (!organizationId)
    return betterAuthResult(400, {
      error: "bad_request",
      message: "organizationId is required",
    });
  await getCorPgPool().query("DELETE FROM organization WHERE id = $1", [
    organizationId,
  ]);
  return betterAuthResult(200, { success: true, id: organizationId });
}

async function listCorBetterAuthMembers(query = {}) {
  const organizationId = getOptionalString(query.organizationId);
  if (!organizationId)
    return betterAuthResult(400, {
      error: "bad_request",
      message: "organizationId is required",
    });
  const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 1000);
  const result = await getCorPgPool().query(
    `SELECT m.id, m."organizationId", m."userId", m.role, m."createdAt",
                u.id AS user_id, u.name AS user_name, u.email AS user_email, u.image AS user_image
         FROM member m
         LEFT JOIN "user" u ON u.id = m."userId"
         WHERE m."organizationId" = $1
         ORDER BY m."createdAt" ASC
         LIMIT $2`,
    [organizationId, limit],
  );
  const totalResult = await getCorPgPool().query(
    'SELECT COUNT(*)::int AS total FROM member WHERE "organizationId" = $1',
    [organizationId],
  );
  return betterAuthResult(200, {
    members: result.rows.map(normalizeCorMember),
    total: totalResult.rows[0]?.total ?? 0,
  });
}

async function addCorBetterAuthMember(body = {}) {
  const organizationId = getOptionalString(body.organizationId);
  const userId = getOptionalString(body.userId);
  if (!organizationId || !userId)
    return betterAuthResult(400, {
      error: "bad_request",
      message: "organizationId and userId are required",
    });
  const result = await getCorPgPool().query(
    `INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT ("organizationId", "userId") DO UPDATE SET role = EXCLUDED.role
         RETURNING id, "organizationId", "userId", role, "createdAt"`,
    [
      crypto.randomUUID(),
      organizationId,
      userId,
      getOptionalString(body.role) ?? "member",
    ],
  );
  return betterAuthResult(200, normalizeCorMember(result.rows[0]));
}

async function updateCorBetterAuthMemberRole(body = {}) {
  const memberId = getOptionalString(body.memberId);
  if (!memberId)
    return betterAuthResult(400, {
      error: "bad_request",
      message: "memberId is required",
    });
  const result = await getCorPgPool().query(
    'UPDATE member SET role = $2 WHERE id = $1 RETURNING id, "organizationId", "userId", role, "createdAt"',
    [memberId, getOptionalString(body.role) ?? "member"],
  );
  if (!result.rows[0])
    return betterAuthResult(404, {
      error: "member_not_found",
      message: "Member not found",
    });
  return betterAuthResult(200, normalizeCorMember(result.rows[0]));
}

async function removeCorBetterAuthMember(body = {}) {
  const memberId = getOptionalString(body.memberIdOrEmail);
  if (!memberId)
    return betterAuthResult(400, {
      error: "bad_request",
      message: "memberIdOrEmail is required",
    });
  const result = await getCorPgPool().query(
    'DELETE FROM member WHERE id = $1 RETURNING id, "organizationId", "userId", role, "createdAt"',
    [memberId],
  );
  if (!result.rows[0])
    return betterAuthResult(404, {
      error: "member_not_found",
      message: "Member not found",
    });
  return betterAuthResult(200, { member: normalizeCorMember(result.rows[0]) });
}

async function requestBetterAuthInternal(pathname, query, options = {}) {
  try {
    if (pathname === "/admin/list-users" && (options.method ?? "GET") === "GET")
      return await listCorBetterAuthUsers(query);
    if (pathname === "/admin/create-user")
      return await createCorBetterAuthUser(options.body);
    if (pathname === "/admin/update-user")
      return await updateCorBetterAuthUser(options.body);
    if (pathname === "/admin/remove-user")
      return await removeCorBetterAuthUser(options.body);
    if (pathname === "/admin/ban-user")
      return await banCorBetterAuthUser(options.body);
    if (pathname === "/admin/unban-user")
      return await unbanCorBetterAuthUser(options.body);
    if (
      pathname === "/organization/list" &&
      (options.method ?? "GET") === "GET"
    )
      return await listCorBetterAuthOrganizations();
    if (
      pathname === "/organization/list-members" &&
      (options.method ?? "GET") === "GET"
    )
      return await listCorBetterAuthMembers(query);
    if (pathname === "/organization/create")
      return await createCorBetterAuthOrganization(options.body);
    if (pathname === "/organization/update")
      return await updateCorBetterAuthOrganization(options.body);
    if (pathname === "/organization/delete")
      return await deleteCorBetterAuthOrganization(options.body);
    if (pathname === "/organization/add-member")
      return await addCorBetterAuthMember(options.body);
    if (pathname === "/organization/update-member-role")
      return await updateCorBetterAuthMemberRole(options.body);
    if (pathname === "/organization/remove-member")
      return await removeCorBetterAuthMember(options.body);
  } catch (error) {
    if (error instanceof BetterAuthDatabaseConfigError) {
      return betterAuthResult(503, {
        error: "better_auth_db_unavailable",
        message: error.message,
      });
    }
    throw error;
  }

  const baseUrl = appConfig.betterAuthApiUrl;
  const url = new URL(`${baseUrl}${pathname}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  const method = options.method ?? "GET";
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    origin: new URL(baseUrl).origin,
  };
  const res = await fetch(url, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }
  return { ok: res.ok, status: res.status, data };
}

function getBetterAuthUserPayload(data) {
  if (!data || typeof data !== "object") return null;
  return data.user ?? data;
}

function getBetterAuthOrganizationsPayload(data) {
  return Array.isArray(data) ? data : (data?.organizations ?? []);
}

function getBetterAuthMembersPayload(data) {
  return data?.members ?? [];
}

function makeRelayUserEmail(user) {
  const source =
    String(user.id || user.name || "relay-user")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "relay-user";
  return `${source}@relay-user.ccdash.internal`;
}

function resolveRelayUserForBetterAuthUser(
  user,
  relayByEmail,
  relayByExternalId,
) {
  const id = String(user.id ?? "");
  if (id) {
    const byExternalId = relayByExternalId.get(id);
    if (byExternalId) return byExternalId;
  }
  const email = String(user.email ?? "").toLowerCase();
  const direct = relayByEmail.get(email);
  if (direct) return direct;
  return null;
}

async function ensureRelayUserForBetterAuthUser(
  services,
  user,
  organizations = [],
) {
  if (!services.userStore || !user?.id) {
    return null;
  }
  const orgId = resolveRelayOrgIdFromBetterAuthOrganization(organizations[0]);
  const result = await services.userStore.findOrCreateByExternalId({
    externalUserId: String(user.id),
    name: user.name || user.email || String(user.id),
    orgId,
  });
  return result.user;
}

function isSyntheticRelayBetterAuthUser(user) {
  return String(user.email ?? "")
    .toLowerCase()
    .endsWith("@relay-user.ccdash.internal");
}

function makeOrgSlug(orgId) {
  return (
    String(orgId || "default")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "default"
  );
}

async function listBetterAuthOrganizationsInternal() {
  const result = await requestBetterAuthInternal("/organization/list", {});
  return getBetterAuthOrganizationsPayload(
    unwrapBetterAuthResult(
      result,
      `Better Auth list organizations failed: HTTP ${result.status}`,
    ),
  );
}

function resolveRelayOrgIdFromBetterAuthOrganization(organization) {
  return (
    organization?.metadata?.relayOrgId ??
    organization?.slug ??
    organization?.name ??
    null
  );
}

async function findBetterAuthUserForRelayUser(relayUser) {
  if (!relayUser) {
    return null;
  }
  const existingUsersResult = await requestBetterAuthInternal(
    "/admin/list-users",
    { limit: 1000 },
  );
  const existingUsersData = unwrapBetterAuthResult(
    existingUsersResult,
    `Better Auth list users failed: HTTP ${existingUsersResult.status}`,
  );
  const existingUsers = existingUsersData?.users ?? [];
  const externalUserId = relayUser.externalUserId
    ? String(relayUser.externalUserId)
    : null;
  if (externalUserId) {
    const byExternalId = existingUsers.find(
      (user) => String(user.id ?? "") === externalUserId,
    );
    if (byExternalId) {
      return byExternalId;
    }
  }
  const email = makeRelayUserEmail(relayUser).toLowerCase();
  return (
    existingUsers.find(
      (user) => String(user.email ?? "").toLowerCase() === email,
    ) ?? null
  );
}

async function syncBetterAuthUserToRelayUser(
  services,
  betterUser,
  organizations = [],
) {
  const relayUser = await ensureRelayUserForBetterAuthUser(
    services,
    betterUser,
    organizations,
  );
  if (!relayUser || !services.userStore) {
    return null;
  }
  const updates = {};
  if (betterUser?.name && betterUser.name !== relayUser.name) {
    updates.name = betterUser.name;
  }
  if (
    betterUser?.banned !== undefined &&
    Boolean(betterUser.banned) === relayUser.isActive
  ) {
    updates.isActive = !Boolean(betterUser.banned);
  }
  if (organizations.length > 0) {
    const nextOrgId = resolveRelayOrgIdFromBetterAuthOrganization(
      organizations[0],
    );
    if (nextOrgId !== relayUser.orgId) {
      updates.orgId = nextOrgId;
    }
  }
  if (Object.keys(updates).length === 0) {
    return relayUser;
  }
  return services.userStore.updateUser(relayUser.id, updates);
}

async function deleteRelayUserForBetterAuthUser(services, betterAuthUserId) {
  if (!services.userStore || !betterAuthUserId) {
    return false;
  }
  const relayUser = await services.userStore.getUserByExternalId(
    String(betterAuthUserId),
  );
  if (!relayUser) {
    return false;
  }
  return services.userStore.deleteUser(relayUser.id);
}

async function syncBetterAuthOrganizationToRelayUsers(
  services,
  organization,
  previousRelayOrgId = null,
) {
  if (!services.userStore || !organization) {
    return 0;
  }
  const nextRelayOrgId =
    resolveRelayOrgIdFromBetterAuthOrganization(organization);
  const oldRelayOrgId =
    previousRelayOrgId ??
    organization.metadata?.relayOrgId ??
    organization.slug ??
    organization.name;
  if (!oldRelayOrgId || oldRelayOrgId === nextRelayOrgId) {
    return 0;
  }
  return services.userStore.updateUsersOrg(oldRelayOrgId, nextRelayOrgId);
}

async function clearRelayOrganizationFromUsers(services, organization) {
  if (!services.userStore || !organization) {
    return 0;
  }
  const relayOrgId = resolveRelayOrgIdFromBetterAuthOrganization(organization);
  if (!relayOrgId) {
    return 0;
  }
  return services.userStore.updateUsersOrg(relayOrgId, null);
}

function describeBestEffortSideEffectError(error) {
  if (error instanceof BetterAuthRequestError) {
    const code =
      error.responseBody && typeof error.responseBody === "object"
        ? (getOptionalString(error.responseBody.error) ??
          getOptionalString(error.responseBody.message))
        : null;
    return code
      ? `HTTP ${error.statusCode} (${code})`
      : `HTTP ${error.statusCode}`;
  }
  return sanitizeErrorMessage(error);
}

function buildFollowupWarning(operationName, error) {
  return {
    code: "followup_operation_failed",
    operation: operationName,
    message: describeBestEffortSideEffectError(error),
  };
}

function appendWarningsToResponseBody(data, warnings) {
  if (!warnings.length) {
    return data;
  }
  const extra = {
    partial: true,
    warnings,
  };
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return {
      ...data,
      ...extra,
    };
  }
  return {
    data,
    ...extra,
  };
}

async function captureFollowupResult(
  operationName,
  handler,
  fallbackValue = null,
) {
  try {
    return {
      value: await handler(),
      warning: null,
    };
  } catch (error) {
    const warning = buildFollowupWarning(operationName, error);
    console.warn(`[follow-up] ${operationName} failed: ${warning.message}`);
    return {
      value: fallbackValue,
      warning,
    };
  }
}

async function runBestEffortSideEffect(
  operationName,
  handler,
  fallbackValue = null,
) {
  try {
    return await handler();
  } catch (error) {
    console.warn(
      `[best-effort] ${operationName} failed: ${describeBestEffortSideEffectError(error)}`,
    );
    return fallbackValue;
  }
}

function normalizeBetterAuthUser(user, relayUser, organizations) {
  return {
    id: user.id,
    email: user.email ?? "",
    name: user.name ?? relayUser?.name ?? "",
    emailVerified: Boolean(user.emailVerified),
    image: user.image ?? null,
    role: user.role ?? "user",
    banned: Boolean(user.banned),
    banReason: user.banReason ?? null,
    createdAt: user.createdAt ?? null,
    updatedAt: user.updatedAt ?? null,
    relay: relayUser ? sanitizeUser(relayUser) : null,
    organizations,
  };
}

async function buildBetterAuthUsersOverview(services) {
  const listUsersResult = await requestBetterAuthInternal("/admin/list-users", {
    limit: 1000,
  });
  const listOrganizationsResult = await requestBetterAuthInternal(
    "/organization/list",
    {},
  );
  const listUsersData = unwrapBetterAuthResult(
    listUsersResult,
    `Better Auth list users failed: HTTP ${listUsersResult.status}`,
  );
  const listOrganizationsData = unwrapBetterAuthResult(
    listOrganizationsResult,
    `Better Auth list organizations failed: HTTP ${listOrganizationsResult.status}`,
  );
  const betterUsers = listUsersData?.users ?? [];
  const relayUsers = services.userStore
    ? await services.userStore.listUsersWithUsage()
    : [];
  const relayByEmail = new Map(
    relayUsers.map((user) => [makeRelayUserEmail(user).toLowerCase(), user]),
  );
  const relayByExternalId = new Map(
    relayUsers
      .filter((user) => user.externalUserId)
      .map((user) => [String(user.externalUserId), user]),
  );
  const organizations = getBetterAuthOrganizationsPayload(
    listOrganizationsData,
  );
  const orgRows = [];
  const membershipsByUserId = new Map();
  for (const organization of organizations) {
    const membersResult = await requestBetterAuthInternal(
      "/organization/list-members",
      { organizationId: organization.id, limit: 1000 },
    );
    const members = membersResult.ok
      ? getBetterAuthMembersPayload(membersResult.data)
      : [];
    const relayOrgId =
      resolveRelayOrgIdFromBetterAuthOrganization(organization);
    for (const member of members) {
      const list = membershipsByUserId.get(member.userId) ?? [];
      list.push({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        relayOrgId,
        metadata: organization.metadata ?? null,
        role: member.role,
        memberId: member.id,
      });
      membershipsByUserId.set(member.userId, list);
    }
    orgRows.push({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      logo: organization.logo ?? null,
      metadata: organization.metadata ?? null,
      createdAt: organization.createdAt ?? null,
      updatedAt: organization.updatedAt ?? null,
      memberCount: members.length,
      relayOrgId,
    });
  }
  const filteredBetterUsers = betterUsers.filter((user) => {
    if (!isSyntheticRelayBetterAuthUser(user)) return true;
    const userId = String(user.id ?? "");
    if (userId && relayByExternalId.has(userId)) return true;
    const relayUser =
      relayByEmail.get(String(user.email ?? "").toLowerCase()) ?? null;
    if (!relayUser) return false;
    if (!relayUser?.externalUserId) return true;
    return String(relayUser.externalUserId) === userId;
  });
  const users = [];
  for (const user of filteredBetterUsers) {
    const memberships = membershipsByUserId.get(user.id) ?? [];
    const relayUser =
      resolveRelayUserForBetterAuthUser(
        user,
        relayByEmail,
        relayByExternalId,
      ) ??
      (await runBestEffortSideEffect(
        `backfill relay user while building Better Auth overview ${user.id}`,
        async () =>
          ensureRelayUserForBetterAuthUser(services, user, memberships),
        null,
      ));
    users.push(normalizeBetterAuthUser(user, relayUser, memberships));
  }
  return {
    ok: true,
    users,
    organizations: orgRows,
  };
}

function asyncRoute(handler) {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}
function getOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function getOptionalBillingCurrency(value, field = "currency") {
  if (value === undefined) {
    return undefined;
  }
  return normalizeBillingCurrency(value, { field });
}
function getOptionalRelayKeySource(value) {
  if (value === undefined) {
    return undefined;
  }
  const normalized = getOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  if (normalized === "relay_api_keys" || normalized === "relay_users_legacy") {
    return normalized;
  }
  throw new InputValidationError(
    "relayKeySource must be one of: relay_api_keys, relay_users_legacy",
  );
}
function hasOwnProperty(value, key) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, key)
  );
}
function getNullableStringField(body, key) {
  if (!hasOwnProperty(body, key)) {
    return undefined;
  }
  const value = body[key];
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  throw new InputValidationError(`${key} must be a string`);
}
function getFirstDefinedNullableString(body, keys) {
  for (const key of keys) {
    const value = getNullableStringField(body, key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}
function getRouteParam(value) {
  return Array.isArray(value) ? (value[0] ?? "") : value;
}

const CHANNEL_STATUS_CACHE_TTL_MS = 5 * 60_000;
let channelStatusCache: { payload: any; expiresAt: number } | null = null;
function readChannelStatusCache() {
  if (channelStatusCache && channelStatusCache.expiresAt > Date.now()) {
    return channelStatusCache.payload;
  }
  return null;
}
function writeChannelStatusCache(payload) {
  channelStatusCache = {
    payload,
    expiresAt: Date.now() + CHANNEL_STATUS_CACHE_TTL_MS,
  };
}
function clearChannelStatusCache() {
  channelStatusCache = null;
}
function deriveOverallStatus(window1h, accountSummary) {
  if (accountSummary.total === 0) {
    return "no_data";
  }
  const liveAccounts = accountSummary.enabled;
  if (liveAccounts === 0) {
    return "down";
  }
  if (window1h.totalRequests < 5) {
    return liveAccounts > 0 ? "operational" : "no_data";
  }
  const rate = window1h.successRate ?? 1;
  if (rate >= 0.95) return "operational";
  if (rate >= 0.8) return "degraded";
  return "down";
}
function parseIncomingTierMap(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new InputValidationError("modelTierMap must be an object");
  }
  const result = { opus: null, sonnet: null, haiku: null };
  for (const tier of ["opus", "sonnet", "haiku"]) {
    if (!hasOwnProperty(value, tier)) {
      continue;
    }
    const raw = value[tier];
    if (raw == null) {
      result[tier] = null;
      continue;
    }
    if (typeof raw !== "string") {
      throw new InputValidationError(`modelTierMap.${tier} must be a string`);
    }
    const trimmed = raw.trim();
    result[tier] = trimmed || null;
  }
  return result;
}
const MODEL_MAP_MAX_ENTRIES = 64;
function parseIncomingModelMap(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new InputValidationError("modelMap must be an object");
  }
  const keys = Object.keys(value);
  if (keys.length > MODEL_MAP_MAX_ENTRIES) {
    throw new InputValidationError(
      `modelMap must have at most ${MODEL_MAP_MAX_ENTRIES} entries`,
    );
  }
  const result = {};
  for (const rawKey of keys) {
    const key = typeof rawKey === "string" ? rawKey.trim() : "";
    if (!key) {
      continue;
    }
    const raw = value[rawKey];
    if (raw == null || raw === "") {
      continue;
    }
    if (typeof raw !== "string") {
      throw new InputValidationError(`modelMap.${rawKey} must be a string`);
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    result[key] = trimmed;
  }
  return Object.keys(result).length > 0 ? result : null;
}
function getRequestOrigin(req) {
  const forwardedProto = req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || req.header("host")?.trim();
  if (!host) {
    return null;
  }
  return `${forwardedProto || req.protocol}://${host}`;
}
function isAllowedUiOrigin(req, origin) {
  const normalized = origin.trim();
  if (!normalized) {
    return false;
  }
  const requestOrigin = getRequestOrigin(req);
  if (requestOrigin && normalized === requestOrigin) {
    return true;
  }
  return appConfig.adminUiAllowedOrigins.includes(normalized);
}
function requestAcceptsHtml(req) {
  const accept = req.header("accept") ?? "";
  return accept.includes("text/html") || accept.includes("*/*");
}
function isStaticAssetRequest(requestPath) {
  const extension = path.extname(requestPath);
  return extension
    ? STATIC_ASSET_EXTENSIONS.has(extension.toLowerCase())
    : false;
}
function shouldServeAdminUi(req) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return false;
  }
  if (!requestAcceptsHtml(req)) {
    return false;
  }
  if (isStaticAssetRequest(req.path)) {
    return false;
  }
  // Only serve known SPA entry routes. Other unknown paths fall through to 404
  // so misrouted relay traffic does not silently get HTML back.
  const adminUiRoutes = [
    "/",
    "/dashboard",
    "/accounts",
    "/routing",
    "/usage",
    "/risk",
    "/billing",
    "/models",
    "/users",
    "/network",
    "/support",
    "/login",
    "/auth",
    "/admin",
  ];
  if (!adminUiRoutes.some((route) => req.path === route || req.path.startsWith(`${route}/`))) {
    return false;
  }
  return fs.existsSync(ADMIN_UI_INDEX_PATH);
}
function renderAdminUiIndex(req) {
  const indexHtml = readAdminUiIndex();
  const runtimeConfig = JSON.stringify({
    apiBaseUrl: getRequestOrigin(req) ?? "",
    keycloakUrl: appConfig.adminUiKeycloakUrl,
    keycloakRealm: appConfig.adminUiKeycloakRealm,
    keycloakClientId: appConfig.adminUiKeycloakClientId,
  }).replace(/</g, "\\u003c");
  return indexHtml.replace(
    "</head>",
    `  <script>window.__CCDASH_RUNTIME__=${runtimeConfig};</script>\n</head>`,
  );
}
function applyCorsHeaders(req, res, methods) {
  const origin = req.header("origin");
  if (!origin) {
    return true;
  }
  res.append("Vary", "Origin");
  if (!isAllowedUiOrigin(req, origin)) {
    return false;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Admin-CSRF",
  );
  res.setHeader("Access-Control-Max-Age", "86400");
  return true;
}
function maskApiKey(apiKey) {
  if (!apiKey) {
    return "";
  }
  if (apiKey.length <= 18) {
    return apiKey;
  }
  return `${apiKey.slice(0, 10)}...${apiKey.slice(-6)}`;
}
function parseIsoTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
function pickEarliestTimestamp(...values) {
  const timestamps = values
    .map((value) => parseIsoTimestamp(value))
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  if (timestamps.length === 0) {
    return null;
  }
  return Math.min(...timestamps);
}
function sanitizeUser(user) {
  const { apiKey, ...rest } = user;
  return {
    ...rest,
    apiKeyPreview: maskApiKey(apiKey),
  };
}
function normalizeApiKeyGroupAssignments(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const assignments = {
    anthropic: getNullableStringField(source, "anthropic"),
    openai: getNullableStringField(source, "openai"),
    google: getNullableStringField(source, "google"),
  };
  if (!assignments.anthropic && !assignments.openai && !assignments.google) {
    throw new InputValidationError(
      "At least one API key routing group is required",
    );
  }
  return assignments;
}
async function validateApiKeyGroupAssignments(services, assignments) {
  const groups = await services.oauthService.listRoutingGroups();
  const byId = new Map(groups.map((group) => [group.id, group]));
  for (const type of ["anthropic", "openai", "google"]) {
    const groupId = assignments[type];
    if (!groupId) continue;
    const group = byId.get(groupId);
    if (!group) {
      throw new InputValidationError(`Routing group not found: ${groupId}`);
    }
    if (group.type !== type) {
      throw new InputValidationError(
        `Routing group ${groupId} type must be ${type}`,
      );
    }
    if (!group.isActive) {
      throw new InputValidationError(`Routing group is disabled: ${groupId}`);
    }
  }
}
async function buildUserApiKeyReadResponse(services, user) {
  const activeApiKeys = services.apiKeyStore
    ? await services.apiKeyStore.listForUser(user.id)
    : [];
  const primaryApiKey = activeApiKeys[0] ?? null;
  const legacyApiKey =
    typeof user.apiKey === "string" && user.apiKey.trim() ? user.apiKey : null;
  const apiKeySource = primaryApiKey ? "relay_api_keys" : "relay_users_legacy";
  return {
    userId: user.id,
    apiKeySource,
    primaryApiKey,
    activeApiKeyCount: activeApiKeys.length,
    currentApiKeyPlaintextAvailable: !primaryApiKey && Boolean(legacyApiKey),
    apiKey: legacyApiKey,
    apiKeyFieldMode: primaryApiKey
      ? "compatibility_legacy_plaintext"
      : legacyApiKey
        ? "legacy_primary_plaintext"
        : "absent",
    legacyApiKey,
    legacyApiKeySource: legacyApiKey ? "relay_users_legacy" : null,
    legacyApiKeyRetained: Boolean(legacyApiKey),
    legacyApiKeyDeprecated: Boolean(primaryApiKey && legacyApiKey),
  };
}
function sanitizeAccount(account) {
  const { accessToken, refreshToken, loginPassword, rawProfile, ...rest } =
    account;
  return {
    ...rest,
    hasAccessToken: Boolean(accessToken),
    hasRefreshToken: Boolean(refreshToken),
    hasLoginPassword: Boolean(loginPassword),
  };
}
function sanitizeAccounts(accounts) {
  return accounts.map(sanitizeAccount);
}

function attachAccountRiskLabels(scores, accounts) {
  const accountMap = new Map(accounts.map((account) => [account.id, account]));
  return scores.map((score) => {
    const account = accountMap.get(score.accountId);
    return {
      ...score,
      label: account?.label ?? account?.displayName ?? account?.emailAddress ?? null,
      emailAddress: account?.emailAddress ?? null,
    };
  });
}


function getWarmupPolicyId(value) {
  return value === "b" || value === "c" || value === "d" || value === "e" ? value : value === "a" ? "a" : undefined;
}
function getOptionalBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return undefined;
}
function jsonResult(status, body) {
  return { status, body };
}
function readSingleHeader(req, name) {
  const value = req?.headers?.[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}
async function runWithOnboardingFromHeaders(services, req, defaultSource, fn) {
  const ingressIp = readSingleHeader(req, "x-ingress-ip") ?? readSingleHeader(req, "x-ingress-real-ip");
  const ingressUserAgent = readSingleHeader(req, "x-ingress-user-agent");
  const ingressForwardedFor = readSingleHeader(req, "x-ingress-forwarded-for");
  const source = readSingleHeader(req, "x-ingress-source") ?? defaultSource;
  const oauthService = services?.oauthService;
  if (!oauthService || typeof oauthService.runWithOnboardingContext !== "function") {
    return await fn();
  }
  return await oauthService.runWithOnboardingContext(
    {
      ingressIp,
      ingressUserAgent,
      ingressForwardedFor,
      source,
    },
    fn,
  );
}
function buildIngressHeaders(req) {
  if (!req) return {};
  const ipHeader =
    typeof req.ip === "string"
      ? req.ip
      : Array.isArray(req.ips) && req.ips.length > 0
        ? req.ips[0]
        : null;
  const ua = req.headers?.["user-agent"];
  const xff = req.headers?.["x-forwarded-for"];
  const realIp = req.headers?.["x-real-ip"];
  const headers = {};
  if (ipHeader) headers["x-ingress-ip"] = String(ipHeader).slice(0, 256);
  if (ua) headers["x-ingress-user-agent"] = String(ua).slice(0, 1024);
  const forwardedRaw = Array.isArray(xff) ? xff.join(",") : xff;
  if (forwardedRaw) headers["x-ingress-forwarded-for"] = String(forwardedRaw).slice(0, 1024);
  if (realIp) headers["x-ingress-real-ip"] = String(realIp).slice(0, 256);
  headers["x-ingress-source"] = "admin-ui";
  return headers;
}
async function respondWithRelayControl(res, relayControlClient, input, req) {
  const headers = { ...(input.headers ?? {}), ...buildIngressHeaders(req) };
  const result = await requestRelayControlResult(relayControlClient, {
    ...input,
    headers,
  });
  res.status(result.status).json(result.data);
}
async function requestRelayControlResult(relayControlClient, input) {
  try {
    return await relayControlClient.request(input);
  } catch (error) {
    const message =
      error instanceof RelayControlConfigError
        ? error.message
        : `Relay control request failed: ${sanitizeErrorMessage(error)}`;
    return {
      status: 503,
      data: {
        error: "relay_control_unavailable",
        message,
      },
    };
  }
}
async function clearStickySessionsControl(services) {
  await services.oauthService.clearStickySessions();
  return jsonResult(200, { ok: true });
}
async function clearStoredAccountsControl(services) {
  await services.oauthService.clearStoredAccounts();
  return jsonResult(200, { ok: true });
}
async function deleteAccountControl(services, accountId) {
  const deleted = await services.oauthService.deleteAccount(accountId);
  if (!deleted) {
    return jsonResult(404, {
      error: "account_not_found",
      message: `账号不存在: ${accountId}`,
    });
  }
  return jsonResult(200, {
    ok: true,
    account: sanitizeAccount(deleted),
  });
}
async function createAccountControl(services, body) {
  const provider = getOptionalString(body?.provider) ?? "claude-official";
  const routingGroupId = getFirstDefinedNullableString(body, [
    "routingGroupId",
    "group",
  ]);
  if (provider === "openai-compatible") {
    const apiKey = String(body?.apiKey ?? "").trim();
    const apiBaseUrl = String(body?.apiBaseUrl ?? "").trim();
    const modelName = String(body?.modelName ?? "").trim();
    if (!apiKey) {
      return jsonResult(400, {
        error: "missing_api_key",
        message: "apiKey is required",
      });
    }
    if (!apiBaseUrl) {
      return jsonResult(400, {
        error: "missing_api_base_url",
        message: "apiBaseUrl is required",
      });
    }
    const account = await services.oauthService.createOpenAICompatibleAccount({
      apiKey,
      apiBaseUrl,
      modelName: modelName || null,
      modelMap: parseIncomingModelMap(body?.modelMap) ?? null,
      label: getOptionalString(body?.label),
      proxyUrl: getOptionalString(body?.proxyUrl) ?? null,
      routingGroupId,
    });
    return jsonResult(200, { ok: true, account: sanitizeAccount(account) });
  }
  if (provider === "claude-compatible") {
    const apiKey = String(body?.apiKey ?? "").trim();
    const apiBaseUrl = String(body?.apiBaseUrl ?? "").trim();
    const modelName = String(body?.modelName ?? "").trim();
    if (!apiKey) {
      return jsonResult(400, {
        error: "missing_api_key",
        message: "apiKey is required",
      });
    }
    if (!apiBaseUrl) {
      return jsonResult(400, {
        error: "missing_api_base_url",
        message: "apiBaseUrl is required",
      });
    }
    if (!modelName) {
      return jsonResult(400, {
        error: "missing_model_name",
        message: "modelName is required",
      });
    }
    const account = await services.oauthService.createClaudeCompatibleAccount({
      apiKey,
      apiBaseUrl,
      modelName,
      modelTierMap: parseIncomingTierMap(body?.modelTierMap),
      label: getOptionalString(body?.label),
      proxyUrl: getOptionalString(body?.proxyUrl) ?? null,
      routingGroupId,
    });
    return jsonResult(200, { ok: true, account: sanitizeAccount(account) });
  }
  if (provider !== "claude-official") {
    return jsonResult(400, {
      error: "unsupported_provider",
      message: `Unsupported provider: ${provider}`,
    });
  }
  const email = String(body?.email ?? "").trim();
  if (!email) {
    return jsonResult(400, {
      error: "missing_email",
      message: "email is required",
    });
  }
  const account = await services.oauthService.createSimpleAccount({
    email,
    password: getOptionalString(body?.password),
    label: getOptionalString(body?.label),
    routingGroupId,
  });
  return jsonResult(200, { ok: true, account: sanitizeAccount(account) });
}
async function createRoutingGroupControl(services, body) {
  const id = String(body?.id ?? "").trim();
  if (!id) {
    return jsonResult(400, {
      error: "missing_routing_group_id",
      message: "id is required",
    });
  }
  const routingGroup = await services.oauthService.createRoutingGroup({
    id,
    name: getNullableStringField(body, "name"),
    type: getNullableStringField(body, "type"),
    description: getNullableStringField(body, "description"),
    descriptionZh: getNullableStringField(body, "descriptionZh"),
    isActive: typeof body?.isActive === "boolean" ? body.isActive : undefined,
  });
  clearChannelStatusCache();
  return jsonResult(200, { ok: true, routingGroup });
}
async function updateRoutingGroupControl(services, groupId, body) {
  const newId = getOptionalString(body?.id);
  let routingGroup = null;
  if (newId && newId !== groupId) {
    routingGroup = await services.oauthService.renameRoutingGroup(
      groupId,
      newId,
    );
    if (!routingGroup) {
      return jsonResult(404, {
        error: "routing_group_not_found",
        message: `路由组不存在: ${groupId}`,
      });
    }
    await services.userStore?.renameRoutingGroup?.(groupId, newId);
    await services.apiKeyStore?.renameGroup?.(groupId, newId);
  }
  const targetGroupId = routingGroup?.id ?? groupId;
  routingGroup = await services.oauthService.updateRoutingGroup(targetGroupId, {
    name: getNullableStringField(body, "name"),
    type: getNullableStringField(body, "type"),
    description: getNullableStringField(body, "description"),
    descriptionZh: getNullableStringField(body, "descriptionZh"),
    isActive: typeof body?.isActive === "boolean" ? body.isActive : undefined,
  });
  if (!routingGroup) {
    return jsonResult(404, {
      error: "routing_group_not_found",
      message: `路由组不存在: ${groupId}`,
    });
  }
  clearChannelStatusCache();
  return jsonResult(200, { ok: true, routingGroup });
}
async function deleteRoutingGroupControl(services, groupId) {
  const existing = await services.oauthService.getRoutingGroup(groupId);
  if (!existing) {
    return jsonResult(404, {
      error: "routing_group_not_found",
      message: `路由组不存在: ${groupId}`,
    });
  }
  const linkedAccounts = (await services.oauthService.listAccounts()).filter(
    (account) => (account.routingGroupId ?? account.group) === groupId,
  );
  if (linkedAccounts.length > 0) {
    return jsonResult(409, {
      error: "routing_group_in_use",
      message: `路由组仍被 ${linkedAccounts.length} 个账号引用，无法删除`,
    });
  }
  const linkedUsers = services.userStore
    ? (await services.userStore.listUsers()).filter(
        (user) => (user.routingGroupId ?? user.preferredGroup) === groupId,
      )
    : [];
  if (linkedUsers.length > 0) {
    return jsonResult(409, {
      error: "routing_group_in_use",
      message: `路由组仍被 ${linkedUsers.length} 个用户引用，无法删除`,
    });
  }
  const deleted = await services.oauthService.deleteRoutingGroup(groupId);
  clearChannelStatusCache();
  return jsonResult(200, { ok: true, routingGroup: deleted });
}
async function generateAuthUrlControl(services, body) {
  const provider = getOptionalString(body?.provider) ?? "claude-official";
  if (provider !== "claude-official" && provider !== "openai-codex") {
    return jsonResult(400, {
      error: "unsupported_provider",
      message: `Unsupported provider: ${provider}`,
    });
  }
  const expiresIn =
    typeof body?.expiresIn === "number" && Number.isFinite(body.expiresIn)
      ? body.expiresIn
      : undefined;
  const session = services.oauthService.createAuthSession({
    provider,
    expiresIn,
  });
  const instructions =
    provider === "openai-codex"
      ? [
          "1. 打开 authUrl，用 ChatGPT 账号完成 Codex 登录。",
          "2. 完成后浏览器会跳到 localhost 回调地址；即使页面打不开，也可以直接复制地址栏里的完整回调 URL。",
          "3. 把完整回调 URL 或其中的 code 粘贴到 /admin/oauth/exchange-code 完成落盘。",
        ]
      : [
          "1. 打开 authUrl 登录 Claude.ai。",
          "2. 完成后复制浏览器最终回调 URL，或只复制 code。",
          "3. 调用 /admin/oauth/exchange-code 完成 token 落盘。",
        ];
  return jsonResult(200, {
    ok: true,
    session,
    instructions,
  });
}
async function exchangeCodeControl(services, body) {
  const sessionId = String(body?.sessionId ?? "");
  const authorizationInput = String(body?.authorizationInput ?? "");
  const label = getOptionalString(body?.label);
  const accountId = getOptionalString(body?.accountId);
  const account = await services.oauthService.exchangeCode({
    sessionId,
    authorizationInput,
    label,
    accountId,
    modelName: getOptionalString(body?.modelName) ?? null,
    proxyUrl: getOptionalString(body?.proxyUrl) ?? null,
    apiBaseUrl: getOptionalString(body?.apiBaseUrl) ?? null,
    routingGroupId: getFirstDefinedNullableString(body, [
      "routingGroupId",
      "group",
    ]),
    warmupEnabled: getOptionalBoolean(body?.warmupEnabled),
    warmupPolicyId: getWarmupPolicyId(body?.warmupPolicyId),
  });
  return jsonResult(200, { ok: true, account: sanitizeAccount(account) });
}
async function loginWithSessionKeyControl(services, body) {
  const sessionKey = String(body?.sessionKey ?? "");
  const label = getOptionalString(body?.label);
  const routingGroupId = getFirstDefinedNullableString(body, [
    "routingGroupId",
    "group",
  ]);
  const account = await services.oauthService.loginWithSessionKey(
    sessionKey,
    label,
    routingGroupId,
    null,
    getOptionalBoolean(body?.warmupEnabled),
    getWarmupPolicyId(body?.warmupPolicyId),
  );
  return jsonResult(200, { ok: true, account: sanitizeAccount(account) });
}
async function importTokensControl(services, body) {
  const accessToken = String(body?.accessToken ?? "").trim();
  const refreshToken = getOptionalString(body?.refreshToken);
  const label = getOptionalString(body?.label);
  if (!accessToken) {
    return jsonResult(400, {
      error: "missing_access_token",
      message: "accessToken is required",
    });
  }
  const account = await services.oauthService.importTokens({
    accessToken,
    refreshToken: refreshToken ?? null,
    label,
    routingGroupId: getFirstDefinedNullableString(body, [
      "routingGroupId",
      "group",
    ]),
    warmupEnabled: getOptionalBoolean(body?.warmupEnabled),
    warmupPolicyId: getWarmupPolicyId(body?.warmupPolicyId),
  });
  return jsonResult(200, { ok: true, account: sanitizeAccount(account) });
}
async function refreshOauthControl(services, body) {
  const accountId = getOptionalString(body?.accountId);
  if (accountId) {
    const account = await services.oauthService.refreshAccount(accountId);
    return jsonResult(200, { ok: true, account: sanitizeAccount(account) });
  }
  const results = await services.oauthService.refreshAllAccounts();
  return jsonResult(200, {
    ok: true,
    results: results.map((result) =>
      result.ok
        ? { ...result, account: sanitizeAccount(result.account) }
        : result,
    ),
  });
}
async function startGeminiLoginControl(services, body) {
  if (!services.geminiLoopback) {
    return jsonResult(503, {
      error: "gemini_loopback_unavailable",
      message: "Gemini loopback OAuth controller is not initialised.",
    });
  }
  const result = await services.geminiLoopback.startLogin({
    label: getOptionalString(body?.label),
    proxyUrl: getOptionalString(body?.proxyUrl),
    modelName: getOptionalString(body?.modelName),
    routingGroupId: getFirstDefinedNullableString(body, [
      "routingGroupId",
      "group",
    ]),
    accountId: getOptionalString(body?.accountId),
  });
  return jsonResult(200, {
    ok: true,
    provider: "google-gemini-oauth",
    session: result,
    instructions: [
      "1. 在浏览器（ncu 本机）打开 authUrl，登录 Google 账号并授权。",
      "2. Google 会跳转到 " +
        result.redirectUri +
        "，即由 cor 进程内部的 loopback server 接住。",
      "3. 然后调用 /admin/oauth/gemini/status?sessionId=" +
        result.sessionId +
        " 查询登录是否完成。",
    ],
  });
}
function getGeminiStatusControl(services, query) {
  if (!services.geminiLoopback) {
    return jsonResult(503, { error: "gemini_loopback_unavailable" });
  }
  const sessionId = getOptionalString(query?.sessionId);
  if (!sessionId) {
    return jsonResult(400, { error: "missing_session_id" });
  }
  const status = services.geminiLoopback.getStatus(sessionId);
  return jsonResult(200, {
    ok: true,
    sessionId: status.sessionId,
    status: status.status,
    account: status.account ? sanitizeAccount(status.account) : null,
    error: status.error ?? null,
  });
}
async function manualGeminiExchangeControl(services, body) {
  if (!services.geminiLoopback) {
    return jsonResult(503, { error: "gemini_loopback_unavailable" });
  }
  const callbackUrl = getOptionalString(body?.callbackUrl) ?? "";
  if (!callbackUrl) {
    return jsonResult(400, {
      error: "missing_callback_url",
      message: "callbackUrl is required",
    });
  }
  const result = await services.geminiLoopback.manualExchange({
    callbackUrl,
    sessionId: getOptionalString(body?.sessionId) ?? undefined,
    label: getOptionalString(body?.label),
    proxyUrl: getOptionalString(body?.proxyUrl),
    modelName: getOptionalString(body?.modelName),
    routingGroupId: getFirstDefinedNullableString(body, [
      "routingGroupId",
      "group",
    ]),
    accountId: getOptionalString(body?.accountId),
  });
  return jsonResult(200, {
    ok: true,
    sessionId: result.sessionId,
    account: sanitizeAccount(result.account),
  });
}
async function updateAccountSettingsControl(services, accountId, body) {
  const settings = {};
  const routingGroupId = getFirstDefinedNullableString(body, [
    "routingGroupId",
    "group",
  ]);
  if (routingGroupId !== undefined) settings.routingGroupId = routingGroupId;
  if (body?.maxSessions !== undefined) settings.maxSessions = body.maxSessions;
  if (body?.weight !== undefined) settings.weight = body.weight;
  if (body?.planType !== undefined) settings.planType = body.planType;
  if (body?.planMultiplier !== undefined)
    settings.planMultiplier = body.planMultiplier;
  if (body?.schedulerEnabled !== undefined)
    settings.schedulerEnabled = Boolean(body.schedulerEnabled);
  if (body?.schedulerState !== undefined)
    settings.schedulerState = String(body.schedulerState);
  if (body?.proxyUrl !== undefined) settings.proxyUrl = body.proxyUrl;
  if (body?.directEgressEnabled !== undefined)
    settings.directEgressEnabled = getOptionalBoolean(body.directEgressEnabled);
  if (body?.bodyTemplatePath !== undefined)
    settings.bodyTemplatePath = body.bodyTemplatePath;
  if (body?.vmFingerprintTemplatePath !== undefined)
    settings.vmFingerprintTemplatePath = body.vmFingerprintTemplatePath;
  if (body?.label !== undefined) settings.label = body.label;
  if (body?.apiBaseUrl !== undefined) settings.apiBaseUrl = body.apiBaseUrl;
  if (body?.modelName !== undefined) settings.modelName = body.modelName;
  if (body?.warmupEnabled !== undefined)
    settings.warmupEnabled = getOptionalBoolean(body.warmupEnabled);
  if (body?.warmupPolicyId !== undefined)
    settings.warmupPolicyId = getWarmupPolicyId(body.warmupPolicyId);
  if (body?.modelTierMap !== undefined)
    settings.modelTierMap = parseIncomingTierMap(body.modelTierMap);
  if (body?.modelMap !== undefined)
    settings.modelMap = parseIncomingModelMap(body.modelMap);
  const account = await services.oauthService.updateAccountSettings(
    accountId,
    settings,
  );
  return jsonResult(200, { ok: true, account: sanitizeAccount(account) });
}
async function refreshAccountControl(services, accountId) {
  const account = await services.oauthService.refreshAccount(accountId);
  return jsonResult(200, { ok: true, account: sanitizeAccount(account) });
}
async function banAccountControl(services, accountId) {
  const account = await services.oauthService.banAccount(accountId);
  return jsonResult(200, { ok: true, account: sanitizeAccount(account) });
}
async function clearSessionRoutesControl(services) {
  await services.oauthService.clearSessionRoutes();
  return jsonResult(200, { ok: true });
}
async function recordRateLimitProbeLifecycle(services, accountId, account, result, startedAt) {
  const lifecycleStore = services?.accountLifecycleStore;
  if (!lifecycleStore || typeof lifecycleStore.recordEvent !== "function") return;
  try {
    const httpStatus =
      typeof result?.httpStatus === "number" ? result.httpStatus : null;
    const isFailure =
      result?.error != null ||
      (typeof httpStatus === "number" && httpStatus >= 400);
    await lifecycleStore.recordEvent({
      accountId,
      eventType: "rate_limit_probe",
      outcome: isFailure ? "failure" : "ok",
      egressProxyUrl: account?.proxyUrl ?? null,
      egressProvider: account?.provider ?? null,
      upstreamStatus: httpStatus,
      upstreamRequestId:
        result?.anthropicHeaders?.["request-id"] ??
        result?.anthropicHeaders?.["x-request-id"] ??
        null,
      upstreamOrganizationId:
        result?.anthropicHeaders?.["anthropic-organization-id"] ??
        result?.anthropicHeaders?.["anthropic-ratelimit-organization-id"] ??
        null,
      upstreamRateLimitTier:
        result?.anthropicHeaders?.["anthropic-ratelimit-tier"] ?? null,
      anthropicHeaders: result?.anthropicHeaders ?? null,
      durationMs: Date.now() - startedAt,
      notes: {
        status: result?.status ?? null,
        fiveHourUtilization: result?.fiveHourUtilization ?? null,
        sevenDayUtilization: result?.sevenDayUtilization ?? null,
        tokenStatus: result?.tokenStatus ?? null,
        refreshAttempted: result?.refreshAttempted ?? null,
        refreshSucceeded: result?.refreshSucceeded ?? null,
        refreshError: result?.refreshError ?? null,
        error: result?.error ?? null,
        accountUuid: account?.accountUuid ?? null,
        organizationUuid: account?.organizationUuid ?? null,
        emailAddress: account?.emailAddress ?? null,
        subscriptionType: account?.subscriptionType ?? null,
      },
    });
  } catch (error) {
    console.warn(
      `[lifecycle] rate_limit_probe failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
async function probeAccountRateLimitControl(services, accountId) {
  const account = await services.oauthService.getAccount(accountId);
  if (!account) {
    return jsonResult(404, {
      error: "account_not_found",
      message: `账号不存在: ${accountId}`,
    });
  }
  const probeStartedAt = Date.now();
  if (account.provider === "openai-codex") {
    const proxyUrl = await services.oauthService.resolveProxyUrl(
      account.proxyUrl,
    );
    const result = await probeOpenAICodexRateLimits({
      accessToken: account.accessToken,
      organizationUuid: account.organizationUuid,
      apiBaseUrl: account.apiBaseUrl || appConfig.openAICodexApiBaseUrl,
      model: account.modelName || appConfig.openAICodexModel,
      proxyDispatcher:
        proxyUrl && services.proxyPool
          ? services.proxyPool.getHttpDispatcher(proxyUrl)
          : undefined,
    });
    if (
      result.status ||
      result.fiveHourUtilization != null ||
      result.sevenDayUtilization != null
    ) {
      await services.oauthService.recordRateLimitSnapshot({
        accountId,
        status: result.status ?? null,
        fiveHourUtilization: result.fiveHourUtilization ?? null,
        sevenDayUtilization: result.sevenDayUtilization ?? null,
        resetTimestamp: pickEarliestTimestamp(
          result.fiveHourReset,
          result.sevenDayReset,
        ),
      });
    }
    return jsonResult(200, result);
  }
  if (account.provider === "claude-compatible") {
    const proxyUrl = await services.oauthService.resolveProxyUrl(
      account.proxyUrl,
    );
    const result = await probeClaudeCompatibleConnectivity({
      account,
      anthropicVersion: appConfig.anthropicVersion,
      proxyDispatcher:
        proxyUrl && services.proxyPool
          ? services.proxyPool.getHttpDispatcher(proxyUrl)
          : undefined,
      bodyTemplate: appConfig.bodyTemplateNew ?? appConfig.bodyTemplate ?? null,
    });
    return jsonResult(200, result);
  }
  if (isGeminiOauthAccount(account)) {
    const result = await probeGeminiRateLimitsWithRecovery({
      oauthService: services.oauthService,
      proxyPool: services.proxyPool,
      account,
    });
    await services.oauthService.recordRateLimitSnapshot({
      accountId,
      status: result.status ?? result.error ?? null,
      fiveHourUtilization: result.fiveHourUtilization ?? null,
      sevenDayUtilization: result.sevenDayUtilization ?? null,
      resetTimestamp: result.reset ?? null,
    });
    return jsonResult(200, result);
  }
  if (providerRequiresProxy(account.provider) && !account.proxyUrl && account.directEgressEnabled !== true) {
    return jsonResult(400, {
      error: "no_proxy",
      message: `账号未绑定代理且未开启直连: ${accountId}`,
    });
  }
  const result = await probeAccountRateLimitsWithRecovery({
    oauthService: services.oauthService,
    proxyPool: services.proxyPool,
    account,
  });
  await services.oauthService.recordRateLimitSnapshot({
    accountId,
    status: result.status ?? result.error ?? null,
    fiveHourUtilization: result.fiveHourUtilization ?? null,
    sevenDayUtilization: result.sevenDayUtilization ?? null,
    resetTimestamp: result.reset ?? null,
  });
  void recordRateLimitProbeLifecycle(services, accountId, account, result, probeStartedAt);
  return jsonResult(200, result);
}
async function createProxyControl(services, body) {
  const label = String(body?.label ?? "").trim();
  const url = String(body?.url ?? "").trim();
  if (!url) {
    return jsonResult(400, {
      error: "missing_url",
      message: "Proxy URL is required",
    });
  }
  const proxy = await services.oauthService.addProxy(label, url, {
    kind: body?.kind,
    enabled: body?.enabled !== undefined ? Boolean(body.enabled) : true,
    source: body?.source,
    localUrl: body?.localUrl ? String(body.localUrl) : null,
    inboundPort: body?.inboundPort ? Number(body.inboundPort) : null,
    inboundProtocol: body?.inboundProtocol,
  });
  return jsonResult(200, { ok: true, proxy });
}
async function importProxiesControl(services, body) {
  const raw = String(body?.text ?? "");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const proxies = [];
  const errors = [];
  let nextPort = body?.portBase ? Number(body.portBase) : null;
  for (const line of lines) {
    try {
      const tabParts = line.split(/\t+/).map((part) => part.trim()).filter(Boolean);
      const url = tabParts.find((part) => part.startsWith("vless://")) || line.match(/vless:\/\/\S+/)?.[0];
      if (!url) throw new Error("missing vless:// URL");
      const parsed = new URL(url);
      const labelFromHash = parsed.hash ? decodeURIComponent(parsed.hash.slice(1)).trim() : "";
      const label = tabParts.find((part) => part !== url && !part.startsWith("vless://")) || labelFromHash || parsed.hostname || "VLESS upstream";
      const proxy = await services.oauthService.addProxy(label, url, {
        kind: "vless-upstream",
        enabled: true,
        source: "manual",
        inboundProtocol: "http",
        inboundPort: nextPort,
      });
      proxies.push(proxy);
      if (nextPort) nextPort += 1;
    } catch (error) {
      errors.push({ line, error: sanitizeErrorMessage(error) });
    }
  }
  return jsonResult(errors.length ? 207 : 200, { ok: errors.length === 0, proxies, errors });
}
async function updateProxyControl(services, proxyId, body) {
  const updates = {};
  if (body?.label !== undefined) updates.label = String(body.label);
  if (body?.url !== undefined) updates.url = String(body.url);
  if (body?.localUrl !== undefined)
    updates.localUrl = body.localUrl ? String(body.localUrl) : null;
  if (body?.kind !== undefined) updates.kind = String(body.kind);
  if (body?.enabled !== undefined) updates.enabled = Boolean(body.enabled);
  if (body?.source !== undefined) updates.source = String(body.source);
  if (body?.listen !== undefined) updates.listen = body.listen ? String(body.listen) : null;
  if (body?.inboundPort !== undefined) updates.inboundPort = body.inboundPort ? Number(body.inboundPort) : null;
  if (body?.inboundProtocol !== undefined) updates.inboundProtocol = body.inboundProtocol ? String(body.inboundProtocol) : null;
  if (body?.outboundTag !== undefined) updates.outboundTag = body.outboundTag ? String(body.outboundTag) : null;
  const proxy = await services.oauthService.updateProxy(proxyId, updates);
  return jsonResult(200, { ok: true, proxy });
}
async function deleteProxyControl(services, proxyId) {
  const proxy = await services.oauthService.deleteProxy(proxyId);
  return jsonResult(200, { ok: true, proxy });
}
async function linkProxyControl(services, proxyId, body) {
  const accountIds = body?.accountIds;
  if (!Array.isArray(accountIds)) {
    return jsonResult(400, {
      error: "invalid_body",
      message: "accountIds must be an array",
    });
  }
  await services.oauthService.linkAccountsToProxy(proxyId, accountIds);
  return jsonResult(200, { ok: true });
}
async function unlinkProxyControl(services, body) {
  const accountId = String(body?.accountId ?? "");
  if (!accountId) {
    return jsonResult(400, {
      error: "missing_account_id",
      message: "accountId is required",
    });
  }
  await services.oauthService.unlinkAccountFromProxy(accountId);
  return jsonResult(200, { ok: true });
}
async function createUserApiKeyControl(services, userId, body) {
  if (!services.userStore || !services.apiKeyStore) {
    return jsonResult(404, { error: "api_key_management_disabled" });
  }
  const user = await services.userStore.getUserById(userId);
  if (!user) {
    return jsonResult(404, { error: "user_not_found" });
  }
  const rawName = typeof body?.name === "string" ? body.name : "";
  const groupAssignments = normalizeApiKeyGroupAssignments(
    body?.groupAssignments,
  );
  await validateApiKeyGroupAssignments(services, groupAssignments);
  try {
    const created = await services.apiKeyStore.create(userId, {
      name: rawName,
      groupAssignments,
    });
    return jsonResult(200, { created: true, ...created });
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err ? String(err.code) : null;
    const message = err instanceof Error ? err.message : "create_failed";
    if (code === "api_key_quota_exceeded") {
      return jsonResult(409, { error: code, message });
    }
    return jsonResult(500, { error: "create_failed", message });
  }
}
async function updateUserApiKeyGroupsControl(services, userId, keyId, body) {
  if (!services.userStore || !services.apiKeyStore) {
    return jsonResult(404, { error: "api_key_management_disabled" });
  }
  const user = await services.userStore.getUserById(userId);
  if (!user) {
    return jsonResult(404, { error: "user_not_found" });
  }
  const groupAssignments = normalizeApiKeyGroupAssignments(
    body?.groupAssignments,
  );
  await validateApiKeyGroupAssignments(services, groupAssignments);
  const apiKey = await services.apiKeyStore.updateGroups(
    userId,
    keyId,
    groupAssignments,
  );
  if (!apiKey) {
    return jsonResult(404, { error: "api_key_not_found" });
  }
  return jsonResult(200, { ok: true, apiKey });
}
async function revokeUserApiKeyControl(services, userId, keyId) {
  if (!services.userStore || !services.apiKeyStore) {
    return jsonResult(404, { error: "api_key_management_disabled" });
  }
  const user = await services.userStore.getUserById(userId);
  if (!user) {
    return jsonResult(404, { error: "user_not_found" });
  }
  const revoked = await services.apiKeyStore.revoke(userId, keyId);
  if (!revoked) {
    return jsonResult(404, { error: "api_key_not_found" });
  }
  return jsonResult(200, { revoked: true, apiKey: revoked });
}
async function updateRelayUserControl(services, userId, body) {
  if (!services.userStore) {
    return jsonResult(404, { error: "user_management_disabled" });
  }
  const updates = {};
  if (body?.name !== undefined) updates.name = body.name;
  if (body?.orgId !== undefined) updates.orgId = body.orgId;
  if (body?.accountId !== undefined) updates.accountId = body.accountId;
  if (body?.routingMode !== undefined)
    updates.routingMode = String(body.routingMode);
  const userRoutingGroupId = getFirstDefinedNullableString(body, [
    "routingGroupId",
    "preferredGroup",
  ]);
  if (userRoutingGroupId !== undefined) {
    updates.routingGroupId = userRoutingGroupId;
    updates.preferredGroup = userRoutingGroupId;
  }
  if (body?.billingMode !== undefined)
    updates.billingMode =
      String(body.billingMode) === "prepaid" ? "prepaid" : "postpaid";
  if (body?.billingCurrency !== undefined) {
    const billingCurrency = normalizeBillingCurrency(body.billingCurrency, {
      field: "billingCurrency",
    });
    if (services.billingStore) {
      await services.billingStore.changeUserBillingCurrency(
        userId,
        billingCurrency,
      );
    } else {
      updates.billingCurrency = billingCurrency;
    }
  }
  if (body?.customerTier !== undefined)
    updates.customerTier = String(body.customerTier);
  if (body?.creditLimitMicros !== undefined)
    updates.creditLimitMicros = body.creditLimitMicros;
  if (body?.salesOwner !== undefined) updates.salesOwner = body.salesOwner;
  if (body?.riskStatus !== undefined)
    updates.riskStatus = String(body.riskStatus);
  if (body?.isActive !== undefined) updates.isActive = Boolean(body.isActive);
  const user = await services.userStore.updateUser(userId, updates);
  if (!user) {
    return jsonResult(404, { error: "user_not_found" });
  }
  return jsonResult(200, { ok: true, user: sanitizeUser(user) });
}
async function deleteRelayUserControl(services, userId) {
  if (!services.userStore) {
    return jsonResult(404, { error: "user_management_disabled" });
  }
  const deleted = await services.userStore.deleteUser(userId);
  if (!deleted) {
    return jsonResult(404, { error: "user_not_found" });
  }
  return jsonResult(200, { ok: true });
}
async function regenerateRelayUserKeyControl(services, userId) {
  if (!services.userStore) {
    return jsonResult(404, { error: "user_management_disabled" });
  }
  const user = await services.userStore.getUserById(userId);
  if (!user) {
    return jsonResult(404, { error: "user_not_found" });
  }
  if (!services.apiKeyStore) {
    const regenerated = await services.userStore.regenerateApiKey(userId);
    if (!regenerated) {
      return jsonResult(404, { error: "user_not_found" });
    }
    return jsonResult(200, {
      ok: true,
      user: sanitizeUser(regenerated),
      apiKey: regenerated.apiKey,
      apiKeySource: "relay_users_legacy",
      primaryApiKey: null,
      revokedApiKey: null,
      rotationMode: "legacy_fallback",
    });
  }
  try {
    const rotated =
      typeof services.apiKeyStore.rotateLatestForUser === "function"
        ? await services.apiKeyStore.rotateLatestForUser(userId, {
            name: "Rotated Key",
          })
        : null;
    const primaryApiKey = rotated
      ? rotated.created
      : await services.apiKeyStore.create(userId, { name: "Rotated Key" });
    const revokedApiKey = rotated?.revoked ?? null;
    return jsonResult(200, {
      ok: true,
      user: sanitizeUser(user),
      apiKey: primaryApiKey.apiKey,
      apiKeySource: "relay_api_keys",
      primaryApiKey,
      revokedApiKey,
      legacyApiKeyRetained: Boolean(user.apiKey),
      rotationMode: revokedApiKey
        ? "rotated_latest_active_relay_key"
        : "issued_new_key_without_prior_active_key",
    });
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err ? String(err.code) : null;
    const message = err instanceof Error ? err.message : "regenerate_failed";
    if (code === "api_key_quota_exceeded") {
      return jsonResult(409, { error: code, message });
    }
    return jsonResult(500, { error: "regenerate_failed", message });
  }
}
async function topupRelayUserControl(services, relayUserId, body) {
  if (!services.userStore || !services.billingStore) {
    return jsonResult(503, { error: "billing_disabled" });
  }
  const user = await services.userStore.getUserById(relayUserId);
  if (!user) {
    return jsonResult(404, { error: "user_not_found" });
  }
  const amountMicros = body?.amountMicros;
  if (amountMicros === undefined || amountMicros === null) {
    return jsonResult(400, {
      error: "missing_amount",
      message: "amountMicros is required",
    });
  }
  const billingCurrency = getOptionalBillingCurrency(
    body?.currency,
    "currency",
  );
  const userUpdates = {};
  if (user.billingMode !== "prepaid") {
    userUpdates.billingMode = "prepaid";
  }
  if (billingCurrency && user.billingCurrency !== billingCurrency) {
    try {
      await services.billingStore.changeUserBillingCurrency(
        relayUserId,
        billingCurrency,
      );
    } catch (error) {
      return jsonResult(400, {
        error: "billing_currency_mismatch",
        message: sanitizeErrorMessage(error),
      });
    }
  }
  if (Object.keys(userUpdates).length > 0) {
    await services.userStore.updateUser(relayUserId, userUpdates);
  }
  const note = getNullableStringField(body, "note");
  const idempotencyKey = getNullableStringField(body, "idempotencyKey");
  try {
    const result = await services.billingStore.createLedgerEntry({
      userId: relayUserId,
      kind: "topup",
      amountMicros,
      note,
      externalRef: idempotencyKey,
    });
    return jsonResult(200, {
      ok: true,
      idempotent: result.idempotent === true,
      entry: result.entry,
      balance: result.balance,
    });
  } catch (error) {
    if (error instanceof InputValidationError) {
      return jsonResult(400, {
        error: "invalid_topup",
        message: error.message,
      });
    }
    throw error;
  }
}
async function createBillingLedgerControl(services, userId, body) {
  if (!services.billingStore) {
    return jsonResult(404, { error: "billing_disabled" });
  }
  const kind = body?.kind === "topup" ? "topup" : "manual_adjustment";
  const amountMicros = body?.amountMicros;
  if (
    amountMicros === undefined ||
    amountMicros === null ||
    String(amountMicros).trim() === ""
  ) {
    return jsonResult(400, {
      error: "missing_amount_micros",
      message: "amountMicros is required",
    });
  }
  const existing = await services.billingStore.getUserBalanceSummary(userId);
  if (!existing) {
    return jsonResult(404, { error: "billing_user_not_found" });
  }
  try {
    const result = await services.billingStore.createLedgerEntry({
      userId,
      kind,
      amountMicros,
      note: body?.note,
    });
    return jsonResult(200, {
      ok: true,
      entry: result.entry,
      balance: result.balance,
    });
  } catch (error) {
    return jsonResult(400, {
      error: "invalid_billing_ledger_entry",
      message: sanitizeErrorMessage(error),
    });
  }
}
async function upsertBaseSkuControl(services, body) {
  if (!services.billingStore) {
    return jsonResult(404, { error: "billing_disabled" });
  }
  const sku = await services.billingStore.upsertBaseSku({
    provider: body?.provider,
    modelVendor: body?.modelVendor,
    protocol: body?.protocol,
    model: body?.model,
    currency: getOptionalBillingCurrency(body?.currency, "currency") ?? "USD",
    displayName: body?.displayName,
    isActive: body?.isActive,
    supportsPromptCaching: body?.supportsPromptCaching,
    inputPriceMicrosPerMillion: body?.inputPriceMicrosPerMillion,
    outputPriceMicrosPerMillion: body?.outputPriceMicrosPerMillion,
    cacheCreationPriceMicrosPerMillion:
      body?.cacheCreationPriceMicrosPerMillion,
    cacheReadPriceMicrosPerMillion: body?.cacheReadPriceMicrosPerMillion,
    topupCurrency: getOptionalBillingCurrency(
      body?.topupCurrency,
      "topupCurrency",
    ),
    topupAmountMicros: body?.topupAmountMicros,
    creditAmountMicros: body?.creditAmountMicros,
  });
  const result = await services.billingStore.syncLineItems({
    reconcileMissing: true,
  });
  return jsonResult(200, { ok: true, sku, result });
}
async function deleteBaseSkuControl(services, skuId) {
  if (!services.billingStore) {
    return jsonResult(404, { error: "billing_disabled" });
  }
  const deleted = await services.billingStore.deleteBaseSku(skuId);
  if (!deleted) {
    return jsonResult(404, { error: "billing_base_sku_not_found" });
  }
  return jsonResult(200, { ok: true });
}
async function upsertChannelMultiplierControl(services, body) {
  if (!services.billingStore) {
    return jsonResult(404, { error: "billing_disabled" });
  }
  const multiplier = await services.billingStore.upsertChannelMultiplier({
    routingGroupId: body?.routingGroupId,
    provider: body?.provider,
    modelVendor: body?.modelVendor,
    protocol: body?.protocol,
    model: body?.model,
    multiplierMicros: body?.multiplierMicros,
    isActive: body?.isActive,
    showInFrontend: body?.showInFrontend,
    allowCalls: body?.allowCalls,
  });
  const result = await services.billingStore.syncLineItems({
    reconcileMissing: true,
  });
  return jsonResult(200, { ok: true, multiplier, result });
}
async function deleteChannelMultiplierControl(services, multiplierId) {
  if (!services.billingStore) {
    return jsonResult(404, { error: "billing_disabled" });
  }
  const deleted =
    await services.billingStore.deleteChannelMultiplier(multiplierId);
  if (!deleted) {
    return jsonResult(404, { error: "billing_multiplier_not_found" });
  }
  return jsonResult(200, { ok: true });
}
async function copyChannelMultipliersControl(services, body) {
  if (!services.billingStore) {
    return jsonResult(404, { error: "billing_disabled" });
  }
  const result = await services.billingStore.copyMultipliersBetweenGroups({
    fromRoutingGroupId: body?.fromRoutingGroupId,
    toRoutingGroupId: body?.toRoutingGroupId,
    overwrite: Boolean(body?.overwrite),
  });
  return jsonResult(200, { ok: true, ...result });
}
async function bulkAdjustChannelMultipliersControl(services, body) {
  if (!services.billingStore) {
    return jsonResult(404, { error: "billing_disabled" });
  }
  const result = await services.billingStore.bulkAdjustChannelMultipliers({
    routingGroupId: body?.routingGroupId,
    multiplierIds: Array.isArray(body?.multiplierIds)
      ? body.multiplierIds
      : undefined,
    scale: typeof body?.scale === "number" ? body.scale : undefined,
    setMultiplierMicros: body?.setMultiplierMicros,
  });
  return jsonResult(200, { ok: true, ...result });
}
async function syncBillingLineItemsControl(services, body) {
  if (!services.billingStore) {
    return jsonResult(404, { error: "billing_disabled" });
  }
  const result = await services.billingStore.syncLineItems({
    reconcileMissing: Boolean(body?.reconcileMissing),
  });
  return jsonResult(200, { ok: true, result });
}
async function rebuildBillingLineItemsControl(services) {
  if (!services.billingStore) {
    return jsonResult(404, { error: "billing_disabled" });
  }
  const result = await services.billingStore.rebuildLineItems();
  return jsonResult(200, { ok: true, result });
}
function resolveProbeProxyTarget(proxy) {
  if (proxy.localUrl && /^https?:\/\//i.test(proxy.localUrl)) {
    return { via: "localUrl", proxyUrl: proxy.localUrl };
  }
  if (/^https?:\/\//i.test(proxy.url)) {
    return { via: "url", proxyUrl: proxy.url };
  }
  return null;
}
function detectIpFamily(ip) {
  if (!ip) {
    return null;
  }
  if (ip.includes(":")) {
    return "ipv6";
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
    return "ipv4";
  }
  return "unknown";
}

function parseLocalProxyPort(localUrl) {
  if (!localUrl) return null;
  try {
    const parsed = new URL(localUrl);
    const port = Number(parsed.port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function inferManagedInboundProtocol(proxy) {
  if (proxy.inboundProtocol === "socks") return "socks";
  return "http";
}

function sanitizeXrayTag(input) {
  return String(input || "proxy")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "proxy";
}

function parseVlessUpstream(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "vless:") {
    throw new Error("Only vless:// upstream URLs can be converted into managed Xray outbounds");
  }
  const uuid = decodeURIComponent(parsed.username || "").trim();
  if (!uuid) throw new Error("VLESS URL is missing UUID/user id");
  const address = parsed.hostname;
  const port = Number(parsed.port || 443);
  const params = parsed.searchParams;
  const security = params.get("security") || "none";
  const flow = params.get("flow") || undefined;
  const encryption = params.get("encryption") || "none";
  const network = params.get("type") || "tcp";
  const settings = {
    vnext: [
      {
        address,
        port,
        users: [{ id: uuid, encryption, ...(flow ? { flow } : {}) }],
      },
    ],
  };
  const streamSettings = { network, security };
  if (security === "reality") {
    streamSettings.realitySettings = {
      serverName: params.get("sni") || params.get("serverName") || address,
      fingerprint: params.get("fp") || "chrome",
      publicKey: params.get("pbk") || "",
      shortId: params.get("sid") || "",
      spiderX: params.get("spx") || "/",
    };
  } else if (security === "tls") {
    streamSettings.tlsSettings = {
      serverName: params.get("sni") || params.get("serverName") || address,
      fingerprint: params.get("fp") || "chrome",
      allowInsecure: params.get("allowInsecure") === "1" || params.get("allowInsecure") === "true",
    };
  }
  if (network === "ws") {
    streamSettings.wsSettings = {
      path: params.get("path") || "/",
      headers: params.get("host") ? { Host: params.get("host") } : {},
    };
  }
  if (network === "grpc") {
    streamSettings.grpcSettings = { serviceName: params.get("serviceName") || "" };
  }
  return { settings, streamSettings };
}

function isCorManagedTag(tag) {
  return typeof tag === "string" && (tag.startsWith("cor-in-") || tag.startsWith("cor-out-"));
}

function isCorManagedRule(rule) {
  if (!rule || typeof rule !== "object") return false;
  if (isCorManagedTag(rule.outboundTag)) return true;
  return Array.isArray(rule.inboundTag) && rule.inboundTag.some((tag) => isCorManagedTag(tag));
}

async function readExistingXrayConfig() {
  try {
    const raw = await fs.promises.readFile(XRAY_MANAGED_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Missing or invalid existing config: fall through to a minimal baseline.
  }
  return {
    log: { loglevel: "warning" },
    inbounds: [],
    outbounds: [{ protocol: "freedom", tag: "direct" }, { protocol: "blackhole", tag: "blocked" }],
    routing: { domainStrategy: "AsIs", rules: [] },
  };
}

function buildManagedXrayConfig(proxies, baseConfig) {
  const managed = proxies.filter((proxy) => proxy.enabled !== false && proxy.kind === "vless-upstream");
  const config = JSON.parse(JSON.stringify(baseConfig || {}));
  const existingInbounds = Array.isArray(config.inbounds) ? config.inbounds : [];
  const existingOutbounds = Array.isArray(config.outbounds) ? config.outbounds : [];
  const existingRules = Array.isArray(config.routing?.rules) ? config.routing.rules : [];
  const usedPorts = new Set(
    existingInbounds
      .filter((inbound) => !isCorManagedTag(inbound?.tag))
      .map((inbound) => Number(inbound?.port))
      .filter((port) => Number.isInteger(port) && port > 0),
  );
  const inbounds = [];
  const outbounds = [];
  const rules = [];
  const assignments = [];
  let nextPort = XRAY_MANAGED_PORT_BASE;
  managed.forEach((proxy, index) => {
    let port = proxy.inboundPort || parseLocalProxyPort(proxy.localUrl) || null;
    if (port && usedPorts.has(port) && !proxy.localUrl) {
      port = null;
    }
    if (!port) {
      while (usedPorts.has(nextPort)) nextPort += 1;
      port = nextPort;
    }
    if (usedPorts.has(port)) throw new Error(`Duplicate managed Xray inbound port: ${port}`);
    usedPorts.add(port);
    const inboundProtocol = inferManagedInboundProtocol(proxy);
    const inboundTag = `cor-in-${sanitizeXrayTag(proxy.id)}`;
    const outboundTag = proxy.outboundTag || `cor-out-${sanitizeXrayTag(proxy.id)}`;
    const upstream = parseVlessUpstream(proxy.url);
    inbounds.push({
      listen: proxy.listen || XRAY_MANAGED_LISTEN,
      port,
      protocol: inboundProtocol,
      tag: inboundTag,
      settings: inboundProtocol === "socks" ? { auth: "noauth", udp: true, accounts: [] } : { accounts: [], allowTransparent: false },
      sniffing: { enabled: true, destOverride: ["http", "tls", "quic"] },
    });
    outbounds.push({ protocol: "vless", tag: outboundTag, settings: upstream.settings, streamSettings: upstream.streamSettings });
    rules.push({ type: "field", inboundTag: [inboundTag], outboundTag });
    assignments.push({
      proxyId: proxy.id,
      localUrl: `${inboundProtocol === "socks" ? "socks5" : "http"}://${proxy.listen || XRAY_MANAGED_LISTEN}:${port}`,
      inboundPort: port,
      inboundProtocol,
      outboundTag,
    });
  });
  return {
    assignments,
    config: {
      ...config,
      inbounds: [...existingInbounds.filter((inbound) => !isCorManagedTag(inbound?.tag)), ...inbounds],
      outbounds: [...existingOutbounds.filter((outbound) => !isCorManagedTag(outbound?.tag)), ...outbounds],
      routing: {
        ...(config.routing || {}),
        domainStrategy: config.routing?.domainStrategy || "AsIs",
        rules: [...rules, ...existingRules.filter((rule) => !isCorManagedRule(rule))],
      },
    },
  };
}

async function syncManagedXrayConfig(services, options = {}) {
  const proxies = await services.oauthService.listProxies();
  const baseConfig = await readExistingXrayConfig();
  const { config, assignments } = buildManagedXrayConfig(proxies, baseConfig);
  if (options.dryRun) {
    return { dryRun: true, path: XRAY_MANAGED_CONFIG_PATH, assignments, config };
  }
  await fs.promises.mkdir(path.dirname(XRAY_MANAGED_CONFIG_PATH), { recursive: true });
  let backupPath = null;
  try {
    await fs.promises.access(XRAY_MANAGED_CONFIG_PATH, fs.constants.F_OK);
    backupPath = `${XRAY_MANAGED_CONFIG_PATH}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
    await fs.promises.copyFile(XRAY_MANAGED_CONFIG_PATH, backupPath);
  } catch {
    backupPath = null;
  }
  await fs.promises.writeFile(XRAY_MANAGED_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  let validation = null;
  if (options.validate) {
    try {
      const result = await execFileAsync(XRAY_MANAGED_BIN, ["test", "-config", XRAY_MANAGED_CONFIG_PATH], { timeout: 15_000 });
      validation = { ok: true, stdout: result.stdout?.slice(0, 2000) || "", stderr: result.stderr?.slice(0, 2000) || "" };
    } catch (error) {
      const message = sanitizeErrorMessage(error);
      if (XRAY_TEST_UNSUPPORTED_PATTERN.test(message)) {
        validation = { ok: true, skipped: true, reason: "xray_test_unsupported", error: message.slice(0, 500) };
      } else {
        validation = { ok: false, error: message };
      }
      if (validation.ok) {
        // Continue when the installed Xray binary does not support `xray test`.
      } else {
      if (backupPath) {
        await fs.promises.copyFile(backupPath, XRAY_MANAGED_CONFIG_PATH).catch(() => {});
      }
      return { dryRun: false, path: XRAY_MANAGED_CONFIG_PATH, backupPath, assignments, validation, rolledBack: Boolean(backupPath) };
      }
    }
  }
  for (const assignment of assignments) {
    await services.oauthService.updateProxy(assignment.proxyId, {
      localUrl: assignment.localUrl,
      listen: XRAY_MANAGED_LISTEN,
      inboundPort: assignment.inboundPort,
      inboundProtocol: assignment.inboundProtocol,
      outboundTag: assignment.outboundTag,
      xrayConfigPath: XRAY_MANAGED_CONFIG_PATH,
      source: "generated",
    });
  }
  let restart = null;
  if (options.restart && XRAY_MANAGED_SERVICE) {
    try {
      const [command, ...prefixArgs] = splitShellWords(XRAY_SYSTEMCTL_BIN);
      await execFileAsync(command || "systemctl", [...prefixArgs, "restart", XRAY_MANAGED_SERVICE], { timeout: 15_000 });
      restart = { ok: true, service: XRAY_MANAGED_SERVICE };
    } catch (error) {
      restart = { ok: false, service: XRAY_MANAGED_SERVICE, error: sanitizeErrorMessage(error) };
    }
  }
  const readiness = [];
  if (restart?.ok) {
    for (const assignment of assignments) {
      const ready = await waitForTcpPort(XRAY_MANAGED_LISTEN, assignment.inboundPort);
      readiness.push({ proxyId: assignment.proxyId, inboundPort: assignment.inboundPort, ready });
    }
  }
  return { dryRun: false, path: XRAY_MANAGED_CONFIG_PATH, backupPath, assignments, validation, restart, readiness };
}

async function ensureProxyProbeReady(services, proxy) {
  const hasProbeTarget = Boolean(resolveProbeProxyTarget(proxy));
  if (hasProbeTarget || proxy.kind !== "vless-upstream" || proxy.enabled === false) {
    return proxy;
  }
  const syncResult = await syncManagedXrayConfig(services, { validate: true, restart: true });
  if (syncResult.validation && syncResult.validation.ok === false) {
    return proxy;
  }
  const proxies = await services.oauthService.listProxies();
  return proxies.find((item) => item.id === proxy.id) || proxy;
}

async function probeProxyExitOnce(proxy) {
  const checkedAt = new Date().toISOString();
  const target = resolveProbeProxyTarget(proxy);
  if (!target) {
    return {
      proxyId: proxy.id,
      checkedAt,
      via: null,
      status: "unsupported",
      latencyMs: null,
      httpStatus: null,
      ipLookupStatus: null,
      egressIp: null,
      egressFamily: null,
      error:
        "缺少可探测的 HTTP 本地代理地址，请先配置 localUrl（例如 http://127.0.0.1:10812）",
    };
  }
  const dispatcher = new ProxyAgent(target.proxyUrl);
  try {
    let connectivity = null;
    let connectivityUrl = null;
    let latencyMs = null;
    const failures = [];
    for (const url of PROXY_CONNECTIVITY_CHECK_URLS) {
      const attemptStart = Date.now();
      try {
        const resp = await request(url, {
          method: "GET",
          headers: buildProxyProbeHeaders(),
          dispatcher,
          signal: AbortSignal.timeout(PROXY_PROBE_TIMEOUT_MS),
        });
        latencyMs = Date.now() - attemptStart;
        await resp.body.text().catch(() => "");
        connectivity = resp;
        connectivityUrl = url;
        break;
      } catch (error) {
        failures.push(`${url}: ${sanitizeErrorMessage(error)}`);
      }
    }
    if (!connectivity) {
      throw new Error(`所有连通性端点均失败 — ${failures.join("; ")}`);
    }
    // 收到任何 HTTP 响应（含 4xx/5xx）都说明 DNS→TCP→TLS→HTTP 全链路通；
    // 仅目标端点的业务层响应，不作为代理健康度判据。
    const connectivityNotice =
      connectivity.statusCode >= 400
        ? `连通性端点 ${connectivityUrl} 返回 HTTP ${connectivity.statusCode}（链路可达，目标端点拒绝或无响应体）`
        : null;
    let ipLookupStatus = null;
    let egressIp = null;
    let ipLookupError = null;
    try {
      const ipResponse = await request(PROXY_EGRESS_IP_URL, {
        method: "GET",
        headers: buildProxyProbeHeaders(),
        dispatcher,
        signal: AbortSignal.timeout(PROXY_PROBE_TIMEOUT_MS),
      });
      ipLookupStatus = ipResponse.statusCode;
      const raw = (await ipResponse.body.text().catch(() => "")).trim();
      if (ipResponse.statusCode >= 400) {
        ipLookupError = `出口 IP 服务返回 HTTP ${ipResponse.statusCode}`;
      } else if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed.ip === "string" && parsed.ip.trim()) {
            egressIp = parsed.ip.trim();
          } else {
            egressIp = raw;
          }
        } catch {
          egressIp = raw;
        }
      } else {
        ipLookupError = "出口 IP 服务返回空响应";
      }
    } catch (error) {
      ipLookupError = sanitizeErrorMessage(error);
    }
    const hasDegradation =
      Boolean(ipLookupError) || Boolean(connectivityNotice);
    const errorMessages = [
      connectivityNotice,
      ipLookupError ? `出口 IP 探测失败: ${ipLookupError}` : null,
    ].filter(Boolean);
    return {
      proxyId: proxy.id,
      checkedAt,
      via: target.via,
      status: hasDegradation ? "degraded" : "healthy",
      latencyMs,
      httpStatus: connectivity.statusCode,
      ipLookupStatus,
      egressIp,
      egressFamily: detectIpFamily(egressIp),
      error: errorMessages.length ? errorMessages.join("；") : null,
    };
  } catch (error) {
    return {
      proxyId: proxy.id,
      checkedAt,
      via: target.via,
      status: "error",
      latencyMs: null,
      httpStatus: null,
      ipLookupStatus: null,
      egressIp: null,
      egressFamily: null,
      error: sanitizeErrorMessage(error),
    };
  } finally {
    await dispatcher.close().catch(() => {});
  }
}
async function probeProxyExit(proxy) {
  let diagnostics = await probeProxyExitOnce(proxy);
  const port = parseLocalProxyPort(proxy.localUrl);
  if (diagnostics.status !== "error" || !port) {
    return diagnostics;
  }
  const error = String(diagnostics.error || "").toLowerCase();
  const maybeWarmup =
    error.includes("econnrefused") ||
    error.includes("socket hang up") ||
    error.includes("other side closed") ||
    error.includes("connection closed") ||
    error.includes("connection terminated");
  if (!maybeWarmup) {
    return diagnostics;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sleep(500);
    const ready = await waitForTcpPort(XRAY_MANAGED_LISTEN, port, 1_500);
    if (!ready) {
      continue;
    }
    diagnostics = await probeProxyExitOnce(proxy);
    if (diagnostics.status !== "error") {
      return diagnostics;
    }
  }
  return diagnostics;
}
function classifyRefreshFailure(error) {
  const message = sanitizeErrorMessage(error);
  const normalized = message.toLowerCase();
  if (
    normalized.includes("invalid_grant") ||
    normalized.includes("invalid refresh token") ||
    normalized.includes("revoked") ||
    normalized.includes("expired") ||
    normalized.includes("unauthorized")
  ) {
    return {
      error: "refresh_token_revoked",
      tokenStatus: "refresh_token_revoked",
      refreshError: message.slice(0, 500),
    };
  }
  return {
    error: "refresh_failed",
    tokenStatus: "refresh_failed",
    refreshError: message.slice(0, 500),
  };
}
async function probeAccountRateLimitsWithRecovery(input) {
  const initialProxyUrl = await input.oauthService.resolveProxyUrl(
    input.account.proxyUrl,
  );
  const runProbe = (accessToken) =>
    probeRateLimits({
      accessToken,
      proxyDispatcher:
        initialProxyUrl && input.proxyPool
          ? input.proxyPool.getHttpDispatcher(initialProxyUrl)
          : undefined,
      apiBaseUrl: appConfig.anthropicApiBaseUrl,
      anthropicVersion: appConfig.anthropicVersion,
      anthropicBeta: appConfig.oauthBetaHeader,
    });
  const initial = await runProbe(input.account.accessToken);
  if (initial.httpStatus !== 401 && initial.httpStatus !== 403) {
    return {
      ...initial,
      tokenStatus: "ok",
    };
  }
  if (!input.account.refreshToken) {
    return {
      ...initial,
      error: "refresh_token_missing",
      tokenStatus: "refresh_token_missing",
      refreshAttempted: false,
      refreshSucceeded: false,
      refreshError: "Account has no refresh token",
    };
  }
  try {
    const refreshed = await input.oauthService.refreshAccount(input.account.id);
    const refreshedProxyUrl = await input.oauthService.resolveProxyUrl(
      refreshed.proxyUrl,
    );
    const recovered = await probeRateLimits({
      accessToken: refreshed.accessToken,
      proxyDispatcher:
        refreshedProxyUrl && input.proxyPool
          ? input.proxyPool.getHttpDispatcher(refreshedProxyUrl)
          : undefined,
      apiBaseUrl: appConfig.anthropicApiBaseUrl,
      anthropicVersion: appConfig.anthropicVersion,
      anthropicBeta: appConfig.oauthBetaHeader,
    });
    return {
      ...recovered,
      tokenStatus:
        recovered.httpStatus === 401 || recovered.httpStatus === 403
          ? "refreshed_but_still_unauthorized"
          : "refreshed",
      refreshAttempted: true,
      refreshSucceeded:
        recovered.httpStatus !== 401 && recovered.httpStatus !== 403,
      refreshError:
        recovered.httpStatus === 401 || recovered.httpStatus === 403
          ? `Probe still unauthorized after refresh${recovered.error ? ` — ${recovered.error}` : ""}`
          : null,
    };
  } catch (error) {
    const classified = classifyRefreshFailure(error);
    return {
      ...initial,
      error: classified.error,
      tokenStatus: classified.tokenStatus,
      refreshAttempted: true,
      refreshSucceeded: false,
      refreshError: classified.refreshError,
    };
  }
}
async function probeGeminiRateLimitsWithRecovery(input) {
  const initialProxyUrl = await input.oauthService.resolveProxyUrl(
    input.account.proxyUrl,
  );
  const runProbe = (account) =>
    retrieveGeminiUserQuota({
      accessToken: account.accessToken,
      account,
      proxyDispatcher:
        initialProxyUrl && input.proxyPool
          ? input.proxyPool.getHttpDispatcher(initialProxyUrl)
          : undefined,
    });
  const initial = await runProbe(input.account);
  if (initial.httpStatus !== 401 && initial.httpStatus !== 403) {
    return {
      ...initial,
      tokenStatus: "ok",
    };
  }
  if (!input.account.refreshToken) {
    return {
      ...initial,
      error: "refresh_token_missing",
      tokenStatus: "refresh_token_missing",
      refreshAttempted: false,
      refreshSucceeded: false,
      refreshError: "Account has no refresh token",
    };
  }
  try {
    const refreshed = await input.oauthService.refreshAccount(input.account.id);
    const recovered = await runProbe(refreshed);
    return {
      ...recovered,
      tokenStatus:
        recovered.httpStatus === 401 || recovered.httpStatus === 403
          ? "refreshed_but_still_unauthorized"
          : "refreshed",
      refreshAttempted: true,
      refreshSucceeded:
        recovered.httpStatus !== 401 && recovered.httpStatus !== 403,
      refreshError:
        recovered.httpStatus === 401 || recovered.httpStatus === 403
          ? `Probe still unauthorized after refresh${recovered.error ? ` — ${recovered.error}` : ""}`
          : null,
    };
  } catch (error) {
    const classified = classifyRefreshFailure(error);
    return {
      ...initial,
      error: classified.error,
      tokenStatus: classified.tokenStatus,
      refreshAttempted: true,
      refreshSucceeded: false,
      refreshError: classified.refreshError,
    };
  }
}
export function createServer(services): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  const serviceMode = services.serviceMode;
  if (serviceMode !== "relay" && serviceMode !== "server") {
    throw new Error(
      "createServer requires serviceMode=relay or serviceMode=server",
    );
  }
  const relayControlClient = createRelayControlClient(
    appConfig.relayControlUrl,
    appConfig.internalToken,
    appConfig.requestTimeoutMs,
  );
  const runtimeState = services.runtimeState ?? null;
  const connectionTracker = services.connectionTracker ?? null;
  function requireInternalToken(req, res, next) {
    const token = appConfig.internalToken;
    if (!token) {
      res.status(503).json({
        error: "internal_api_disabled",
        message: "INTERNAL_TOKEN is not configured",
      });
      return;
    }
    const bearerToken = extractBearerToken(req);
    if (bearerToken !== token) {
      res.status(401).json({
        error: "unauthorized",
        message: "Missing or invalid bearer token",
      });
      return;
    }
    next();
  }
  if (connectionTracker) {
    app.use((_req, res, next) => {
      const endHttpRequest = connectionTracker.beginHttpRequest();
      let endStream = null;
      let cleanedUp = false;
      const maybeTrackStream = (value) => {
        if (endStream || !isEventStreamContentType(value)) {
          return;
        }
        endStream = connectionTracker.beginStream();
      };
      const originalSetHeader = res.setHeader.bind(res);
      res.setHeader = (name, value) => {
        const result = originalSetHeader(name, value);
        if (String(name).toLowerCase() === "content-type") {
          maybeTrackStream(value);
        }
        return result;
      };
      const originalWriteHead = res.writeHead.bind(res);
      res.writeHead = (...args) => {
        const result = originalWriteHead(...args);
        maybeTrackStream(res.getHeader("content-type"));
        maybeTrackStream(readContentTypeFromHeaderBag(args[args.length - 1]));
        return result;
      };
      const cleanup = () => {
        if (cleanedUp) {
          return;
        }
        cleanedUp = true;
        endStream?.();
        endHttpRequest();
      };
      res.once("finish", cleanup);
      res.once("close", cleanup);
      next();
    });
  }
  app.get("/livez", (_req, res) => {
    const live = runtimeState ? runtimeState.isLive() : true;
    res.status(live ? 200 : 503).json({
      ok: live,
      runtime: runtimeState?.snapshot() ?? null,
      connections: connectionTracker?.snapshot() ?? null,
    });
  });
  app.get("/readyz", (_req, res) => {
    const ready = runtimeState ? runtimeState.isReady() : true;
    res.status(ready ? 200 : 503).json({
      ok: ready,
      runtime: runtimeState?.snapshot() ?? null,
      connections: connectionTracker?.snapshot() ?? null,
    });
  });
  app.options("/healthz", (req, res) => {
    if (!applyCorsHeaders(req, res, "GET, OPTIONS")) {
      res.status(403).end();
      return;
    }
    res.status(204).end();
  });
  app.get(
    "/healthz",
    asyncRoute(async (req, res) => {
      if (!applyCorsHeaders(req, res, "GET, OPTIONS")) {
        res.status(403).json({
          error: "origin_not_allowed",
          message: "当前来源未被允许访问管理台",
        });
        return;
      }
      const accounts = await services.oauthService.listAccounts();
      const nextAccount =
        await services.oauthService.getDefaultAccountPreview();
      res.json({
        ok: true,
        accountCount: accounts.length,
        activeAccountCount: accounts.filter((account) => account.isActive)
          .length,
        nextAccountId: nextAccount?.id ?? null,
        nextAccountEmail: nextAccount?.emailAddress ?? null,
      });
    }),
  );
  if (serviceMode === "relay") {
    app.use(
      "/internal/control",
      requireInternalToken,
      express.json({ limit: "1mb" }),
    );
    app.post(
      "/internal/control/sticky-sessions/clear",
      asyncRoute(async (_req, res) => {
        const result = await clearStickySessionsControl(services);
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/account/clear",
      asyncRoute(async (_req, res) => {
        const result = await clearStoredAccountsControl(services);
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/accounts/:accountId/delete",
      asyncRoute(async (req, res) => {
        const result = await deleteAccountControl(
          services,
          getRouteParam(req.params.accountId),
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/accounts/create",
      asyncRoute(async (req, res) => {
        const result = await runWithOnboardingFromHeaders(
          services,
          req,
          "internal-control",
          () => createAccountControl(services, req.body),
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/routing-groups",
      asyncRoute(async (req, res) => {
        const result = await createRoutingGroupControl(services, req.body);
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/routing-groups/:groupId/update",
      asyncRoute(async (req, res) => {
        const result = await updateRoutingGroupControl(
          services,
          getRouteParam(req.params.groupId),
          req.body,
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/routing-groups/:groupId/delete",
      asyncRoute(async (req, res) => {
        const result = await deleteRoutingGroupControl(
          services,
          getRouteParam(req.params.groupId),
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/oauth/generate-auth-url",
      asyncRoute(async (req, res) => {
        const result = await generateAuthUrlControl(services, req.body);
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/oauth/exchange-code",
      asyncRoute(async (req, res) => {
        const result = await runWithOnboardingFromHeaders(
          services,
          req,
          "internal-control",
          () => exchangeCodeControl(services, req.body),
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/oauth/login-with-session-key",
      asyncRoute(async (req, res) => {
        const result = await runWithOnboardingFromHeaders(
          services,
          req,
          "internal-control",
          () => loginWithSessionKeyControl(services, req.body),
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/oauth/import-tokens",
      asyncRoute(async (req, res) => {
        const result = await runWithOnboardingFromHeaders(
          services,
          req,
          "internal-control",
          () => importTokensControl(services, req.body),
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/oauth/refresh",
      asyncRoute(async (req, res) => {
        const result = await refreshOauthControl(services, req.body);
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/oauth/gemini/start",
      asyncRoute(async (req, res) => {
        const result = await startGeminiLoginControl(services, req.body);
        res.status(result.status).json(result.body);
      }),
    );
    app.get(
      "/internal/control/oauth/gemini/status",
      asyncRoute(async (req, res) => {
        const result = getGeminiStatusControl(services, req.query);
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/oauth/gemini/manual-exchange",
      asyncRoute(async (req, res) => {
        const result = await runWithOnboardingFromHeaders(
          services,
          req,
          "internal-control",
          () => manualGeminiExchangeControl(services, req.body),
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/accounts/:accountId/settings",
      asyncRoute(async (req, res) => {
        const result = await updateAccountSettingsControl(
          services,
          getRouteParam(req.params.accountId),
          req.body,
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/accounts/:accountId/refresh",
      asyncRoute(async (req, res) => {
        const result = await refreshAccountControl(
          services,
          getRouteParam(req.params.accountId),
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/accounts/:accountId/ban",
      asyncRoute(async (req, res) => {
        const result = await banAccountControl(
          services,
          getRouteParam(req.params.accountId),
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/session-routes/clear",
      asyncRoute(async (_req, res) => {
        const result = await clearSessionRoutesControl(services);
        res.status(result.status).json(result.body);
      }),
    );
    app.get(
      "/internal/control/accounts/:accountId/ratelimit",
      asyncRoute(async (req, res) => {
        const result = await probeAccountRateLimitControl(
          services,
          getRouteParam(req.params.accountId),
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/proxies",
      asyncRoute(async (req, res) => {
        const result = await createProxyControl(services, req.body);
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/proxies/import",
      asyncRoute(async (req, res) => {
        const result = await importProxiesControl(services, req.body);
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/proxies/:proxyId/update",
      asyncRoute(async (req, res) => {
        const result = await updateProxyControl(
          services,
          getRouteParam(req.params.proxyId),
          req.body,
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/proxies/:proxyId/delete",
      asyncRoute(async (req, res) => {
        const result = await deleteProxyControl(
          services,
          getRouteParam(req.params.proxyId),
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/proxies/:proxyId/link",
      asyncRoute(async (req, res) => {
        const result = await linkProxyControl(
          services,
          getRouteParam(req.params.proxyId),
          req.body,
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/proxies/:proxyId/unlink",
      asyncRoute(async (req, res) => {
        const result = await unlinkProxyControl(services, req.body);
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/xray/sync",
      asyncRoute(async (req, res) => {
        const result = await syncManagedXrayConfig(services, {
          dryRun: Boolean(req.body?.dryRun),
          validate: Boolean(req.body?.validate),
          restart: Boolean(req.body?.restart),
        });
        res.json({ ok: true, result });
      }),
    );
    app.post(
      "/internal/control/users/:userId/api-keys",
      asyncRoute(async (req, res) => {
        const result = await createUserApiKeyControl(
          services,
          getRouteParam(req.params.userId),
          req.body,
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/users/:userId/api-keys/:keyId/groups",
      asyncRoute(async (req, res) => {
        const result = await updateUserApiKeyGroupsControl(
          services,
          getRouteParam(req.params.userId),
          getRouteParam(req.params.keyId),
          req.body,
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.delete(
      "/internal/control/users/:userId/api-keys/:keyId",
      asyncRoute(async (req, res) => {
        const result = await revokeUserApiKeyControl(
          services,
          getRouteParam(req.params.userId),
          getRouteParam(req.params.keyId),
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/users/:userId/update",
      asyncRoute(async (req, res) => {
        const result = await updateRelayUserControl(
          services,
          getRouteParam(req.params.userId),
          req.body,
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/users/:userId/delete",
      asyncRoute(async (req, res) => {
        const result = await deleteRelayUserControl(
          services,
          getRouteParam(req.params.userId),
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/users/:userId/regenerate-key",
      asyncRoute(async (req, res) => {
        const result = await regenerateRelayUserKeyControl(
          services,
          getRouteParam(req.params.userId),
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/ccwebapp/users/:relayUserId/topup",
      asyncRoute(async (req, res) => {
        const result = await topupRelayUserControl(
          services,
          getRouteParam(req.params.relayUserId),
          req.body,
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/billing/users/:userId/ledger",
      asyncRoute(async (req, res) => {
        const result = await createBillingLedgerControl(
          services,
          getRouteParam(req.params.userId),
          req.body,
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/billing/base-skus",
      asyncRoute(async (req, res) => {
        const result = await upsertBaseSkuControl(services, req.body);
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/billing/base-skus/:skuId/delete",
      asyncRoute(async (req, res) => {
        const result = await deleteBaseSkuControl(
          services,
          getRouteParam(req.params.skuId),
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/billing/channel-multipliers",
      asyncRoute(async (req, res) => {
        const result = await upsertChannelMultiplierControl(services, req.body);
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/billing/channel-multipliers/:multiplierId/delete",
      asyncRoute(async (req, res) => {
        const result = await deleteChannelMultiplierControl(
          services,
          getRouteParam(req.params.multiplierId),
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/billing/channel-multipliers/copy",
      asyncRoute(async (req, res) => {
        const result = await copyChannelMultipliersControl(services, req.body);
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/billing/channel-multipliers/bulk-adjust",
      asyncRoute(async (req, res) => {
        const result = await bulkAdjustChannelMultipliersControl(
          services,
          req.body,
        );
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/billing/sync",
      asyncRoute(async (req, res) => {
        const result = await syncBillingLineItemsControl(services, req.body);
        res.status(result.status).json(result.body);
      }),
    );
    app.post(
      "/internal/control/billing/rebuild",
      asyncRoute(async (_req, res) => {
        const result = await rebuildBillingLineItemsControl(services);
        res.status(result.status).json(result.body);
      }),
    );
  }
  if (serviceMode === "server" || serviceMode === "relay") {
    app.use("/admin", (req, res, next) => {
      if (!applyCorsHeaders(req, res, "GET, POST, PUT, DELETE, OPTIONS")) {
        if (req.method === "OPTIONS") {
          res.status(403).end();
          return;
        }
        res.status(403).json({
          error: "origin_not_allowed",
          message: "当前来源未被允许访问管理台",
        });
        return;
      }
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
      next();
    });

    // ── Internal API for cc-webapp ──
    app.use(
      "/internal/ccwebapp",
      requireInternalToken,
      express.json({ limit: "256kb" }),
    );

    app.post(
      "/internal/ccwebapp/users/sync",
      asyncRoute(async (req, res) => {
        if (!services.userStore) {
          res.status(503).json({ error: "user_management_disabled" });
          return;
        }
        const externalUserId = getNullableStringField(
          req.body,
          "externalUserId",
        );
        if (!externalUserId) {
          res
            .status(400)
            .json({
              error: "missing_external_user_id",
              message: "externalUserId is required",
            });
          return;
        }
        const displayName = getNullableStringField(req.body, "displayName");
        const email = getNullableStringField(req.body, "email");
        const fallbackName = displayName || email || externalUserId;
        const { user, created } =
          await services.userStore.findOrCreateByExternalId({
            externalUserId,
            name: fallbackName,
            billingCurrency: req.body?.billingCurrency ?? "CNY",
          });
        if (!created && displayName && user.name !== displayName) {
          const updated = await services.userStore.updateUser(user.id, {
            name: displayName,
          });
          if (updated) {
            res.json({
              created: false,
              user: { id: updated.id, username: updated.name },
            });
            return;
          }
        }
        res.json({
          created,
          user: { id: user.id, username: user.name },
        });
      }),
    );

    app.post(
      "/internal/ccwebapp/organizations/sync",
      asyncRoute(async (req, res) => {
        if (!services.organizationStore) {
          res.status(503).json({ error: "organization_management_disabled" });
          return;
        }
        const externalOrganizationId = getNullableStringField(
          req.body,
          "externalOrganizationId",
        );
        const slug = getNullableStringField(req.body, "slug");
        const name = getNullableStringField(req.body, "name");
        if (!externalOrganizationId || !slug || !name) {
          res
            .status(400)
            .json({
              error: "missing_organization_fields",
              message: "externalOrganizationId, slug and name are required",
            });
          return;
        }
        const organization = await services.organizationStore.syncOrganization({
          externalOrganizationId,
          slug,
          name,
          kind: req.body?.kind ?? (req.body?.isPersonal ? "personal" : "team"),
          billingMode: req.body?.billingMode ?? "prepaid",
          billingCurrency: req.body?.billingCurrency ?? "CNY",
          creditLimitMicros: req.body?.creditLimitMicros,
          isActive: req.body?.isActive,
        });
        res.json({
          organization: {
            id: organization.id,
            slug: organization.slug,
            name: organization.name,
            kind: organization.kind,
          },
        });
      }),
    );

    app.get(
      "/internal/ccwebapp/organizations/:relayOrgId/api-keys",
      asyncRoute(async (req, res) => {
        if (!services.organizationStore || !services.apiKeyStore) {
          res.status(503).json({ error: "api_key_management_disabled" });
          return;
        }
        const relayOrgId = getRouteParam(req.params.relayOrgId);
        const organization =
          await services.organizationStore.getOrganizationById(relayOrgId);
        if (!organization) {
          res.status(404).json({ error: "organization_not_found" });
          return;
        }
        const apiKeys =
          await services.apiKeyStore.listForOrganization(relayOrgId);
        res.json({ apiKeys, max: 100 });
      }),
    );

    app.post(
      "/internal/ccwebapp/organizations/:relayOrgId/api-keys",
      asyncRoute(async (req, res) => {
        if (!services.organizationStore || !services.apiKeyStore) {
          res.status(503).json({ error: "api_key_management_disabled" });
          return;
        }
        const relayOrgId = getRouteParam(req.params.relayOrgId);
        const organization =
          await services.organizationStore.getOrganizationById(relayOrgId);
        if (!organization) {
          res.status(404).json({ error: "organization_not_found" });
          return;
        }
        const rawName = typeof req.body?.name === "string" ? req.body.name : "";
        const groupAssignments = normalizeApiKeyGroupAssignments(
          req.body?.groupAssignments,
        );
        await validateApiKeyGroupAssignments(services, groupAssignments);
        try {
          const created = await services.apiKeyStore.createForOrganization(
            relayOrgId,
            { name: rawName, groupAssignments },
          );
          res.json({ created: true, ...created });
        } catch (err) {
          const code =
            err && typeof err === "object" && "code" in err
              ? String(err.code)
              : null;
          const message = err instanceof Error ? err.message : "create_failed";
          if (code === "api_key_quota_exceeded") {
            res.status(409).json({ error: code, message });
            return;
          }
          res.status(500).json({ error: "create_failed", message });
        }
      }),
    );

    app.post(
      "/internal/ccwebapp/organizations/:relayOrgId/api-keys/:keyId/groups",
      asyncRoute(async (req, res) => {
        if (!services.organizationStore || !services.apiKeyStore) {
          res.status(503).json({ error: "api_key_management_disabled" });
          return;
        }
        const relayOrgId = getRouteParam(req.params.relayOrgId);
        const keyId = getRouteParam(req.params.keyId);
        const organization =
          await services.organizationStore.getOrganizationById(relayOrgId);
        if (!organization) {
          res.status(404).json({ error: "organization_not_found" });
          return;
        }
        const groupAssignments = normalizeApiKeyGroupAssignments(
          req.body?.groupAssignments,
        );
        await validateApiKeyGroupAssignments(services, groupAssignments);
        const apiKey = await services.apiKeyStore.updateGroupsForOrganization(
          relayOrgId,
          keyId,
          groupAssignments,
        );
        if (!apiKey) {
          res.status(404).json({ error: "api_key_not_found" });
          return;
        }
        res.json({ ok: true, apiKey });
      }),
    );

    app.delete(
      "/internal/ccwebapp/organizations/:relayOrgId/api-keys/:keyId",
      asyncRoute(async (req, res) => {
        if (!services.organizationStore || !services.apiKeyStore) {
          res.status(503).json({ error: "api_key_management_disabled" });
          return;
        }
        const relayOrgId = getRouteParam(req.params.relayOrgId);
        const keyId = getRouteParam(req.params.keyId);
        const revoked = await services.apiKeyStore.revokeForOrganization(
          relayOrgId,
          keyId,
        );
        if (!revoked) {
          res.status(404).json({ error: "api_key_not_found" });
          return;
        }
        res.json({ revoked: true, apiKey: revoked });
      }),
    );

    app.get(
      "/internal/ccwebapp/organizations/:relayOrgId/summary",
      asyncRoute(async (req, res) => {
        if (!services.organizationStore) {
          res.status(503).json({ error: "organization_management_disabled" });
          return;
        }
        const relayOrgId = getRouteParam(req.params.relayOrgId);
        const organization =
          await services.organizationStore.getOrganizationById(relayOrgId);
        if (!organization) {
          res.status(404).json({ error: "organization_not_found" });
          return;
        }
        const balance = services.billingStore
          ? await services.billingStore.getOrganizationBalanceSummary(
              relayOrgId,
            )
          : null;
        const apiKeys = services.apiKeyStore
          ? await services.apiKeyStore.listForOrganization(relayOrgId)
          : [];
        const usage = services.billingStore
          ? await services.billingStore.getOrganizationUsageSnapshot(
              relayOrgId,
              new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
              1,
              0,
            )
          : null;
        res.json({
          organization: {
            id: organization.id,
            slug: organization.slug,
            name: organization.name,
            kind: organization.kind,
          },
          totals: {
            keyCount: apiKeys.length,
            requests: usage?.totalRequests ?? 0,
            inputTokens: usage?.totalInputTokens ?? 0,
            outputTokens: usage?.totalOutputTokens ?? 0,
            totalCost: usage ? Number(usage.totalAmountMicros) / 1_000_000 : 0,
          },
          apiKeys,
          balance: balance
            ? {
                balanceMicros: balance.balanceMicros,
                currency: balance.currency,
              }
            : null,
        });
      }),
    );

    app.get(
      "/internal/ccwebapp/organizations/:relayOrgId/usage",
      asyncRoute(async (req, res) => {
        if (!services.organizationStore || !services.billingStore) {
          res.status(503).json({ error: "billing_disabled" });
          return;
        }
        const relayOrgId = getRouteParam(req.params.relayOrgId);
        const organization =
          await services.organizationStore.getOrganizationById(relayOrgId);
        if (!organization) {
          res.status(404).json({ error: "organization_not_found" });
          return;
        }
        const { sinceParam, limitParam, offsetParam } = req.query as Record<
          string,
          string | undefined
        >;
        const sinceDate = sinceParam ? new Date(sinceParam) : null;
        const since =
          sinceDate && !Number.isNaN(sinceDate.getTime()) ? sinceDate : null;
        const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
        const offset = offsetParam ? Number.parseInt(offsetParam, 10) : 0;
        const snapshot =
          await services.billingStore.getOrganizationUsageSnapshot(
            relayOrgId,
            since,
            Number.isFinite(limit) ? limit : 50,
            Number.isFinite(offset) ? offset : 0,
          );
        res.json({ usage: snapshot });
      }),
    );

    app.post(
      "/internal/ccwebapp/organizations/:relayOrgId/topup",
      asyncRoute(async (req, res) => {
        if (!services.organizationStore || !services.billingStore) {
          res.status(503).json({ error: "billing_disabled" });
          return;
        }
        const relayOrgId = getRouteParam(req.params.relayOrgId);
        const organization =
          await services.organizationStore.getOrganizationById(relayOrgId);
        if (!organization) {
          res.status(404).json({ error: "organization_not_found" });
          return;
        }
        const amountMicros = req.body?.amountMicros;
        if (amountMicros === undefined || amountMicros === null) {
          res
            .status(400)
            .json({
              error: "missing_amount",
              message: "amountMicros is required",
            });
          return;
        }
        const billingCurrency = getOptionalBillingCurrency(
          req.body?.currency,
          "currency",
        );
        if (
          billingCurrency &&
          organization.billingCurrency !== billingCurrency
        ) {
          try {
            await services.billingStore.changeOrganizationBillingCurrency(
              relayOrgId,
              billingCurrency,
            );
          } catch (error) {
            res.status(400).json({
              error: "billing_currency_mismatch",
              message: sanitizeErrorMessage(error),
            });
            return;
          }
        }
        try {
          const result =
            await services.billingStore.createOrganizationLedgerEntry({
              organizationId: relayOrgId,
              kind: "topup",
              amountMicros,
              note: getNullableStringField(req.body, "note"),
              externalRef: getNullableStringField(req.body, "idempotencyKey"),
            });
          res.json({
            ok: true,
            idempotent: result.idempotent === true,
            entry: result.entry,
            balance: result.balance,
          });
        } catch (error) {
          if (error instanceof InputValidationError) {
            res
              .status(400)
              .json({ error: "invalid_topup", message: error.message });
            return;
          }
          throw error;
        }
      }),
    );

    app.get(
      "/internal/ccwebapp/organizations/:relayOrgId/support/tickets",
      asyncRoute(async (req, res) => {
        if (!services.organizationStore || !services.supportStore) {
          res.status(503).json({ error: "support_disabled" });
          return;
        }
        const relayOrgId = getRouteParam(req.params.relayOrgId);
        const organization =
          await services.organizationStore.getOrganizationById(relayOrgId);
        if (!organization) {
          res.status(404).json({ error: "organization_not_found" });
          return;
        }
        const tickets =
          await services.supportStore.listTicketsForOrganization(relayOrgId);
        res.json({ tickets });
      }),
    );

    app.post(
      "/internal/ccwebapp/organizations/:relayOrgId/support/tickets",
      asyncRoute(async (req, res) => {
        if (!services.organizationStore || !services.supportStore) {
          res.status(503).json({ error: "support_disabled" });
          return;
        }
        const relayOrgId = getRouteParam(req.params.relayOrgId);
        const organization =
          await services.organizationStore.getOrganizationById(relayOrgId);
        if (!organization) {
          res.status(404).json({ error: "organization_not_found" });
          return;
        }
        const body = req.body ?? {};
        try {
          const result = await services.supportStore.createTicket({
            userId: null,
            organizationId: relayOrgId,
            userName:
              typeof body.userName === "string"
                ? body.userName
                : organization.name,
            userEmail:
              typeof body.userEmail === "string" ? body.userEmail : null,
            category: body.category,
            title: typeof body.title === "string" ? body.title : "",
            description:
              typeof body.description === "string" ? body.description : "",
            relatedApiKeyId:
              typeof body.relatedApiKeyId === "string"
                ? body.relatedApiKeyId
                : null,
          });
          res.json({
            ok: true,
            ticket: result.ticket,
            firstMessage: result.firstMessage,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "create_ticket_failed";
          res.status(400).json({ error: "create_ticket_failed", message });
        }
      }),
    );

    app.get(
      "/internal/ccwebapp/organizations/:relayOrgId/support/tickets/:ticketId",
      asyncRoute(async (req, res) => {
        if (!services.organizationStore || !services.supportStore) {
          res.status(503).json({ error: "support_disabled" });
          return;
        }
        const relayOrgId = getRouteParam(req.params.relayOrgId);
        const ticketId = getRouteParam(req.params.ticketId);
        const ticket = await services.supportStore.getTicket(ticketId);
        if (!ticket || ticket.organizationId !== relayOrgId) {
          res.status(404).json({ error: "ticket_not_found" });
          return;
        }
        const messages =
          await services.supportStore.listMessagesForTicket(ticketId);
        res.json({ ticket, messages });
      }),
    );

    app.post(
      "/internal/ccwebapp/organizations/:relayOrgId/support/tickets/:ticketId/messages",
      asyncRoute(async (req, res) => {
        if (!services.organizationStore || !services.supportStore) {
          res.status(503).json({ error: "support_disabled" });
          return;
        }
        const relayOrgId = getRouteParam(req.params.relayOrgId);
        const ticketId = getRouteParam(req.params.ticketId);
        const ticket = await services.supportStore.getTicket(ticketId);
        if (!ticket || ticket.organizationId !== relayOrgId) {
          res.status(404).json({ error: "ticket_not_found" });
          return;
        }
        const body = req.body ?? {};
        try {
          const message = await services.supportStore.appendMessage({
            ticketId,
            authorKind: "user",
            authorId: relayOrgId,
            authorName: ticket.userName ?? null,
            body: typeof body.body === "string" ? body.body : "",
          });
          const refreshed = await services.supportStore.getTicket(ticketId);
          res.json({ ok: true, message, ticket: refreshed });
        } catch (error) {
          const m = error instanceof Error ? error.message : "append_failed";
          const status = m === "ticket_closed" ? 409 : 400;
          res.status(status).json({ error: m });
        }
      }),
    );

    app.post(
      "/internal/ccwebapp/organizations/:relayOrgId/support/tickets/:ticketId/close",
      asyncRoute(async (req, res) => {
        if (!services.organizationStore || !services.supportStore) {
          res.status(503).json({ error: "support_disabled" });
          return;
        }
        const relayOrgId = getRouteParam(req.params.relayOrgId);
        const ticketId = getRouteParam(req.params.ticketId);
        const ticket = await services.supportStore.getTicket(ticketId);
        if (!ticket || ticket.organizationId !== relayOrgId) {
          res.status(404).json({ error: "ticket_not_found" });
          return;
        }
        const closed = await services.supportStore.setTicketStatus(
          ticketId,
          "closed",
        );
        res.json({ ok: true, ticket: closed });
      }),
    );

    app.get(
      "/internal/ccwebapp/users/:relayUserId/api-keys",
      asyncRoute(async (req, res) => {
        if (!services.userStore || !services.apiKeyStore) {
          res.status(503).json({ error: "api_key_management_disabled" });
          return;
        }
        const relayUserId = getRouteParam(req.params.relayUserId);
        const user = await services.userStore.getUserById(relayUserId);
        if (!user) {
          res.status(404).json({ error: "user_not_found" });
          return;
        }
        const apiKeys = await services.apiKeyStore.listForUser(relayUserId);
        res.json({ apiKeys, max: 100 });
      }),
    );

    app.post(
      "/internal/ccwebapp/users/:relayUserId/api-keys",
      asyncRoute(async (req, res) => {
        if (!services.userStore || !services.apiKeyStore) {
          res.status(503).json({ error: "api_key_management_disabled" });
          return;
        }
        const relayUserId = getRouteParam(req.params.relayUserId);
        const user = await services.userStore.getUserById(relayUserId);
        if (!user) {
          res.status(404).json({ error: "user_not_found" });
          return;
        }
        const rawName = typeof req.body?.name === "string" ? req.body.name : "";
        const groupAssignments = normalizeApiKeyGroupAssignments(
          req.body?.groupAssignments,
        );
        await validateApiKeyGroupAssignments(services, groupAssignments);
        try {
          const created = await services.apiKeyStore.create(relayUserId, {
            name: rawName,
            groupAssignments,
          });
          res.json({ created: true, ...created });
        } catch (err) {
          const code =
            err && typeof err === "object" && "code" in err
              ? String(err.code)
              : null;
          const message = err instanceof Error ? err.message : "create_failed";
          if (code === "api_key_quota_exceeded") {
            res.status(409).json({ error: code, message });
            return;
          }
          res.status(500).json({ error: "create_failed", message });
        }
      }),
    );

    app.post(
      "/internal/ccwebapp/users/:relayUserId/api-keys/:keyId/groups",
      asyncRoute(async (req, res) => {
        if (!services.userStore || !services.apiKeyStore) {
          res.status(503).json({ error: "api_key_management_disabled" });
          return;
        }
        const relayUserId = getRouteParam(req.params.relayUserId);
        const keyId = getRouteParam(req.params.keyId);
        const user = await services.userStore.getUserById(relayUserId);
        if (!user) {
          res.status(404).json({ error: "user_not_found" });
          return;
        }
        const groupAssignments = normalizeApiKeyGroupAssignments(
          req.body?.groupAssignments,
        );
        await validateApiKeyGroupAssignments(services, groupAssignments);
        const apiKey = await services.apiKeyStore.updateGroups(
          relayUserId,
          keyId,
          groupAssignments,
        );
        if (!apiKey) {
          res.status(404).json({ error: "api_key_not_found" });
          return;
        }
        res.json({ ok: true, apiKey });
      }),
    );

    app.get(
      "/internal/ccwebapp/routing-groups",
      asyncRoute(async (_req, res) => {
        const groups = await services.oauthService.listRoutingGroups();
        res.json({
          routingGroups: groups
            .filter((group) => group.isActive)
            .map((group) => ({
              id: group.id,
              name: group.name,
              description: group.description,
              descriptionZh: group.descriptionZh,
              type: group.type,
            })),
        });
      }),
    );

    app.delete(
      "/internal/ccwebapp/users/:relayUserId/api-keys/:keyId",
      asyncRoute(async (req, res) => {
        if (!services.userStore || !services.apiKeyStore) {
          res.status(503).json({ error: "api_key_management_disabled" });
          return;
        }
        const relayUserId = getRouteParam(req.params.relayUserId);
        const keyId = getRouteParam(req.params.keyId);
        const revoked = await services.apiKeyStore.revoke(relayUserId, keyId);
        if (!revoked) {
          res.status(404).json({ error: "api_key_not_found" });
          return;
        }
        res.json({ revoked: true, apiKey: revoked });
      }),
    );

    app.get(
      "/internal/ccwebapp/users/:relayUserId/summary",
      asyncRoute(async (req, res) => {
        if (!services.userStore) {
          res.status(503).json({ error: "user_management_disabled" });
          return;
        }
        const relayUserId = getRouteParam(req.params.relayUserId);
        const user = await services.userStore.getUserById(relayUserId);
        if (!user) {
          res.status(404).json({ error: "user_not_found" });
          return;
        }
        const balance = services.billingStore
          ? await services.billingStore.getUserBalanceSummary(relayUserId)
          : null;
        const usage = await services.userStore.getUserRequests(
          relayUserId,
          1,
          0,
        );
        const apiKeys = services.apiKeyStore
          ? await services.apiKeyStore.listForUser(relayUserId)
          : [];
        const totals = {
          keyCount: apiKeys.length,
          requests: usage.total ?? 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
        };
        res.json({
          user: { id: user.id, username: user.name },
          totals,
          apiKeys,
          balance: balance
            ? {
                balanceMicros: balance.balanceMicros,
                currency: balance.currency,
              }
            : null,
        });
      }),
    );

    app.get(
      "/internal/ccwebapp/users/:relayUserId/usage",
      asyncRoute(async (req, res) => {
        if (!services.userStore || !services.billingStore) {
          res.status(503).json({ error: "billing_disabled" });
          return;
        }
        const relayUserId = getRouteParam(req.params.relayUserId);
        const user = await services.userStore.getUserById(relayUserId);
        if (!user) {
          res.status(404).json({ error: "user_not_found" });
          return;
        }
        const { sinceParam, limitParam, offsetParam } = req.query as Record<
          string,
          string | undefined
        >;
        const sinceDate = sinceParam ? new Date(sinceParam) : null;
        const since =
          sinceDate && !Number.isNaN(sinceDate.getTime()) ? sinceDate : null;
        const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
        const offset = offsetParam ? Number.parseInt(offsetParam, 10) : 0;
        const snapshot = await services.billingStore.getUserUsageSnapshot(
          relayUserId,
          since,
          Number.isFinite(limit) ? limit : 50,
          Number.isFinite(offset) ? offset : 0,
        );
        res.json({ usage: snapshot });
      }),
    );

    app.get(
      "/internal/ccwebapp/price-rules",
      asyncRoute(async (req, res) => {
        if (!services.billingStore) {
          res.status(503).json({ error: "billing_disabled" });
          return;
        }
        const currencyParam =
          typeof req.query?.currency === "string" ? req.query.currency : null;
        const skus = await services.billingStore.listBaseSkus();
        const sanitized = skus
          .filter(
            (sku) =>
              sku.isActive &&
              (!currencyParam || sku.currency === currencyParam),
          )
          .map((sku) => ({
            id: sku.id,
            name: sku.displayName,
            priority: 0,
            currency: sku.currency,
            model: sku.model,
            isFallback: false,
            effectiveFrom: sku.createdAt,
            effectiveTo: null,
            inputPriceMicrosPerMillion: sku.inputPriceMicrosPerMillion,
            outputPriceMicrosPerMillion: sku.outputPriceMicrosPerMillion,
            cacheCreationPriceMicrosPerMillion:
              sku.cacheCreationPriceMicrosPerMillion,
            cacheReadPriceMicrosPerMillion: sku.cacheReadPriceMicrosPerMillion,
          }));
        res.json({ rules: sanitized });
      }),
    );

    app.get(
      "/internal/ccwebapp/models",
      asyncRoute(async (_req, res) => {
        if (!services.billingStore) {
          res.status(503).json({ error: "billing_disabled" });
          return;
        }
        const [baseSkus, channelMultipliers, allRoutingGroups] =
          await Promise.all([
            services.billingStore.listBaseSkus(),
            services.billingStore.listChannelMultipliers(),
            services.oauthService.listRoutingGroups(),
          ]);
        const activeRoutingGroupIds = new Set(
          allRoutingGroups
            .filter((group) => group.isActive)
            .map((group) => group.id),
        );
        const baseByKey = new Map(
          baseSkus
            .filter((s) => s.isActive)
            .map((s) => [
              `${s.protocol}|${s.modelVendor}|${s.model}|${s.currency}`,
              s,
            ]),
        );
        const models = channelMultipliers
          .filter(
            (m) =>
              m.isActive &&
              m.showInFrontend &&
              activeRoutingGroupIds.has(m.routingGroupId),
          )
          .flatMap((m) => {
            const matched = ["USD", "CNY"]
              .map((cur) =>
                baseByKey.get(
                  `${m.protocol}|${m.modelVendor}|${m.model}|${cur}`,
                ),
              )
              .filter((b) => b != null);
            return matched.map((base) => ({
              id: `${m.id}|${base!.currency}`,
              provider: m.provider,
              modelVendor: m.modelVendor,
              protocol: m.protocol,
              model: m.model,
              displayName: base!.displayName,
              routingGroupId: m.routingGroupId,
              isActive: true,
              showInFrontend: true,
              allowCalls: m.allowCalls,
              supportsPromptCaching: base!.supportsPromptCaching,
              currency: base!.currency,
              inputPriceMicrosPerMillion: applyMultiplierString(
                base!.inputPriceMicrosPerMillion,
                m.multiplierMicros,
              ),
              outputPriceMicrosPerMillion: applyMultiplierString(
                base!.outputPriceMicrosPerMillion,
                m.multiplierMicros,
              ),
              cacheCreationPriceMicrosPerMillion: applyMultiplierString(
                base!.cacheCreationPriceMicrosPerMillion,
                m.multiplierMicros,
              ),
              cacheReadPriceMicrosPerMillion: applyMultiplierString(
                base!.cacheReadPriceMicrosPerMillion,
                m.multiplierMicros,
              ),
            }));
          });
        const routingGroups = allRoutingGroups
          .filter((group) => group.isActive)
          .map((group) => ({
            id: group.id,
            name: group.name,
            description: group.description,
            descriptionZh: group.descriptionZh,
            type: group.type,
          }));
        res.json({ models, routingGroups });
      }),
    );

    app.get(
      "/internal/ccwebapp/status",
      asyncRoute(async (_req, res) => {
        if (!services.billingStore) {
          res.status(503).json({ error: "billing_disabled" });
          return;
        }
        const cached = readChannelStatusCache();
        if (cached) {
          res.json(cached);
          return;
        }
        const [
          stats,
          allRoutingGroups,
          allAccounts,
          allMultipliers,
          allBaseSkus,
        ] = await Promise.all([
          services.billingStore.getChannelUsageStats(),
          services.oauthService.listRoutingGroups(),
          services.oauthService.listAccounts(),
          services.billingStore.listChannelMultipliers(),
          services.billingStore.listBaseSkus(),
        ]);

        const generatedAt = new Date().toISOString();
        const groupsById = new Map(
          allRoutingGroups.filter((g) => g.isActive).map((g) => [g.id, g]),
        );
        const accountsByGroup = new Map<string, typeof allAccounts>();
        for (const account of allAccounts) {
          const groupId = account.routingGroupId ?? account.group ?? "";
          if (!groupId) continue;
          const list = accountsByGroup.get(groupId) ?? [];
          list.push(account);
          accountsByGroup.set(groupId, list);
        }
        const baseByKey = new Map(
          allBaseSkus
            .filter((b) => b.isActive)
            .map((b) => [`${b.protocol}|${b.modelVendor}|${b.model}`, b]),
        );
        const skuByGroup = new Map<
          string,
          Array<{
            provider: string;
            modelVendor: string;
            protocol: string;
            model: string;
            displayName: string;
          }>
        >();
        for (const m of allMultipliers) {
          if (!m.isActive) continue;
          const base = baseByKey.get(
            `${m.protocol}|${m.modelVendor}|${m.model}`,
          );
          if (!base) continue;
          const list = skuByGroup.get(m.routingGroupId) ?? [];
          list.push({
            provider: m.provider,
            modelVendor: m.modelVendor,
            protocol: m.protocol,
            model: m.model,
            displayName: base.displayName,
          });
          skuByGroup.set(m.routingGroupId, list);
        }

        const nowMs = Date.now();
        const channels = Array.from(groupsById.values()).map((group) => {
          const accounts = accountsByGroup.get(group.id) ?? [];
          const accountSummary = {
            enabled: 0,
            paused: 0,
            autoBlocked: 0,
            cooldown: 0,
            total: accounts.length,
          };
          for (const account of accounts) {
            if (account.cooldownUntil && account.cooldownUntil > nowMs) {
              accountSummary.cooldown += 1;
              continue;
            }
            if (account.schedulerState === "paused") accountSummary.paused += 1;
            else if (account.schedulerState === "auto_blocked")
              accountSummary.autoBlocked += 1;
            else if (
              account.schedulerState === "enabled" &&
              account.schedulerEnabled
            ) {
              accountSummary.enabled += 1;
            }
          }
          const windows = stats.windows.get(group.id) ?? {
            last5m: {
              totalRequests: 0,
              successRequests: 0,
              successRate: null,
              p50Ms: null,
              p99Ms: null,
            },
            last1h: {
              totalRequests: 0,
              successRequests: 0,
              successRate: null,
              p50Ms: null,
              p99Ms: null,
            },
            last24h: {
              totalRequests: 0,
              successRequests: 0,
              successRate: null,
              p50Ms: null,
              p99Ms: null,
            },
          };
          const history = stats.history.get(group.id) ?? [];
          const lastVerified = stats.lastVerified.get(group.id) ?? null;
          const overallStatus = deriveOverallStatus(
            windows.last1h,
            accountSummary,
          );
          return {
            routingGroupId: group.id,
            name: group.name,
            description: group.description,
            descriptionZh: group.descriptionZh,
            type: group.type,
            models: skuByGroup.get(group.id) ?? [],
            accountSummary,
            windows,
            history,
            lastVerified,
            overallStatus,
          };
        });
        const payload = { channels, generatedAt };
        writeChannelStatusCache(payload);
        res.json(payload);
      }),
    );

    app.get(
      "/internal/ccwebapp/users/:relayUserId/support/tickets",
      asyncRoute(async (req, res) => {
        if (!services.userStore || !services.supportStore) {
          res.status(503).json({ error: "support_disabled" });
          return;
        }
        const relayUserId = getRouteParam(req.params.relayUserId);
        const user = await services.userStore.getUserById(relayUserId);
        if (!user) {
          res.status(404).json({ error: "user_not_found" });
          return;
        }
        const tickets =
          await services.supportStore.listTicketsForUser(relayUserId);
        res.json({ tickets });
      }),
    );

    app.post(
      "/internal/ccwebapp/users/:relayUserId/support/tickets",
      asyncRoute(async (req, res) => {
        if (!services.userStore || !services.supportStore) {
          res.status(503).json({ error: "support_disabled" });
          return;
        }
        const relayUserId = getRouteParam(req.params.relayUserId);
        const user = await services.userStore.getUserById(relayUserId);
        if (!user) {
          res.status(404).json({ error: "user_not_found" });
          return;
        }
        const body = req.body ?? {};
        try {
          const result = await services.supportStore.createTicket({
            userId: relayUserId,
            userName:
              typeof body.userName === "string"
                ? body.userName
                : (user.name ?? null),
            userEmail:
              typeof body.userEmail === "string" ? body.userEmail : null,
            category: body.category,
            title: typeof body.title === "string" ? body.title : "",
            description:
              typeof body.description === "string" ? body.description : "",
            relatedApiKeyId:
              typeof body.relatedApiKeyId === "string"
                ? body.relatedApiKeyId
                : null,
          });
          res.json({
            ok: true,
            ticket: result.ticket,
            firstMessage: result.firstMessage,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "create_ticket_failed";
          res.status(400).json({ error: "create_ticket_failed", message });
        }
      }),
    );

    app.get(
      "/internal/ccwebapp/users/:relayUserId/support/tickets/:ticketId",
      asyncRoute(async (req, res) => {
        if (!services.userStore || !services.supportStore) {
          res.status(503).json({ error: "support_disabled" });
          return;
        }
        const relayUserId = getRouteParam(req.params.relayUserId);
        const ticketId = getRouteParam(req.params.ticketId);
        const ticket = await services.supportStore.getTicket(ticketId);
        if (!ticket || ticket.userId !== relayUserId) {
          res.status(404).json({ error: "ticket_not_found" });
          return;
        }
        const messages =
          await services.supportStore.listMessagesForTicket(ticketId);
        res.json({ ticket, messages });
      }),
    );

    app.post(
      "/internal/ccwebapp/users/:relayUserId/support/tickets/:ticketId/messages",
      asyncRoute(async (req, res) => {
        if (!services.userStore || !services.supportStore) {
          res.status(503).json({ error: "support_disabled" });
          return;
        }
        const relayUserId = getRouteParam(req.params.relayUserId);
        const ticketId = getRouteParam(req.params.ticketId);
        const ticket = await services.supportStore.getTicket(ticketId);
        if (!ticket || ticket.userId !== relayUserId) {
          res.status(404).json({ error: "ticket_not_found" });
          return;
        }
        const body = req.body ?? {};
        try {
          const message = await services.supportStore.appendMessage({
            ticketId,
            authorKind: "user",
            authorId: relayUserId,
            authorName: ticket.userName ?? null,
            body: typeof body.body === "string" ? body.body : "",
          });
          const refreshed = await services.supportStore.getTicket(ticketId);
          res.json({ ok: true, message, ticket: refreshed });
        } catch (error) {
          const m = error instanceof Error ? error.message : "append_failed";
          const status = m === "ticket_closed" ? 409 : 400;
          res.status(status).json({ error: m });
        }
      }),
    );

    app.post(
      "/internal/ccwebapp/users/:relayUserId/support/tickets/:ticketId/close",
      asyncRoute(async (req, res) => {
        if (!services.userStore || !services.supportStore) {
          res.status(503).json({ error: "support_disabled" });
          return;
        }
        const relayUserId = getRouteParam(req.params.relayUserId);
        const ticketId = getRouteParam(req.params.ticketId);
        const ticket = await services.supportStore.getTicket(ticketId);
        if (!ticket || ticket.userId !== relayUserId) {
          res.status(404).json({ error: "ticket_not_found" });
          return;
        }
        const updated = await services.supportStore.setTicketStatus(
          ticketId,
          "closed",
        );
        res.json({ ok: true, ticket: updated });
      }),
    );

    app.post(
      "/internal/ccwebapp/users/:relayUserId/topup",
      asyncRoute(async (req, res) => {
        if (serviceMode === "relay") {
          const result = await topupRelayUserControl(
            services,
            getRouteParam(req.params.relayUserId),
            req.body,
          );
          res.status(result.status).json(result.body);
          return;
        }
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: `/internal/control/ccwebapp/users/${encodeURIComponent(getRouteParam(req.params.relayUserId))}/topup`,
          body: req.body,
        });
      }),
    );

    app.get(
      "/internal/ccwebapp/ledger/by-external-ref/:externalRef",
      asyncRoute(async (req, res) => {
        if (!services.billingStore) {
          res.status(503).json({ error: "billing_disabled" });
          return;
        }
        const externalRef = decodeURIComponent(
          getRouteParam(req.params.externalRef),
        );
        const { entry, multipleMatches } =
          await services.billingStore.findLedgerByExternalRef(externalRef);
        res.json({ found: entry !== null, entry, multipleMatches });
      }),
    );

    app.post(
      "/admin/session/exchange",
      asyncRoute(async (req, res) => {
        const keycloakAccessToken = extractBearerToken(req);
        if (!keycloakAccessToken) {
          res.status(401).json({
            error: "missing_access_token",
            message: "缺少 Keycloak access token",
          });
          return;
        }
        const session = await exchangeAdminSession(req, keycloakAccessToken);
        res.setHeader("Set-Cookie", session.cookie);
        res.json({
          ok: true,
          user: session.user,
          csrfToken: session.csrfToken,
        });
      }),
    );
    app.get(
      "/admin/session/me",
      asyncRoute(async (req, res) => {
        const session = getAdminSession(req);
        if (!session) {
          res.status(401).json({
            error: "admin_session_missing",
            message: "当前管理台会话不存在或已过期",
          });
          return;
        }
        res.json({
          ok: true,
          user: session.user,
          csrfToken: session.csrfToken,
        });
      }),
    );
    app.post(
      "/admin/session/logout",
      asyncRoute(async (req, res) => {
        res.setHeader("Set-Cookie", buildAdminSessionLogoutCookie(req));
        res.json({ ok: true });
      }),
    );
    app.use("/admin", requireAdminToken, express.json({ limit: "1mb" }));

    app.get(
      "/admin/better-auth/get-session",
      asyncRoute(async (_req, res) => {
        res.json({
          session: { userId: "ccdash-internal-admin" },
          user: {
            id: "ccdash-internal-admin",
            email: appConfig.betterAuthAdminEmail,
            name: "ccdash internal admin",
            role: "admin",
            emailVerified: true,
          },
        });
      }),
    );
    app.get(
      "/admin/better-auth/admin/list-users",
      asyncRoute(async (req, res) => {
        const result = await requestBetterAuthInternal(
          "/admin/list-users",
          req.query,
        );
        res.status(result.status).json(result.data);
      }),
    );
    app.get(
      "/admin/better-auth/organization/list",
      asyncRoute(async (req, res) => {
        const result = await requestBetterAuthInternal(
          "/organization/list",
          req.query,
        );
        res.status(result.status).json(result.data);
      }),
    );
    app.get(
      "/admin/better-auth/organization/list-members",
      asyncRoute(async (req, res) => {
        const result = await requestBetterAuthInternal(
          "/organization/list-members",
          req.query,
        );
        res.status(result.status).json(result.data);
      }),
    );
    app.get(
      "/admin/better-auth/users",
      asyncRoute(async (_req, res) => {
        res.json(await buildBetterAuthUsersOverview(services));
      }),
    );
    app.post(
      "/admin/better-auth/users",
      asyncRoute(async (req, res) => {
        const email = getOptionalString(req.body?.email);
        const name = getOptionalString(req.body?.name);
        if (!email || !name) {
          res
            .status(400)
            .json({
              error: "missing_user_fields",
              message: "email and name are required",
            });
          return;
        }
        const createResult = await requestBetterAuthInternal(
          "/admin/create-user",
          {},
          {
            method: "POST",
            body: {
              email,
              name,
              password: getOptionalString(req.body?.password),
              role: getOptionalString(req.body?.role) ?? "user",
              data:
                req.body?.data && typeof req.body.data === "object"
                  ? req.body.data
                  : {},
            },
          },
        );
        if (!createResult.ok) {
          res.status(createResult.status).json(createResult.data);
          return;
        }
        const user = getBetterAuthUserPayload(createResult.data);
        const organizationId = getOptionalString(req.body?.organizationId);
        const relayOrganizations = [];
        const warnings = [];
        if (organizationId && user?.id) {
          const addMemberOutcome = await captureFollowupResult(
            `add Better Auth user ${user.id} to organization ${organizationId}`,
            async () => {
              const addMember = await requestBetterAuthInternal(
                "/organization/add-member",
                {},
                {
                  method: "POST",
                  body: {
                    userId: user.id,
                    organizationId,
                    role: getOptionalString(req.body?.memberRole) ?? "member",
                  },
                },
              );
              if (!addMember.ok && addMember.status !== 400) {
                throw new BetterAuthRequestError(
                  addMember.status,
                  addMember.data,
                  `Better Auth add member failed: HTTP ${addMember.status}`,
                );
              }
            },
          );
          if (addMemberOutcome.warning) {
            warnings.push(addMemberOutcome.warning);
          }
          const organizationOutcome = await captureFollowupResult(
            `load Better Auth organization ${organizationId} for relay sync`,
            async () =>
              (await listBetterAuthOrganizationsInternal()).find(
                (item) => String(item.id ?? "") === organizationId,
              ) ?? null,
            null,
          );
          if (organizationOutcome.warning) {
            warnings.push(organizationOutcome.warning);
          }
          if (organizationOutcome.value) {
            relayOrganizations.push(organizationOutcome.value);
          }
        }
        const relaySyncOutcome = await captureFollowupResult(
          `sync relay user after Better Auth create ${user?.id ?? email}`,
          async () =>
            ensureRelayUserForBetterAuthUser(
              services,
              user,
              relayOrganizations,
            ),
        );
        if (relaySyncOutcome.warning) {
          warnings.push(relaySyncOutcome.warning);
        }
        res.json(appendWarningsToResponseBody({ ok: true, user }, warnings));
      }),
    );
    app.post(
      "/admin/better-auth/users/:userId/update",
      asyncRoute(async (req, res) => {
        const userId = getRouteParam(req.params.userId);
        const data = {};
        if (req.body?.name !== undefined) data.name = req.body.name;
        if (req.body?.email !== undefined) data.email = req.body.email;
        if (req.body?.role !== undefined) data.role = req.body.role;
        if (req.body?.banned !== undefined)
          data.banned = Boolean(req.body.banned);
        if (req.body?.banReason !== undefined)
          data.banReason = req.body.banReason;
        const result = await requestBetterAuthInternal(
          "/admin/update-user",
          {},
          {
            method: "POST",
            body: { userId, data },
          },
        );
        const warnings = [];
        if (result.ok) {
          const syncOutcome = await captureFollowupResult(
            `sync relay user after Better Auth update ${userId}`,
            async () =>
              syncBetterAuthUserToRelayUser(
                services,
                getBetterAuthUserPayload(result.data),
              ),
          );
          if (syncOutcome.warning) {
            warnings.push(syncOutcome.warning);
          }
        }
        res
          .status(result.status)
          .json(appendWarningsToResponseBody(result.data, warnings));
      }),
    );
    app.post(
      "/admin/better-auth/users/:userId/delete",
      asyncRoute(async (req, res) => {
        const userId = getRouteParam(req.params.userId);
        const result = await requestBetterAuthInternal(
          "/admin/remove-user",
          {},
          {
            method: "POST",
            body: { userId },
          },
        );
        const warnings = [];
        if (result.ok) {
          const deleteRelayOutcome = await captureFollowupResult(
            `delete relay user after Better Auth delete ${userId}`,
            async () => deleteRelayUserForBetterAuthUser(services, userId),
          );
          if (deleteRelayOutcome.warning) {
            warnings.push(deleteRelayOutcome.warning);
          }
        }
        res
          .status(result.status)
          .json(appendWarningsToResponseBody(result.data, warnings));
      }),
    );
    app.post(
      "/admin/better-auth/users/:userId/ban",
      asyncRoute(async (req, res) => {
        const userId = getRouteParam(req.params.userId);
        const result = await requestBetterAuthInternal(
          "/admin/ban-user",
          {},
          {
            method: "POST",
            body: {
              userId,
              banReason:
                getOptionalString(req.body?.banReason) ??
                "Disabled from ccdash",
            },
          },
        );
        const warnings = [];
        if (result.ok) {
          const syncOutcome = await captureFollowupResult(
            `sync relay user after Better Auth ban ${userId}`,
            async () =>
              syncBetterAuthUserToRelayUser(services, {
                id: userId,
                banned: true,
              }),
          );
          if (syncOutcome.warning) {
            warnings.push(syncOutcome.warning);
          }
        }
        res
          .status(result.status)
          .json(appendWarningsToResponseBody(result.data, warnings));
      }),
    );
    app.post(
      "/admin/better-auth/users/:userId/unban",
      asyncRoute(async (req, res) => {
        const userId = getRouteParam(req.params.userId);
        const result = await requestBetterAuthInternal(
          "/admin/unban-user",
          {},
          {
            method: "POST",
            body: { userId },
          },
        );
        const warnings = [];
        if (result.ok) {
          const syncOutcome = await captureFollowupResult(
            `sync relay user after Better Auth unban ${userId}`,
            async () =>
              syncBetterAuthUserToRelayUser(services, {
                id: userId,
                banned: false,
              }),
          );
          if (syncOutcome.warning) {
            warnings.push(syncOutcome.warning);
          }
        }
        res
          .status(result.status)
          .json(appendWarningsToResponseBody(result.data, warnings));
      }),
    );
    app.post(
      "/admin/better-auth/organizations",
      asyncRoute(async (req, res) => {
        const name = getOptionalString(req.body?.name);
        const slug = getOptionalString(req.body?.slug) ?? makeOrgSlug(name);
        if (!name || !slug) {
          res
            .status(400)
            .json({
              error: "missing_organization_fields",
              message: "name is required",
            });
          return;
        }
        const result = await requestBetterAuthInternal(
          "/organization/create",
          {},
          {
            method: "POST",
            body: {
              name,
              slug,
              metadata: {
                ...(req.body?.metadata && typeof req.body.metadata === "object"
                  ? req.body.metadata
                  : {}),
                relayOrgId:
                  getOptionalString(req.body?.metadata?.relayOrgId) ?? slug,
              },
            },
          },
        );
        res.status(result.status).json(result.data);
      }),
    );
    app.post(
      "/admin/better-auth/organizations/:organizationId/update",
      asyncRoute(async (req, res) => {
        const organizationId = getRouteParam(req.params.organizationId);
        const previousOrganization = await runBestEffortSideEffect(
          `load Better Auth organization ${organizationId} before update`,
          async () =>
            (await listBetterAuthOrganizationsInternal()).find(
              (organization) =>
                String(organization.id ?? "") === organizationId,
            ) ?? null,
          null,
        );
        const data = {};
        if (req.body?.name !== undefined) data.name = req.body.name;
        if (req.body?.slug !== undefined) data.slug = req.body.slug;
        if (req.body?.logo !== undefined) data.logo = req.body.logo;
        if (req.body?.metadata !== undefined) data.metadata = req.body.metadata;
        if (
          data.metadata === undefined &&
          (data.slug !== undefined || data.name !== undefined)
        ) {
          const relayOrgId =
            getOptionalString(data.slug) ??
            resolveRelayOrgIdFromBetterAuthOrganization(previousOrganization);
          if (relayOrgId) {
            data.metadata = {
              ...(previousOrganization?.metadata &&
              typeof previousOrganization.metadata === "object"
                ? previousOrganization.metadata
                : {}),
              relayOrgId,
            };
          }
        }
        const result = await requestBetterAuthInternal(
          "/organization/update",
          {},
          {
            method: "POST",
            body: { organizationId, data },
          },
        );
        const warnings = [];
        if (result.ok) {
          const syncOutcome = await captureFollowupResult(
            `sync relay organization after Better Auth update ${organizationId}`,
            async () =>
              syncBetterAuthOrganizationToRelayUsers(
                services,
                result.data,
                resolveRelayOrgIdFromBetterAuthOrganization(
                  previousOrganization,
                ),
              ),
          );
          if (syncOutcome.warning) {
            warnings.push(syncOutcome.warning);
          }
        }
        res
          .status(result.status)
          .json(appendWarningsToResponseBody(result.data, warnings));
      }),
    );
    app.post(
      "/admin/better-auth/organizations/:organizationId/delete",
      asyncRoute(async (req, res) => {
        const organizationId = getRouteParam(req.params.organizationId);
        const previousOrganization = await runBestEffortSideEffect(
          `load Better Auth organization ${organizationId} before delete`,
          async () =>
            (await listBetterAuthOrganizationsInternal()).find(
              (organization) =>
                String(organization.id ?? "") === organizationId,
            ) ?? null,
          null,
        );
        const result = await requestBetterAuthInternal(
          "/organization/delete",
          {},
          {
            method: "POST",
            body: { organizationId },
          },
        );
        const warnings = [];
        if (result.ok) {
          const clearOutcome = await captureFollowupResult(
            `clear relay organization after Better Auth delete ${organizationId}`,
            async () =>
              clearRelayOrganizationFromUsers(services, previousOrganization),
          );
          if (clearOutcome.warning) {
            warnings.push(clearOutcome.warning);
          }
        }
        res
          .status(result.status)
          .json(appendWarningsToResponseBody(result.data, warnings));
      }),
    );
    app.post(
      "/admin/better-auth/organizations/:organizationId/members",
      asyncRoute(async (req, res) => {
        const organizationId = getRouteParam(req.params.organizationId);
        const userId = getOptionalString(req.body?.userId);
        if (!userId) {
          res
            .status(400)
            .json({ error: "missing_user_id", message: "userId is required" });
          return;
        }
        const result = await requestBetterAuthInternal(
          "/organization/add-member",
          {},
          {
            method: "POST",
            body: {
              organizationId,
              userId,
              role: getOptionalString(req.body?.role) ?? "member",
            },
          },
        );
        const warnings = [];
        if (result.ok) {
          const organizationOutcome = await captureFollowupResult(
            `load Better Auth organization ${organizationId} after add member`,
            async () =>
              (await listBetterAuthOrganizationsInternal()).find(
                (item) => String(item.id ?? "") === organizationId,
              ) ?? null,
            null,
          );
          if (organizationOutcome.warning) {
            warnings.push(organizationOutcome.warning);
          }
          const syncOutcome = await captureFollowupResult(
            `sync relay user after Better Auth add member ${userId}`,
            async () =>
              syncBetterAuthUserToRelayUser(
                services,
                { id: userId },
                organizationOutcome.value ? [organizationOutcome.value] : [],
              ),
          );
          if (syncOutcome.warning) {
            warnings.push(syncOutcome.warning);
          }
        }
        res
          .status(result.status)
          .json(appendWarningsToResponseBody(result.data, warnings));
      }),
    );
    app.post(
      "/admin/better-auth/organizations/:organizationId/members/:memberId/update",
      asyncRoute(async (req, res) => {
        const organizationId = getRouteParam(req.params.organizationId);
        const memberId = getRouteParam(req.params.memberId);
        const result = await requestBetterAuthInternal(
          "/organization/update-member-role",
          {},
          {
            method: "POST",
            body: {
              organizationId,
              memberId,
              role: getOptionalString(req.body?.role) ?? "member",
            },
          },
        );
        res.status(result.status).json(result.data);
      }),
    );
    app.post(
      "/admin/better-auth/organizations/:organizationId/members/:memberId/delete",
      asyncRoute(async (req, res) => {
        const organizationId = getRouteParam(req.params.organizationId);
        const memberId = getRouteParam(req.params.memberId);
        const membersResult = await requestBetterAuthInternal(
          "/organization/list-members",
          { organizationId, limit: 1000 },
        );
        const member = membersResult.ok
          ? getBetterAuthMembersPayload(membersResult.data).find(
              (item) => String(item.id ?? "") === memberId,
            )
          : null;
        const result = await requestBetterAuthInternal(
          "/organization/remove-member",
          {},
          {
            method: "POST",
            body: { organizationId, memberIdOrEmail: memberId },
          },
        );
        const warnings = [];
        if (result.ok && services.userStore) {
          const syncOutcome = await captureFollowupResult(
            `sync relay user after Better Auth remove member ${memberId}`,
            async () => {
              const organization = (
                await listBetterAuthOrganizationsInternal()
              ).find((item) => String(item.id ?? "") === organizationId);
              const relayOrgId =
                resolveRelayOrgIdFromBetterAuthOrganization(organization);
              const relayUser = member?.userId
                ? await services.userStore.getUserByExternalId(
                    String(member.userId),
                  )
                : null;
              if (relayUser && relayUser.orgId === relayOrgId) {
                await services.userStore.updateUser(relayUser.id, {
                  orgId: null,
                });
              }
            },
          );
          if (syncOutcome.warning) {
            warnings.push(syncOutcome.warning);
          }
        }
        res
          .status(result.status)
          .json(appendWarningsToResponseBody(result.data, warnings));
      }),
    );
    app.get(
      "/admin/account",
      asyncRoute(async (_req, res) => {
        const accounts = await services.oauthService.listAccounts();
        res.json({
          account: accounts[0] ? sanitizeAccount(accounts[0]) : null,
          accounts: sanitizeAccounts(accounts),
        });
      }),
    );
    app.get(
      "/admin/accounts",
      asyncRoute(async (_req, res) => {
        const accounts = await services.oauthService.listAccounts();
        res.json({
          accounts: sanitizeAccounts(accounts),
        });
      }),
    );
    app.get(
      "/admin/accounts/:accountId",
      asyncRoute(async (req, res) => {
        const accountId = getRouteParam(req.params.accountId);
        const account = await services.oauthService.getAccount(accountId);
        if (!account) {
          res.status(404).json({
            error: "account_not_found",
            message: `账号不存在: ${accountId}`,
          });
          return;
        }
        res.json({ account: sanitizeAccount(account) });
      }),
    );
    app.get(
      "/admin/sticky-sessions",
      asyncRoute(async (_req, res) => {
        const stickySessions = await services.oauthService.listStickySessions();
        const sessionRoutes = await services.oauthService.listSessionRoutes();
        const recentHandoffs =
          await services.oauthService.listSessionHandoffs(50);
        res.json({
          stickySessions,
          sessionRoutes,
          recentHandoffs,
        });
      }),
    );
    app.post(
      "/admin/sticky-sessions/clear",
      asyncRoute(async (_req, res) => {
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: "/internal/control/sticky-sessions/clear",
        });
      }),
    );
    app.post(
      "/admin/account/clear",
      asyncRoute(async (_req, res) => {
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: "/internal/control/account/clear",
        });
      }),
    );
    app.post(
      "/admin/accounts/:accountId/delete",
      asyncRoute(async (req, res) => {
        const accountId = getRouteParam(req.params.accountId);
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: `/internal/control/accounts/${encodeURIComponent(accountId)}/delete`,
        });
      }),
    );
    app.post(
      "/admin/accounts/create",
      asyncRoute(async (req, res) => {
        await respondWithRelayControl(
          res,
          relayControlClient,
          {
            method: "POST",
            path: "/internal/control/accounts/create",
            body: req.body,
          },
          req,
        );
      }),
    );
    app.get(
      "/admin/routing-groups",
      asyncRoute(async (_req, res) => {
        const routingGroups = await services.oauthService.listRoutingGroups();
        res.json({ routingGroups });
      }),
    );
    app.post(
      "/admin/routing-groups",
      asyncRoute(async (req, res) => {
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: "/internal/control/routing-groups",
          body: req.body,
        });
      }),
    );
    app.post(
      "/admin/routing-groups/:groupId/update",
      asyncRoute(async (req, res) => {
        const groupId = getRouteParam(req.params.groupId);
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: `/internal/control/routing-groups/${encodeURIComponent(groupId)}/update`,
          body: req.body,
        });
      }),
    );
    app.post(
      "/admin/routing-groups/:groupId/delete",
      asyncRoute(async (req, res) => {
        const groupId = getRouteParam(req.params.groupId);
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: `/internal/control/routing-groups/${encodeURIComponent(groupId)}/delete`,
        });
      }),
    );
    app.post(
      "/admin/oauth/generate-auth-url",
      asyncRoute(async (req, res) => {
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: "/internal/control/oauth/generate-auth-url",
          body: req.body,
        });
      }),
    );
    app.post(
      "/admin/oauth/exchange-code",
      asyncRoute(async (req, res) => {
        await respondWithRelayControl(
          res,
          relayControlClient,
          {
            method: "POST",
            path: "/internal/control/oauth/exchange-code",
            body: req.body,
          },
          req,
        );
      }),
    );
    app.post(
      "/admin/oauth/login-with-session-key",
      asyncRoute(async (req, res) => {
        await respondWithRelayControl(
          res,
          relayControlClient,
          {
            method: "POST",
            path: "/internal/control/oauth/login-with-session-key",
            body: req.body,
          },
          req,
        );
      }),
    );
    app.post(
      "/admin/oauth/import-tokens",
      asyncRoute(async (req, res) => {
        await respondWithRelayControl(
          res,
          relayControlClient,
          {
            method: "POST",
            path: "/internal/control/oauth/import-tokens",
            body: req.body,
          },
          req,
        );
      }),
    );
    app.post(
      "/admin/oauth/refresh",
      asyncRoute(async (req, res) => {
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: "/internal/control/oauth/refresh",
          body: req.body,
        });
      }),
    );
    app.post(
      "/admin/oauth/gemini/start",
      asyncRoute(async (req, res) => {
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: "/internal/control/oauth/gemini/start",
          body: req.body,
        });
      }),
    );
    app.get(
      "/admin/oauth/gemini/status",
      asyncRoute(async (req, res) => {
        await respondWithRelayControl(res, relayControlClient, {
          method: "GET",
          path: "/internal/control/oauth/gemini/status",
          query: {
            sessionId: getOptionalString(req.query?.sessionId),
          },
        });
      }),
    );
    app.post(
      "/admin/oauth/gemini/manual-exchange",
      asyncRoute(async (req, res) => {
        await respondWithRelayControl(
          res,
          relayControlClient,
          {
            method: "POST",
            path: "/internal/control/oauth/gemini/manual-exchange",
            body: req.body,
          },
          req,
        );
      }),
    );
    app.post(
      "/admin/accounts/:accountId/settings",
      asyncRoute(async (req, res) => {
        const accountId = getRouteParam(req.params.accountId);
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: `/internal/control/accounts/${encodeURIComponent(accountId)}/settings`,
          body: req.body,
        });
      }),
    );
    app.post(
      "/admin/accounts/:accountId/refresh",
      asyncRoute(async (req, res) => {
        const accountId = getRouteParam(req.params.accountId);
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: `/internal/control/accounts/${encodeURIComponent(accountId)}/refresh`,
        });
      }),
    );
    app.post(
      "/admin/accounts/:accountId/ban",
      asyncRoute(async (req, res) => {
        const accountId = getRouteParam(req.params.accountId);
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: `/internal/control/accounts/${encodeURIComponent(accountId)}/ban`,
        });
      }),
    );
    app.get(
      "/admin/scheduler/stats",
      asyncRoute(async (_req, res) => {
        const stats = await services.oauthService.getSchedulerStats();
        res.json(stats);
      }),
    );
    app.get(
      "/admin/session-routes",
      asyncRoute(async (_req, res) => {
        const sessionRoutes = await services.oauthService.listSessionRoutes();
        const recentHandoffs =
          await services.oauthService.listSessionHandoffs(200);
        res.json({ sessionRoutes, recentHandoffs });
      }),
    );
    app.post(
      "/admin/session-routes/clear",
      asyncRoute(async (_req, res) => {
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: "/internal/control/session-routes/clear",
        });
      }),
    );
    // ── Rate limit probe (forwarded to relay; control plane never hits upstream) ──
    app.get(
      "/admin/accounts/:accountId/ratelimit",
      asyncRoute(async (req, res) => {
        const accountId = getRouteParam(req.params.accountId);
        await respondWithRelayControl(res, relayControlClient, {
          method: "GET",
          path: `/internal/control/accounts/${encodeURIComponent(accountId)}/ratelimit`,
          timeoutMs: appConfig.requestTimeoutMs + 15_000,
        });
      }),
    );
    // ── User management ──
    app.get(
      "/admin/users",
      asyncRoute(async (_req, res) => {
        if (!services.userStore) {
          res.status(404).json({ error: "user_management_disabled" });
          return;
        }
        const users = await services.userStore.listUsersWithUsage();
        res.json({ users: users.map((user) => sanitizeUser(user)) });
      }),
    );
    app.get(
      "/admin/users/:userId",
      asyncRoute(async (req, res) => {
        if (!services.userStore) {
          res.status(404).json({ error: "user_management_disabled" });
          return;
        }
        const userId = getRouteParam(req.params.userId);
        const user = await services.userStore.getUserById(userId);
        if (!user) {
          res.status(404).json({ error: "user_not_found" });
          return;
        }
        const relayKeySourceSummary =
          typeof services.userStore.getUserRelayKeySourceSummary === "function"
            ? await services.userStore.getUserRelayKeySourceSummary(userId)
            : undefined;
        res.json({ user: sanitizeUser({ ...user, relayKeySourceSummary }) });
      }),
    );
    app.get(
      "/admin/users/:userId/api-key",
      asyncRoute(async (req, res) => {
        if (!services.userStore) {
          res.status(404).json({ error: "user_management_disabled" });
          return;
        }
        const userId = getRouteParam(req.params.userId);
        const user = await services.userStore.getUserById(userId);
        if (!user) {
          res.status(404).json({ error: "user_not_found" });
          return;
        }
        res.json(await buildUserApiKeyReadResponse(services, user));
      }),
    );
    app.get(
      "/admin/users/:userId/api-keys",
      asyncRoute(async (req, res) => {
        if (!services.userStore || !services.apiKeyStore) {
          res.status(404).json({ error: "api_key_management_disabled" });
          return;
        }
        const userId = getRouteParam(req.params.userId);
        const user = await services.userStore.getUserById(userId);
        if (!user) {
          res.status(404).json({ error: "user_not_found" });
          return;
        }
        const apiKeys = await services.apiKeyStore.listForUser(userId);
        res.json({ apiKeys, max: 100 });
      }),
    );
    app.get(
      "/admin/users/:userId/api-keys/:keyId/plaintext",
      asyncRoute(async (req, res) => {
        if (!services.userStore || !services.apiKeyStore) {
          res.status(404).json({ error: "api_key_management_disabled" });
          return;
        }
        const userId = getRouteParam(req.params.userId);
        const keyId = getRouteParam(req.params.keyId);
        const user = await services.userStore.getUserById(userId);
        if (!user) {
          res.status(404).json({ error: "user_not_found" });
          return;
        }
        const apiKey = await services.apiKeyStore.getPlaintextForUserKey(
          userId,
          keyId,
        );
        if (!apiKey) {
          res.status(404).json({
            error: "api_key_plaintext_unavailable",
            message:
              "This API key was created before persistent copy support and cannot be recovered.",
          });
          return;
        }
        res.json({ apiKey });
      }),
    );
    app.post(
      "/admin/users/:userId/api-keys",
      asyncRoute(async (req, res) => {
        const userId = getRouteParam(req.params.userId);
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: `/internal/control/users/${encodeURIComponent(userId)}/api-keys`,
          body: req.body,
        });
      }),
    );
    app.post(
      "/admin/users/:userId/api-keys/:keyId/groups",
      asyncRoute(async (req, res) => {
        const userId = getRouteParam(req.params.userId);
        const keyId = getRouteParam(req.params.keyId);
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: `/internal/control/users/${encodeURIComponent(userId)}/api-keys/${encodeURIComponent(keyId)}/groups`,
          body: req.body,
        });
      }),
    );
    app.delete(
      "/admin/users/:userId/api-keys/:keyId",
      asyncRoute(async (req, res) => {
        const userId = getRouteParam(req.params.userId);
        const keyId = getRouteParam(req.params.keyId);
        await respondWithRelayControl(res, relayControlClient, {
          method: "DELETE",
          path: `/internal/control/users/${encodeURIComponent(userId)}/api-keys/${encodeURIComponent(keyId)}`,
        });
      }),
    );
    app.post(
      "/admin/users/:userId/update",
      asyncRoute(async (req, res) => {
        const userId = getRouteParam(req.params.userId);
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: `/internal/control/users/${encodeURIComponent(userId)}/update`,
          body: req.body,
        });
      }),
    );
    app.post(
      "/admin/users/:userId/delete",
      asyncRoute(async (req, res) => {
        const userId = getRouteParam(req.params.userId);
        const existing = services.userStore
          ? await services.userStore.getUserById(userId)
          : null;
        const result = await requestRelayControlResult(relayControlClient, {
          method: "POST",
          path: `/internal/control/users/${encodeURIComponent(userId)}/delete`,
        });
        if (result.status !== 200) {
          res.status(result.status).json(result.data);
          return;
        }
        if (existing) {
          await runBestEffortSideEffect(
            `delete Better Auth user linked to relay user ${userId}`,
            async () => {
              const betterUser = await findBetterAuthUserForRelayUser(existing);
              if (!betterUser?.id) {
                return;
              }
              const removeBetterUserResult = await requestBetterAuthInternal(
                "/admin/remove-user",
                {},
                {
                  method: "POST",
                  body: { userId: betterUser.id },
                },
              );
              unwrapBetterAuthResult(
                removeBetterUserResult,
                `Better Auth remove user failed: HTTP ${removeBetterUserResult.status}`,
              );
            },
          );
        }
        res.status(result.status).json(result.data);
      }),
    );
    app.post(
      "/admin/users/:userId/regenerate-key",
      asyncRoute(async (req, res) => {
        const userId = getRouteParam(req.params.userId);
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: `/internal/control/users/${encodeURIComponent(userId)}/regenerate-key`,
        });
      }),
    );
    app.get(
      "/admin/users/:userId/sessions",
      asyncRoute(async (req, res) => {
        if (!services.userStore) {
          res.status(404).json({ error: "user_management_disabled" });
          return;
        }
        const userId = getRouteParam(req.params.userId);
        const sessions = await services.userStore.getUserSessions(userId);
        res.json({ sessions });
      }),
    );
    app.get(
      "/admin/users/:userId/sessions/:sessionKey/requests",
      asyncRoute(async (req, res) => {
        if (!services.userStore) {
          res.status(404).json({ error: "user_management_disabled" });
          return;
        }
        const userId = getRouteParam(req.params.userId);
        const sessionKey = getRouteParam(req.params.sessionKey);
        const limit =
          typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
        const offset =
          typeof req.query.offset === "string" ? Number(req.query.offset) : 0;
        let relayKeySource;
        try {
          relayKeySource =
            getOptionalRelayKeySource(req.query.relayKeySource) ?? null;
        } catch (error) {
          if (error instanceof InputValidationError) {
            res
              .status(400)
              .json({
                error: "invalid_relay_key_source",
                message: error.message,
              });
            return;
          }
          throw error;
        }
        const result = await services.userStore.getSessionRequests(
          userId,
          sessionKey,
          limit,
          offset,
          relayKeySource,
        );
        res.json(result);
      }),
    );
    app.get(
      "/admin/users/:userId/requests",
      asyncRoute(async (req, res) => {
        if (!services.userStore) {
          res.status(404).json({ error: "user_management_disabled" });
          return;
        }
        const userId = getRouteParam(req.params.userId);
        const limit =
          typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
        const offset =
          typeof req.query.offset === "string" ? Number(req.query.offset) : 0;
        let relayKeySource;
        try {
          relayKeySource =
            getOptionalRelayKeySource(req.query.relayKeySource) ?? null;
        } catch (error) {
          if (error instanceof InputValidationError) {
            res
              .status(400)
              .json({
                error: "invalid_relay_key_source",
                message: error.message,
              });
            return;
          }
          throw error;
        }
        const result = await services.userStore.getUserRequests(
          userId,
          limit,
          offset,
          relayKeySource,
        );
        res.json(result);
      }),
    );
    app.get(
      "/admin/users/:userId/requests/:requestId",
      asyncRoute(async (req, res) => {
        if (!services.userStore) {
          res.status(404).json({ error: "user_management_disabled" });
          return;
        }
        const userId = getRouteParam(req.params.userId);
        const requestId = getRouteParam(req.params.requestId);
        const usageRecordId =
          typeof req.query.usageRecordId === "string"
            ? Number(req.query.usageRecordId)
            : undefined;
        const detail = await services.userStore.getRequestDetail(
          userId,
          requestId,
          usageRecordId,
        );
        if (!detail) {
          res.status(404).json({ error: "request_not_found" });
          return;
        }
        res.json({ request: detail });
      }),
    );
    // ── Proxy / VPN management ──
    app.get(
      "/admin/proxies",
      asyncRoute(async (_req, res) => {
        const proxies = await services.oauthService.listProxies();
        const accounts = await services.oauthService.listAccounts();
        // Attach linked account summaries to each proxy
        const result = proxies.map((proxy) => ({
          ...proxy,
          accounts: accounts
            .filter(
              (a) =>
                a.proxyUrl === proxy.url ||
                (proxy.localUrl && a.proxyUrl === proxy.localUrl),
            )
            .map((a) => ({
              id: a.id,
              label: a.label,
              emailAddress: a.emailAddress,
              status: a.status,
            })),
        }));
        res.json({ proxies: result });
      }),
    );
    app.post(
      "/admin/proxies",
      asyncRoute(async (req, res) => {
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: "/internal/control/proxies",
          body: req.body,
        });
      }),
    );
    app.post(
      "/admin/proxies/import",
      asyncRoute(async (req, res) => {
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: "/internal/control/proxies/import",
          body: req.body,
        });
      }),
    );
    app.post(
      "/admin/proxies/:proxyId/update",
      asyncRoute(async (req, res) => {
        const proxyId = getRouteParam(req.params.proxyId);
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: `/internal/control/proxies/${encodeURIComponent(proxyId)}/update`,
          body: req.body,
        });
      }),
    );
    app.post(
      "/admin/proxies/:proxyId/delete",
      asyncRoute(async (req, res) => {
        const proxyId = getRouteParam(req.params.proxyId);
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: `/internal/control/proxies/${encodeURIComponent(proxyId)}/delete`,
        });
      }),
    );
    app.post(
      "/admin/proxies/:proxyId/link",
      asyncRoute(async (req, res) => {
        const proxyId = getRouteParam(req.params.proxyId);
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: `/internal/control/proxies/${encodeURIComponent(proxyId)}/link`,
          body: req.body,
        });
      }),
    );
    app.post(
      "/admin/proxies/:proxyId/unlink",
      asyncRoute(async (req, res) => {
        const proxyId = getRouteParam(req.params.proxyId);
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: `/internal/control/proxies/${encodeURIComponent(proxyId)}/unlink`,
          body: req.body,
        });
      }),
    );
    app.post(
      "/admin/proxies/:proxyId/probe",
      asyncRoute(async (req, res) => {
        const proxyId = getRouteParam(req.params.proxyId);
        const proxies = await services.oauthService.listProxies();
        const proxy = proxies.find((item) => item.id === proxyId);
        if (!proxy) {
          res
            .status(404)
            .json({
              error: "proxy_not_found",
              message: `Proxy not found: ${proxyId}`,
            });
          return;
        }
        const probeReadyProxy = await ensureProxyProbeReady(services, proxy);
        const diagnostics = await probeProxyExit(probeReadyProxy);
        await services.oauthService.updateProxy(probeReadyProxy.id, {
          lastProbeStatus: diagnostics.status,
          lastProbeAt: diagnostics.checkedAt,
          egressIp: diagnostics.egressIp,
        });
        res.json({
          ok: diagnostics.status === "healthy",
          diagnostics,
        });
      }),
    );
    app.post(
      "/admin/xray/sync",
      asyncRoute(async (req, res) => {
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: "/internal/control/xray/sync",
          body: req.body,
        });
      }),
    );
    // ── Usage tracking endpoints ──
    app.get(
      "/admin/usage/summary",
      asyncRoute(async (req, res) => {
        if (!services.usageStore) {
          res.status(404).json({ error: "usage_tracking_disabled" });
          return;
        }
        const since =
          typeof req.query.since === "string"
            ? new Date(req.query.since)
            : null;
        const summary = await services.usageStore.getSummary(since);
        res.json(summary);
      }),
    );
    app.get(
      "/admin/usage/accounts",
      asyncRoute(async (req, res) => {
        if (!services.usageStore) {
          res.status(404).json({ error: "usage_tracking_disabled" });
          return;
        }
        const since =
          typeof req.query.since === "string"
            ? new Date(req.query.since)
            : null;
        const accounts = await services.usageStore.getAccountUsage(since);
        res.json({ accounts });
      }),
    );
    app.get(
      "/admin/usage/accounts/:accountId",
      asyncRoute(async (req, res) => {
        if (!services.usageStore) {
          res.status(404).json({ error: "usage_tracking_disabled" });
          return;
        }
        const accountId = getRouteParam(req.params.accountId);
        const since =
          typeof req.query.since === "string"
            ? new Date(req.query.since)
            : null;
        const detail = await services.usageStore.getAccountDetail(
          accountId,
          since,
        );
        res.json(detail);
      }),
    );
    app.get(
      "/admin/usage/trend",
      asyncRoute(async (req, res) => {
        if (!services.usageStore) {
          res.status(404).json({ error: "usage_tracking_disabled" });
          return;
        }
        const days =
          typeof req.query.days === "string" ? Number(req.query.days) : 30;
        const accountId =
          typeof req.query.accountId === "string" ? req.query.accountId : null;
        const trend = await services.usageStore.getTrend(days, accountId);
        res.json({ trend });
      }),
    );

    app.get(
      "/admin/risk/natural-capacity-config",
      asyncRoute(async (_req, res) => {
        res.json({
          enabled: appConfig.claudeOfficialNaturalCapacityEnabled,
          userDeviceMaxAccounts24h: appConfig.claudeOfficialUserDeviceMaxAccounts24h,
          newAccountNewSessionOnlyHours: appConfig.claudeOfficialNewAccountNewSessionOnlyHours,
          heavySessionAccountMinAgeHours: appConfig.claudeOfficialHeavySessionAccountMinAgeHours,
          heavySessionTokens: appConfig.claudeOfficialHeavySessionTokens,
          heavySessionCacheReadTokens: appConfig.claudeOfficialHeavySessionCacheReadTokens,
        });
      }),
    );
    app.get(
      "/admin/risk/summary",
      asyncRoute(async (req, res) => {
        if (!services.userStore) {
          res.status(404).json({ error: "user_store_disabled" });
          return;
        }
        const since = typeof req.query.since === "string" ? req.query.since : null;
        const summary = await services.userStore.getRiskDashboardSummary({ since });
        res.json(summary);
      }),
    );
    app.get(
      "/admin/risk/trends",
      asyncRoute(async (req, res) => {
        if (!services.userStore) {
          res.status(404).json({ error: "user_store_disabled" });
          return;
        }
        const result = await services.userStore.getRiskDashboardTrends({
          since: typeof req.query.since === "string" ? req.query.since : null,
          accountId: typeof req.query.accountId === "string" ? req.query.accountId : null,
        });
        res.json(result);
      }),
    );
    app.get(
      "/admin/risk/lifecycle/summary",
      asyncRoute(async (req, res) => {
        if (!services.accountLifecycleStore) {
          res.status(404).json({ error: "lifecycle_store_disabled" });
          return;
        }
        const limit = (() => {
          if (typeof req.query.limit !== "string") return 100;
          const value = Number(req.query.limit);
          return Number.isFinite(value) ? value : 100;
        })();
        const accounts = await services.accountLifecycleStore.listAccountSummaries(limit);
        res.json({ accounts });
      }),
    );
    app.get(
      "/admin/risk/lifecycle/events",
      asyncRoute(async (req, res) => {
        if (!services.accountLifecycleStore) {
          res.status(404).json({ error: "lifecycle_store_disabled" });
          return;
        }
        const eventTypesRaw = req.query.eventTypes;
        const eventTypes = (() => {
          if (!eventTypesRaw) return null;
          if (Array.isArray(eventTypesRaw)) return eventTypesRaw.map((x) => String(x));
          return String(eventTypesRaw)
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean);
        })();
        const events = await services.accountLifecycleStore.listEvents({
          accountId:
            typeof req.query.accountId === "string" ? req.query.accountId : null,
          eventTypes,
          since: typeof req.query.since === "string" ? new Date(req.query.since) : null,
          until: typeof req.query.until === "string" ? new Date(req.query.until) : null,
          limit: (() => {
            if (typeof req.query.limit !== "string") return 200;
            const value = Number(req.query.limit);
            return Number.isFinite(value) ? value : 200;
          })(),
        });
        res.json({ events });
      }),
    );
    app.get(
      "/admin/risk/account-scores",
      asyncRoute(async (req, res) => {
        if (!services.accountRiskService || !services.accountRiskStore) {
          res.status(404).json({ error: "account_risk_disabled" });
          return;
        }
        const parseNumber = (value) => {
          if (typeof value !== "string" || value.trim() === "") return null;
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : null;
        };
        const refresh = req.query.refresh === "1" || req.query.refresh === "true";
        const limit = parseNumber(req.query.limit) ?? 200;
        const allAccounts = await services.oauthService.listAccounts();
        const accounts = refresh
          ? await services.accountRiskService.scoreAccounts(allAccounts, { persist: true, limit })
          : await services.accountRiskStore.listLatest({ limit });
        res.json({ accounts: attachAccountRiskLabels(accounts, allAccounts) });
      }),
    );
    app.get(
      "/admin/risk/account-scores/:accountId/history",
      asyncRoute(async (req, res) => {
        if (!services.accountRiskStore) {
          res.status(404).json({ error: "account_risk_disabled" });
          return;
        }
        const accountId = getRouteParam(req.params.accountId);
        const limit = typeof req.query.limit === "string" && Number.isFinite(Number(req.query.limit))
          ? Number(req.query.limit)
          : 96;
        const points = await services.accountRiskStore.getHistory(accountId, limit);
        res.json({ points });
      }),
    );
    app.post(
      "/admin/risk/account-scores/refresh",
      asyncRoute(async (_req, res) => {
        if (!services.accountRiskService) {
          res.status(404).json({ error: "account_risk_disabled" });
          return;
        }
        const allAccounts = await services.oauthService.listAccounts();
        const accounts = await services.accountRiskService.scoreAccounts(allAccounts, { persist: true });
        res.json({ ok: true, accounts: attachAccountRiskLabels(accounts, allAccounts) });
      }),
    );
    app.get(
      "/admin/risk/account-health-distribution",
      asyncRoute(async (req, res) => {
        if (!services.userStore) {
          res.status(404).json({ error: "user_store_disabled" });
          return;
        }
        const result = await services.userStore.getAccountHealthDistribution({
          since: typeof req.query.since === "string" ? req.query.since : null,
        });
        res.json(result);
      }),
    );
    app.get(
      "/admin/risk/egress-summary",
      asyncRoute(async (_req, res) => {
        if (!services.userStore) {
          res.status(404).json({ error: "user_store_disabled" });
          return;
        }
        const result = await services.userStore.getEgressRiskSummary();
        res.json(result);
      }),
    );
    app.get(
      "/admin/risk/events",
      asyncRoute(async (req, res) => {
        if (!services.userStore) {
          res.status(404).json({ error: "user_store_disabled" });
          return;
        }
        const parseNumber = (value) => {
          if (typeof value !== "string" || value.trim() === "") return null;
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : null;
        };
        const parseBool = (value) => value === "1" || value === "true";
        const result = await services.userStore.getRiskDashboardEvents({
          since: typeof req.query.since === "string" ? req.query.since : null,
          limit: parseNumber(req.query.limit) ?? 100,
          offset: parseNumber(req.query.offset) ?? 0,
          userId: typeof req.query.userId === "string" ? req.query.userId : null,
          accountId: typeof req.query.accountId === "string" ? req.query.accountId : null,
          sessionKey: typeof req.query.sessionKey === "string" ? req.query.sessionKey : null,
          clientDeviceId: typeof req.query.clientDeviceId === "string" ? req.query.clientDeviceId : null,
          ip: typeof req.query.ip === "string" ? req.query.ip : null,
          path: typeof req.query.path === "string" ? req.query.path : null,
          statusCode: parseNumber(req.query.statusCode),
          minTokens: parseNumber(req.query.minTokens),
          riskOnly: parseBool(req.query.riskOnly),
          multiAccountOnly: parseBool(req.query.multiAccountOnly),
          revokedOnly: parseBool(req.query.revokedOnly),
        });
        res.json(result);
      }),
    );
    // ── Billing endpoints ──
    app.get(
      "/admin/billing/summary",
      asyncRoute(async (req, res) => {
        if (!services.billingStore) {
          res.status(404).json({ error: "billing_disabled" });
          return;
        }
        const since =
          typeof req.query.since === "string"
            ? new Date(req.query.since)
            : null;
        const currency = getOptionalBillingCurrency(
          req.query.currency,
          "currency",
        );
        const summary = await services.billingStore.getSummary(since, currency);
        res.json(summary);
      }),
    );
    app.get(
      "/admin/billing/users",
      asyncRoute(async (req, res) => {
        if (!services.billingStore) {
          res.status(404).json({ error: "billing_disabled" });
          return;
        }
        const since =
          typeof req.query.since === "string"
            ? new Date(req.query.since)
            : null;
        const currency = getOptionalBillingCurrency(
          req.query.currency,
          "currency",
        );
        const users = await services.billingStore.getUserBilling(
          since,
          currency,
        );
        res.json({
          users,
          currency:
            currency ??
            normalizeBillingCurrency(appConfig.billingCurrency, {
              field: "BILLING_CURRENCY",
            }),
        });
      }),
    );
    app.get(
      "/admin/billing/users/:userId",
      asyncRoute(async (req, res) => {
        if (!services.billingStore) {
          res.status(404).json({ error: "billing_disabled" });
          return;
        }
        const userId = getRouteParam(req.params.userId);
        const since =
          typeof req.query.since === "string"
            ? new Date(req.query.since)
            : null;
        const detail = await services.billingStore.getUserDetail(userId, since);
        if (!detail) {
          res.status(404).json({ error: "billing_user_not_found" });
          return;
        }
        res.json(detail);
      }),
    );
    app.get(
      "/admin/billing/users/:userId/items",
      asyncRoute(async (req, res) => {
        if (!services.billingStore) {
          res.status(404).json({ error: "billing_disabled" });
          return;
        }
        const userId = getRouteParam(req.params.userId);
        const since =
          typeof req.query.since === "string"
            ? new Date(req.query.since)
            : null;
        const limit =
          typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
        const offset =
          typeof req.query.offset === "string" ? Number(req.query.offset) : 0;
        const result = await services.billingStore.getUserLineItems(
          userId,
          since,
          limit,
          offset,
        );
        res.json(result);
      }),
    );
    app.get(
      "/admin/billing/users/:userId/balance",
      asyncRoute(async (req, res) => {
        if (!services.billingStore) {
          res.status(404).json({ error: "billing_disabled" });
          return;
        }
        const userId = getRouteParam(req.params.userId);
        const balance =
          await services.billingStore.getUserBalanceSummary(userId);
        if (!balance) {
          res.status(404).json({ error: "billing_user_not_found" });
          return;
        }
        res.json(balance);
      }),
    );
    app.get(
      "/admin/billing/users/:userId/ledger",
      asyncRoute(async (req, res) => {
        if (!services.billingStore) {
          res.status(404).json({ error: "billing_disabled" });
          return;
        }
        const userId = getRouteParam(req.params.userId);
        const limit =
          typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
        const offset =
          typeof req.query.offset === "string" ? Number(req.query.offset) : 0;
        const balance =
          await services.billingStore.getUserBalanceSummary(userId);
        if (!balance) {
          res.status(404).json({ error: "billing_user_not_found" });
          return;
        }
        const result = await services.billingStore.listUserLedger(
          userId,
          limit,
          offset,
        );
        res.json(result);
      }),
    );
    app.post(
      "/admin/billing/users/:userId/ledger",
      asyncRoute(async (req, res) => {
        const userId = getRouteParam(req.params.userId);
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: `/internal/control/billing/users/${encodeURIComponent(userId)}/ledger`,
          body: req.body,
        });
      }),
    );
    app.get(
      "/admin/billing/organizations/:organizationId/balance",
      asyncRoute(async (req, res) => {
        if (!services.billingStore) {
          res.status(404).json({ error: "billing_disabled" });
          return;
        }
        const organizationId = getRouteParam(req.params.organizationId);
        const balance =
          await services.billingStore.getOrganizationBalanceSummary(
            organizationId,
          );
        if (!balance) {
          res.status(404).json({ error: "billing_organization_not_found" });
          return;
        }
        res.json(balance);
      }),
    );
    app.get(
      "/admin/billing/organizations/:organizationId/ledger",
      asyncRoute(async (req, res) => {
        if (!services.billingStore) {
          res.status(404).json({ error: "billing_disabled" });
          return;
        }
        const organizationId = getRouteParam(req.params.organizationId);
        const limit =
          typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
        const offset =
          typeof req.query.offset === "string" ? Number(req.query.offset) : 0;
        const balance =
          await services.billingStore.getOrganizationBalanceSummary(
            organizationId,
          );
        if (!balance) {
          res.status(404).json({ error: "billing_organization_not_found" });
          return;
        }
        const result = await services.billingStore.listOrganizationLedger(
          organizationId,
          limit,
          offset,
        );
        res.json(result);
      }),
    );
    app.post(
      "/admin/billing/organizations/:organizationId/ledger",
      asyncRoute(async (req, res) => {
        if (!services.billingStore) {
          res.status(404).json({ error: "billing_disabled" });
          return;
        }
        const organizationId = getRouteParam(req.params.organizationId);
        const kind =
          req.body?.kind === "topup" ? "topup" : "manual_adjustment";
        const amountMicros = req.body?.amountMicros;
        if (
          amountMicros === undefined ||
          amountMicros === null ||
          String(amountMicros).trim() === ""
        ) {
          res.status(400).json({
            error: "missing_amount_micros",
            message: "amountMicros is required",
          });
          return;
        }
        const existing =
          await services.billingStore.getOrganizationBalanceSummary(
            organizationId,
          );
        if (!existing) {
          res.status(404).json({ error: "billing_organization_not_found" });
          return;
        }
        try {
          const result =
            await services.billingStore.createOrganizationLedgerEntry({
              organizationId,
              kind,
              amountMicros,
              note: req.body?.note,
            });
          res.json({ ok: true, entry: result.entry, balance: result.balance });
        } catch (error) {
          res.status(400).json({
            error: "invalid_billing_ledger_entry",
            message: sanitizeErrorMessage(error),
          });
        }
      }),
    );
    app.get(
      "/admin/support/tickets",
      asyncRoute(async (req, res) => {
        if (!services.supportStore) {
          res.status(503).json({ error: "support_disabled" });
          return;
        }
        const status =
          typeof req.query.status === "string" ? req.query.status : undefined;
        const search =
          typeof req.query.search === "string" ? req.query.search : undefined;
        const limit =
          typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
        const tickets = await services.supportStore.listAllTickets({
          status: status,
          search,
          limit: Number.isFinite(limit) ? limit : 100,
        });
        res.json({ tickets });
      }),
    );

    app.get(
      "/admin/support/tickets/:ticketId",
      asyncRoute(async (req, res) => {
        if (!services.supportStore) {
          res.status(503).json({ error: "support_disabled" });
          return;
        }
        const ticketId = getRouteParam(req.params.ticketId);
        const ticket = await services.supportStore.getTicket(ticketId);
        if (!ticket) {
          res.status(404).json({ error: "ticket_not_found" });
          return;
        }
        const messages =
          await services.supportStore.listMessagesForTicket(ticketId);
        res.json({ ticket, messages });
      }),
    );

    app.post(
      "/admin/support/tickets/:ticketId/messages",
      asyncRoute(async (req, res) => {
        if (!services.supportStore) {
          res.status(503).json({ error: "support_disabled" });
          return;
        }
        const ticketId = getRouteParam(req.params.ticketId);
        const ticket = await services.supportStore.getTicket(ticketId);
        if (!ticket) {
          res.status(404).json({ error: "ticket_not_found" });
          return;
        }
        const body = req.body ?? {};
        const replyBody = typeof body.body === "string" ? body.body : "";
        const authorName =
          typeof body.authorName === "string" && body.authorName.trim()
            ? body.authorName.trim()
            : "客服";
        try {
          const message = await services.supportStore.appendMessage({
            ticketId,
            authorKind: "agent",
            authorId:
              typeof body.authorId === "string" ? body.authorId : "admin",
            authorName,
            body: replyBody,
          });
          const refreshed = await services.supportStore.getTicket(ticketId);
          if (refreshed) {
            void notifyCcwebappAgentReply({
              ticket: refreshed,
              agentReplyBody: replyBody,
              agentName: authorName,
            });
          }
          res.json({ ok: true, message, ticket: refreshed });
        } catch (error) {
          const m = error instanceof Error ? error.message : "append_failed";
          const status = m === "ticket_closed" ? 409 : 400;
          res.status(status).json({ error: m });
        }
      }),
    );

    app.post(
      "/admin/support/tickets/:ticketId/status",
      asyncRoute(async (req, res) => {
        if (!services.supportStore) {
          res.status(503).json({ error: "support_disabled" });
          return;
        }
        const ticketId = getRouteParam(req.params.ticketId);
        const status =
          typeof req.body?.status === "string" ? req.body.status : "";
        try {
          const ticket = await services.supportStore.setTicketStatus(
            ticketId,
            status,
          );
          if (!ticket) {
            res.status(404).json({ error: "ticket_not_found" });
            return;
          }
          res.json({ ok: true, ticket });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "invalid_status";
          res.status(400).json({ error: "invalid_status", message });
        }
      }),
    );

    app.get(
      "/admin/billing/base-skus",
      asyncRoute(async (_req, res) => {
        if (!services.billingStore) {
          res.status(404).json({ error: "billing_disabled" });
          return;
        }
        const skus = await services.billingStore.listBaseSkus();
        res.json({ skus });
      }),
    );
    app.post(
      "/admin/billing/base-skus",
      asyncRoute(async (req, res) => {
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: "/internal/control/billing/base-skus",
          body: req.body,
        });
      }),
    );
    app.post(
      "/admin/billing/base-skus/:skuId/delete",
      asyncRoute(async (req, res) => {
        const skuId = getRouteParam(req.params.skuId);
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: `/internal/control/billing/base-skus/${encodeURIComponent(skuId)}/delete`,
        });
      }),
    );

    app.get(
      "/admin/billing/channel-multipliers",
      asyncRoute(async (req, res) => {
        if (!services.billingStore) {
          res.status(404).json({ error: "billing_disabled" });
          return;
        }
        const groupId =
          typeof req.query.routingGroupId === "string"
            ? req.query.routingGroupId
            : null;
        const multipliers =
          await services.billingStore.listChannelMultipliers(groupId);
        res.json({ multipliers });
      }),
    );
    app.post(
      "/admin/billing/channel-multipliers",
      asyncRoute(async (req, res) => {
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: "/internal/control/billing/channel-multipliers",
          body: req.body,
        });
      }),
    );
    app.post(
      "/admin/billing/channel-multipliers/:multiplierId/delete",
      asyncRoute(async (req, res) => {
        const multiplierId = getRouteParam(req.params.multiplierId);
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: `/internal/control/billing/channel-multipliers/${encodeURIComponent(multiplierId)}/delete`,
        });
      }),
    );
    app.post(
      "/admin/billing/channel-multipliers/copy",
      asyncRoute(async (req, res) => {
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: "/internal/control/billing/channel-multipliers/copy",
          body: req.body,
        });
      }),
    );
    app.post(
      "/admin/billing/channel-multipliers/bulk-adjust",
      asyncRoute(async (req, res) => {
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: "/internal/control/billing/channel-multipliers/bulk-adjust",
          body: req.body,
        });
      }),
    );
    app.post(
      "/admin/billing/sync",
      asyncRoute(async (req, res) => {
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: "/internal/control/billing/sync",
          body: req.body,
        });
      }),
    );
    app.post(
      "/admin/billing/rebuild",
      asyncRoute(async (_req, res) => {
        await respondWithRelayControl(res, relayControlClient, {
          method: "POST",
          path: "/internal/control/billing/rebuild",
        });
      }),
    );
    app.post(
      "/admin/email/test",
      asyncRoute(async (req, res) => {
        const to = getOptionalString(req.body?.to);
        if (!to) {
          res.status(400).json({ error: "missing_to", message: "to is required" });
          return;
        }
        const result = await sendEmail({
          to,
          subject: "TokenQiao email test",
          text: "TokenQiao email service test.",
          html: "<p>TokenQiao email service test.</p>",
          tags: { app: "tokenqiao", type: "admin-test" },
        });
        res.json({ ok: true, result });
      }),
    );
    app.post(
      "/admin/billing/balance-alerts/run-now",
      asyncRoute(async (_req, res) => {
        if (!services.balanceAlertScheduler) {
          res.status(503).json({ error: "balance_alerts_disabled" });
          return;
        }
        const result = await services.balanceAlertScheduler.runOnce();
        res.json({ ok: true, result });
      }),
    );
    if (fs.existsSync(ADMIN_UI_DIST_DIR)) {
      app.use(
        express.static(ADMIN_UI_DIST_DIR, {
          index: false,
        }),
      );
      app.get("*", (req, res, next) => {
        if (!shouldServeAdminUi(req)) {
          next();
          return;
        }
        res.type("html").send(renderAdminUiIndex(req));
      });
    }
  }
  if (serviceMode === "relay") {
    app.use("/admin", (_req, res) => {
      res.status(404).json({ error: "not_found" });
    });
    app.use("/internal", (req, res, next) => {
      if (req.path.startsWith("/ccwebapp") || req.path.startsWith("/control")) {
        next();
        return;
      }
      res.status(404).json({ error: "not_found" });
    });
    // Normalize bare /responses and /chat/completions paths
    // (OpenAI SDK / codex CLI may omit /v1 when baseURL has no path prefix)
    app.use((req, _res, next) => {
      if (
        req.path.startsWith("/responses") ||
        req.path === "/chat/completions"
      ) {
        req.url = "/v1" + req.url;
        req.originalUrl = "/v1" + req.originalUrl;
      }
      next();
    });
    app.use((req, res, next) => {
      if (runtimeState && !runtimeState.acceptsNewRelayTraffic()) {
        res.status(503).json(relayDrainingResponseBody(req.path));
        return;
      }
      next();
    });
    // ── Relay catch-all (must be after all admin routes) ──
    app.all("*", async (req, res) => {
      try {
        await services.relayService.handle(req, res);
      } catch (error) {
        const clientError = classifyClientFacingRelayError(error);
        if (!res.headersSent) {
          res.status(clientError?.statusCode ?? 500).json({
            type: "error",
            error: {
              type: "api_error",
              message: clientError?.message ?? "Internal server error.",
              internal_code:
                clientError?.code ?? RELAY_ERROR_CODES.INTERNAL_ERROR,
            },
          });
        } else {
          res.end();
        }
      }
    });
  }
  app.use((error, _req, res, _next) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof AdminSessionAuthError) {
      res.status(error.statusCode).json({
        error: "admin_session_error",
        message: error.message,
      });
      return;
    }
    if (error instanceof BetterAuthRequestError) {
      res.status(error.statusCode).json(error.responseBody);
      return;
    }
    const message = sanitizeErrorMessage(error);
    const statusCode = error instanceof InputValidationError ? 400 : 500;
    res.status(statusCode).json({
      type: "error",
      error: { type: "api_error", message },
    });
  });
  return app;
}
