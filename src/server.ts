// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ProxyAgent, request } from 'undici';
import { AdminSessionAuthError, buildAdminSessionLogoutCookie, exchangeAdminSession, extractBearerToken, getAdminSession, } from './adminSession.js';
import { appConfig } from './config.js';
import { RELAY_ERROR_CODES, classifyClientFacingRelayError } from './proxy/clientFacingErrors.js';
import { InputValidationError, normalizeBillingCurrency, sanitizeErrorMessage } from './security/inputValidation.js';
import { probeRateLimits } from './usage/rateLimitProbe.js';
import { probeOpenAICodexRateLimits } from './usage/openaiRateLimitProbe.js';
import { probeClaudeCompatibleConnectivity } from './usage/claudeCompatibleProbe.js';
import { providerRequiresProxy } from './providers/catalog.js';
const PROXY_CONNECTIVITY_CHECK_URL = 'https://cp.cloudflare.com/generate_204';
const PROXY_EGRESS_IP_URL = 'http://api64.ipify.org?format=json';
const PROXY_PROBE_TIMEOUT_MS = 12_000;
const ADMIN_UI_DIST_DIR = fileURLToPath(new URL('../web/dist', import.meta.url));
const ADMIN_UI_INDEX_PATH = path.join(ADMIN_UI_DIST_DIR, 'index.html');
const STATIC_ASSET_EXTENSIONS = new Set([
    '.avif',
    '.css',
    '.gif',
    '.html',
    '.ico',
    '.jpeg',
    '.jpg',
    '.js',
    '.json',
    '.map',
    '.mjs',
    '.png',
    '.svg',
    '.txt',
    '.webmanifest',
    '.webp',
    '.woff',
    '.woff2',
]);
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
            error: 'unauthorized',
            message: '缺少有效的管理台会话或 admin token',
        });
        return;
    }
    if (req.header('x-admin-csrf') !== session.csrfToken) {
        res.status(403).json({
            error: 'invalid_admin_session',
            message: '管理台会话缺少有效的 CSRF 校验',
        });
        return;
    }
    next();
}
function asyncRoute(handler) {
    return (req, res, next) => {
        void handler(req, res).catch(next);
    };
}
function getOptionalString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function getOptionalBillingCurrency(value, field = 'currency') {
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
    if (normalized === 'relay_api_keys' || normalized === 'relay_users_legacy') {
        return normalized;
    }
    throw new InputValidationError('relayKeySource must be one of: relay_api_keys, relay_users_legacy');
}
function hasOwnProperty(value, key) {
    return Boolean(value) && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
}
function getNullableStringField(body, key) {
    if (!hasOwnProperty(body, key)) {
        return undefined;
    }
    const value = body[key];
    if (value == null) {
        return null;
    }
    if (typeof value === 'string') {
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
    return Array.isArray(value) ? value[0] ?? '' : value;
}
function parseIncomingTierMap(value) {
    if (value === undefined) {
        return undefined;
    }
    if (value === null) {
        return null;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new InputValidationError('modelTierMap must be an object');
    }
    const result = { opus: null, sonnet: null, haiku: null };
    for (const tier of ['opus', 'sonnet', 'haiku']) {
        if (!hasOwnProperty(value, tier)) {
            continue;
        }
        const raw = value[tier];
        if (raw == null) {
            result[tier] = null;
            continue;
        }
        if (typeof raw !== 'string') {
            throw new InputValidationError(`modelTierMap.${tier} must be a string`);
        }
        const trimmed = raw.trim();
        result[tier] = trimmed || null;
    }
    return result;
}
function getRequestOrigin(req) {
    const forwardedProto = req.header('x-forwarded-proto')?.split(',')[0]?.trim();
    const forwardedHost = req.header('x-forwarded-host')?.split(',')[0]?.trim();
    const host = forwardedHost || req.header('host')?.trim();
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
    const accept = req.header('accept') ?? '';
    return accept.includes('text/html') || accept.includes('*/*');
}
function isStaticAssetRequest(requestPath) {
    const extension = path.extname(requestPath);
    return extension ? STATIC_ASSET_EXTENSIONS.has(extension.toLowerCase()) : false;
}
function shouldServeAdminUi(req) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return false;
    }
    if (!requestAcceptsHtml(req)) {
        return false;
    }
    if (isStaticAssetRequest(req.path)) {
        return false;
    }
    if (req.path === '/healthz' ||
        req.path === '/admin' ||
        req.path.startsWith('/admin/') ||
        req.path === '/api' ||
        req.path.startsWith('/api/') ||
        req.path === '/v1' ||
        req.path.startsWith('/v1/')) {
        return false;
    }
    return fs.existsSync(ADMIN_UI_INDEX_PATH);
}
function renderAdminUiIndex(req) {
    const indexHtml = fs.readFileSync(ADMIN_UI_INDEX_PATH, 'utf8');
    const runtimeConfig = JSON.stringify({
        apiBaseUrl: getRequestOrigin(req) ?? '',
        keycloakUrl: appConfig.adminUiKeycloakUrl,
        keycloakRealm: appConfig.adminUiKeycloakRealm,
        keycloakClientId: appConfig.adminUiKeycloakClientId,
    }).replace(/</g, '\\u003c');
    return indexHtml.replace('</head>', `  <script>window.__CCDASH_RUNTIME__=${runtimeConfig};</script>\n</head>`);
}
function applyCorsHeaders(req, res, methods) {
    const origin = req.header('origin');
    if (!origin) {
        return true;
    }
    res.append('Vary', 'Origin');
    if (!isAllowedUiOrigin(req, origin)) {
        return false;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-CSRF');
    res.setHeader('Access-Control-Max-Age', '86400');
    return true;
}
function maskApiKey(apiKey) {
    if (!apiKey) {
        return '';
    }
    if (apiKey.length <= 18) {
        return apiKey;
    }
    return `${apiKey.slice(0, 10)}...${apiKey.slice(-6)}`;
}
function parseIsoTimestamp(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
}
function pickEarliestTimestamp(...values) {
    const timestamps = values
        .map((value) => parseIsoTimestamp(value))
        .filter((value) => typeof value === 'number' && Number.isFinite(value));
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
async function buildUserApiKeyReadResponse(services, user) {
    const activeApiKeys = services.apiKeyStore
        ? await services.apiKeyStore.listForUser(user.id)
        : [];
    const primaryApiKey = activeApiKeys[0] ?? null;
    const legacyApiKey = typeof user.apiKey === 'string' && user.apiKey.trim()
        ? user.apiKey
        : null;
    const apiKeySource = primaryApiKey ? 'relay_api_keys' : 'relay_users_legacy';
    return {
        userId: user.id,
        apiKeySource,
        primaryApiKey,
        activeApiKeyCount: activeApiKeys.length,
        currentApiKeyPlaintextAvailable: !primaryApiKey && Boolean(legacyApiKey),
        apiKey: legacyApiKey,
        apiKeyFieldMode: primaryApiKey
            ? 'compatibility_legacy_plaintext'
            : legacyApiKey
                ? 'legacy_primary_plaintext'
                : 'absent',
        legacyApiKey,
        legacyApiKeySource: legacyApiKey ? 'relay_users_legacy' : null,
        legacyApiKeyRetained: Boolean(legacyApiKey),
        legacyApiKeyDeprecated: Boolean(primaryApiKey && legacyApiKey),
    };
}
function sanitizeAccount(account) {
    const { accessToken, refreshToken, loginPassword, rawProfile, ...rest } = account;
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
function resolveProbeProxyTarget(proxy) {
    if (proxy.localUrl && /^https?:\/\//i.test(proxy.localUrl)) {
        return { via: 'localUrl', proxyUrl: proxy.localUrl };
    }
    if (/^https?:\/\//i.test(proxy.url)) {
        return { via: 'url', proxyUrl: proxy.url };
    }
    return null;
}
function detectIpFamily(ip) {
    if (!ip) {
        return null;
    }
    if (ip.includes(':')) {
        return 'ipv6';
    }
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
        return 'ipv4';
    }
    return 'unknown';
}
async function probeProxyExit(proxy) {
    const checkedAt = new Date().toISOString();
    const target = resolveProbeProxyTarget(proxy);
    if (!target) {
        return {
            proxyId: proxy.id,
            checkedAt,
            via: null,
            status: 'unsupported',
            latencyMs: null,
            httpStatus: null,
            ipLookupStatus: null,
            egressIp: null,
            egressFamily: null,
            error: '缺少可探测的 HTTP 本地代理地址，请先配置 localUrl（例如 http://127.0.0.1:10812）',
        };
    }
    const dispatcher = new ProxyAgent(target.proxyUrl);
    const startedAt = Date.now();
    try {
        const connectivity = await request(PROXY_CONNECTIVITY_CHECK_URL, {
            method: 'GET',
            headers: buildProxyProbeHeaders(),
            dispatcher,
            signal: AbortSignal.timeout(PROXY_PROBE_TIMEOUT_MS),
        });
        const latencyMs = Date.now() - startedAt;
        await connectivity.body.text().catch(() => '');
        // 收到任何 HTTP 响应（含 4xx/5xx）都说明 DNS→TCP→TLS→HTTP 全链路通；
        // 仅目标端点的业务层响应，不作为代理健康度判据。
        const connectivityNotice = connectivity.statusCode >= 400
            ? `连通性端点返回 HTTP ${connectivity.statusCode}（链路可达，目标端点拒绝或无响应体）`
            : null;
        let ipLookupStatus = null;
        let egressIp = null;
        let ipLookupError = null;
        try {
            const ipResponse = await request(PROXY_EGRESS_IP_URL, {
                method: 'GET',
                headers: buildProxyProbeHeaders(),
                dispatcher,
                signal: AbortSignal.timeout(PROXY_PROBE_TIMEOUT_MS),
            });
            ipLookupStatus = ipResponse.statusCode;
            const raw = (await ipResponse.body.text().catch(() => '')).trim();
            if (ipResponse.statusCode >= 400) {
                ipLookupError = `出口 IP 服务返回 HTTP ${ipResponse.statusCode}`;
            }
            else if (raw) {
                try {
                    const parsed = JSON.parse(raw);
                    if (typeof parsed.ip === 'string' && parsed.ip.trim()) {
                        egressIp = parsed.ip.trim();
                    }
                    else {
                        egressIp = raw;
                    }
                }
                catch {
                    egressIp = raw;
                }
            }
            else {
                ipLookupError = '出口 IP 服务返回空响应';
            }
        }
        catch (error) {
            ipLookupError = sanitizeErrorMessage(error);
        }
        const hasDegradation = Boolean(ipLookupError) || Boolean(connectivityNotice);
        const errorMessages = [
            connectivityNotice,
            ipLookupError ? `出口 IP 探测失败: ${ipLookupError}` : null,
        ].filter(Boolean);
        return {
            proxyId: proxy.id,
            checkedAt,
            via: target.via,
            status: hasDegradation ? 'degraded' : 'healthy',
            latencyMs,
            httpStatus: connectivity.statusCode,
            ipLookupStatus,
            egressIp,
            egressFamily: detectIpFamily(egressIp),
            error: errorMessages.length ? errorMessages.join('；') : null,
        };
    }
    catch (error) {
        return {
            proxyId: proxy.id,
            checkedAt,
            via: target.via,
            status: 'error',
            latencyMs: null,
            httpStatus: null,
            ipLookupStatus: null,
            egressIp: null,
            egressFamily: null,
            error: sanitizeErrorMessage(error),
        };
    }
    finally {
        await dispatcher.close().catch(() => { });
    }
}
function classifyRefreshFailure(error) {
    const message = sanitizeErrorMessage(error);
    const normalized = message.toLowerCase();
    if (normalized.includes('invalid_grant') ||
        normalized.includes('invalid refresh token') ||
        normalized.includes('revoked') ||
        normalized.includes('expired') ||
        normalized.includes('unauthorized')) {
        return {
            error: 'refresh_token_revoked',
            tokenStatus: 'refresh_token_revoked',
            refreshError: message.slice(0, 500),
        };
    }
    return {
        error: 'refresh_failed',
        tokenStatus: 'refresh_failed',
        refreshError: message.slice(0, 500),
    };
}
async function probeAccountRateLimitsWithRecovery(input) {
    const initialProxyUrl = await input.oauthService.resolveProxyUrl(input.account.proxyUrl);
    const runProbe = (accessToken) => probeRateLimits({
        accessToken,
        proxyDispatcher: initialProxyUrl && input.proxyPool
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
            tokenStatus: 'ok',
        };
    }
    if (!input.account.refreshToken) {
        return {
            ...initial,
            error: 'refresh_token_missing',
            tokenStatus: 'refresh_token_missing',
            refreshAttempted: false,
            refreshSucceeded: false,
            refreshError: 'Account has no refresh token',
        };
    }
    try {
        const refreshed = await input.oauthService.refreshAccount(input.account.id);
        const refreshedProxyUrl = await input.oauthService.resolveProxyUrl(refreshed.proxyUrl);
        const recovered = await probeRateLimits({
            accessToken: refreshed.accessToken,
            proxyDispatcher: refreshedProxyUrl && input.proxyPool
                ? input.proxyPool.getHttpDispatcher(refreshedProxyUrl)
                : undefined,
            apiBaseUrl: appConfig.anthropicApiBaseUrl,
            anthropicVersion: appConfig.anthropicVersion,
            anthropicBeta: appConfig.oauthBetaHeader,
        });
        return {
            ...recovered,
            tokenStatus: recovered.httpStatus === 401 || recovered.httpStatus === 403 ? 'refreshed_but_still_unauthorized' : 'refreshed',
            refreshAttempted: true,
            refreshSucceeded: recovered.httpStatus !== 401 && recovered.httpStatus !== 403,
            refreshError: recovered.httpStatus === 401 || recovered.httpStatus === 403
                ? 'Probe is still unauthorized after refresh'
                : null,
        };
    }
    catch (error) {
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
export function createServer(services) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', true);
    app.options('/healthz', (req, res) => {
        if (!applyCorsHeaders(req, res, 'GET, OPTIONS')) {
            res.status(403).end();
            return;
        }
        res.status(204).end();
    });
    app.get('/healthz', asyncRoute(async (req, res) => {
        if (!applyCorsHeaders(req, res, 'GET, OPTIONS')) {
            res.status(403).json({
                error: 'origin_not_allowed',
                message: '当前来源未被允许访问管理台',
            });
            return;
        }
        const accounts = await services.oauthService.listAccounts();
        const nextAccount = await services.oauthService.getDefaultAccountPreview();
        res.json({
            ok: true,
            accountCount: accounts.length,
            activeAccountCount: accounts.filter((account) => account.isActive).length,
            nextAccountId: nextAccount?.id ?? null,
            nextAccountEmail: nextAccount?.emailAddress ?? null,
        });
    }));
    app.use('/admin', (req, res, next) => {
        if (!applyCorsHeaders(req, res, 'GET, POST, PUT, DELETE, OPTIONS')) {
            if (req.method === 'OPTIONS') {
                res.status(403).end();
                return;
            }
            res.status(403).json({
                error: 'origin_not_allowed',
                message: '当前来源未被允许访问管理台',
            });
            return;
        }
        if (req.method === 'OPTIONS') {
            res.status(204).end();
            return;
        }
        next();
    });

    // ── Internal API for cc-webapp ──
    function requireInternalToken(req, res, next) {
        const token = appConfig.internalToken;
        if (!token) {
            res.status(503).json({
                error: 'internal_api_disabled',
                message: 'INTERNAL_TOKEN is not configured',
            });
            return;
        }
        const bearerToken = extractBearerToken(req);
        if (bearerToken !== token) {
            res.status(401).json({
                error: 'unauthorized',
                message: 'Missing or invalid bearer token',
            });
            return;
        }
        next();
    }
    app.use('/internal/ccwebapp', requireInternalToken, express.json({ limit: '256kb' }));

    app.post('/internal/ccwebapp/users/sync', asyncRoute(async (req, res) => {
        if (!services.userStore) {
            res.status(503).json({ error: 'user_management_disabled' });
            return;
        }
        const externalUserId = getNullableStringField(req.body, 'externalUserId');
        if (!externalUserId) {
            res.status(400).json({ error: 'missing_external_user_id', message: 'externalUserId is required' });
            return;
        }
        const displayName = getNullableStringField(req.body, 'displayName');
        const email = getNullableStringField(req.body, 'email');
        const fallbackName = displayName || email || externalUserId;
        const { user, created } = await services.userStore.findOrCreateByExternalId({
            externalUserId,
            name: fallbackName,
            billingCurrency: req.body?.billingCurrency ?? 'CNY',
        });
        if (!created && displayName && user.name !== displayName) {
            const updated = await services.userStore.updateUser(user.id, { name: displayName });
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
    }));

    app.get('/internal/ccwebapp/users/:relayUserId/api-keys', asyncRoute(async (req, res) => {
        if (!services.userStore || !services.apiKeyStore) {
            res.status(503).json({ error: 'api_key_management_disabled' });
            return;
        }
        const relayUserId = getRouteParam(req.params.relayUserId);
        const user = await services.userStore.getUserById(relayUserId);
        if (!user) {
            res.status(404).json({ error: 'user_not_found' });
            return;
        }
        const apiKeys = await services.apiKeyStore.listForUser(relayUserId);
        res.json({ apiKeys, max: 100 });
    }));

    app.post('/internal/ccwebapp/users/:relayUserId/api-keys', asyncRoute(async (req, res) => {
        if (!services.userStore || !services.apiKeyStore) {
            res.status(503).json({ error: 'api_key_management_disabled' });
            return;
        }
        const relayUserId = getRouteParam(req.params.relayUserId);
        const user = await services.userStore.getUserById(relayUserId);
        if (!user) {
            res.status(404).json({ error: 'user_not_found' });
            return;
        }
        const rawName = typeof req.body?.name === 'string' ? req.body.name : '';
        try {
            const created = await services.apiKeyStore.create(relayUserId, { name: rawName });
            res.json({ created: true, ...created });
        } catch (err) {
            const code = err && typeof err === 'object' && 'code' in err
                ? String((err).code)
                : null;
            const message = err instanceof Error ? err.message : 'create_failed';
            if (code === 'api_key_quota_exceeded') {
                res.status(409).json({ error: code, message });
                return;
            }
            res.status(500).json({ error: 'create_failed', message });
        }
    }));

    app.delete('/internal/ccwebapp/users/:relayUserId/api-keys/:keyId', asyncRoute(async (req, res) => {
        if (!services.userStore || !services.apiKeyStore) {
            res.status(503).json({ error: 'api_key_management_disabled' });
            return;
        }
        const relayUserId = getRouteParam(req.params.relayUserId);
        const keyId = getRouteParam(req.params.keyId);
        const revoked = await services.apiKeyStore.revoke(relayUserId, keyId);
        if (!revoked) {
            res.status(404).json({ error: 'api_key_not_found' });
            return;
        }
        res.json({ revoked: true, apiKey: revoked });
    }));

    app.get('/internal/ccwebapp/users/:relayUserId/summary', asyncRoute(async (req, res) => {
        if (!services.userStore) {
            res.status(503).json({ error: 'user_management_disabled' });
            return;
        }
        const relayUserId = getRouteParam(req.params.relayUserId);
        const user = await services.userStore.getUserById(relayUserId);
        if (!user) {
            res.status(404).json({ error: 'user_not_found' });
            return;
        }
        const balance = services.billingStore
            ? await services.billingStore.getUserBalanceSummary(relayUserId)
            : null;
        const usage = await services.userStore.getUserRequests(relayUserId, 1, 0);
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
    }));

    app.get('/internal/ccwebapp/users/:relayUserId/usage', asyncRoute(async (req, res) => {
        if (!services.userStore || !services.billingStore) {
            res.status(503).json({ error: 'billing_disabled' });
            return;
        }
        const relayUserId = getRouteParam(req.params.relayUserId);
        const user = await services.userStore.getUserById(relayUserId);
        if (!user) {
            res.status(404).json({ error: 'user_not_found' });
            return;
        }
        const { sinceParam, limitParam, offsetParam } = req.query as Record<string, string | undefined>;
        const sinceDate = sinceParam ? new Date(sinceParam) : null;
        const since = sinceDate && !Number.isNaN(sinceDate.getTime()) ? sinceDate : null;
        const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
        const offset = offsetParam ? Number.parseInt(offsetParam, 10) : 0;
        const snapshot = await services.billingStore.getUserUsageSnapshot(
            relayUserId,
            since,
            Number.isFinite(limit) ? limit : 50,
            Number.isFinite(offset) ? offset : 0,
        );
        res.json({ usage: snapshot });
    }));

    app.get('/internal/ccwebapp/price-rules', asyncRoute(async (req, res) => {
        if (!services.billingStore) {
            res.status(503).json({ error: 'billing_disabled' });
            return;
        }
        const currencyParam = typeof req.query?.currency === 'string' ? req.query.currency : null;
        const rules = await services.billingStore.listRules(currencyParam as 'USD' | 'CNY' | null);
        const sanitized = rules
            .filter((rule) =>
                rule.isActive
                && rule.userId === null
                && rule.accountId === null
                && rule.provider === null,
            )
            .map((rule) => ({
                id: rule.id,
                name: rule.name,
                priority: rule.priority,
                currency: rule.currency,
                model: rule.model,
                isFallback: rule.model === null,
                effectiveFrom: rule.effectiveFrom,
                effectiveTo: rule.effectiveTo,
                inputPriceMicrosPerMillion: rule.inputPriceMicrosPerMillion,
                outputPriceMicrosPerMillion: rule.outputPriceMicrosPerMillion,
                cacheCreationPriceMicrosPerMillion: rule.cacheCreationPriceMicrosPerMillion,
                cacheReadPriceMicrosPerMillion: rule.cacheReadPriceMicrosPerMillion,
            }));
        res.json({ rules: sanitized });
    }));

    app.post('/internal/ccwebapp/users/:relayUserId/topup', asyncRoute(async (req, res) => {
        if (!services.userStore || !services.billingStore) {
            res.status(503).json({ error: 'billing_disabled' });
            return;
        }
        const relayUserId = getRouteParam(req.params.relayUserId);
        const user = await services.userStore.getUserById(relayUserId);
        if (!user) {
            res.status(404).json({ error: 'user_not_found' });
            return;
        }
        const amountMicros = req.body?.amountMicros;
        if (amountMicros === undefined || amountMicros === null) {
            res.status(400).json({ error: 'missing_amount', message: 'amountMicros is required' });
            return;
        }
        const billingCurrency = getOptionalBillingCurrency(req.body?.currency, 'currency');
        const userUpdates: { billingMode?: 'prepaid'; billingCurrency?: 'USD' | 'CNY' } = {};
        if (user.billingMode !== 'prepaid') {
            userUpdates.billingMode = 'prepaid';
        }
        if (billingCurrency && user.billingCurrency !== billingCurrency) {
            try {
                await services.billingStore.assertUserCurrencyChangeAllowed(relayUserId, billingCurrency);
                userUpdates.billingCurrency = billingCurrency;
            }
            catch (error) {
                const message = sanitizeErrorMessage(error);
                res.status(400).json({ error: 'billing_currency_mismatch', message });
                return;
            }
        }
        if (Object.keys(userUpdates).length > 0) {
            await services.userStore.updateUser(relayUserId, userUpdates);
        }
        const note = getNullableStringField(req.body, 'note');
        const idempotencyKey = getNullableStringField(req.body, 'idempotencyKey');
        try {
            const result = await services.billingStore.createLedgerEntry({
                userId: relayUserId,
                kind: 'topup',
                amountMicros,
                note,
                externalRef: idempotencyKey,
            });
            res.json({
                ok: true,
                idempotent: result.idempotent === true,
                entry: result.entry,
                balance: result.balance,
            });
        } catch (error) {
            if (error instanceof InputValidationError) {
                res.status(400).json({ error: 'invalid_topup', message: error.message });
                return;
            }
            throw error;
        }
    }));

    app.post('/admin/session/exchange', asyncRoute(async (req, res) => {
        const keycloakAccessToken = extractBearerToken(req);
        if (!keycloakAccessToken) {
            res.status(401).json({
                error: 'missing_access_token',
                message: '缺少 Keycloak access token',
            });
            return;
        }
        const session = await exchangeAdminSession(req, keycloakAccessToken);
        res.setHeader('Set-Cookie', session.cookie);
        res.json({
            ok: true,
            user: session.user,
            csrfToken: session.csrfToken,
        });
    }));
    app.get('/admin/session/me', asyncRoute(async (req, res) => {
        const session = getAdminSession(req);
        if (!session) {
            res.status(401).json({
                error: 'admin_session_missing',
                message: '当前管理台会话不存在或已过期',
            });
            return;
        }
        res.json({
            ok: true,
            user: session.user,
            csrfToken: session.csrfToken,
        });
    }));
    app.post('/admin/session/logout', asyncRoute(async (req, res) => {
        res.setHeader('Set-Cookie', buildAdminSessionLogoutCookie(req));
        res.json({ ok: true });
    }));
    app.use('/admin', requireAdminToken, express.json({ limit: '1mb' }));
    app.get('/admin/account', asyncRoute(async (_req, res) => {
        const accounts = await services.oauthService.listAccounts();
        res.json({
            account: accounts[0] ? sanitizeAccount(accounts[0]) : null,
            accounts: sanitizeAccounts(accounts),
        });
    }));
    app.get('/admin/accounts', asyncRoute(async (_req, res) => {
        const accounts = await services.oauthService.listAccounts();
        res.json({
            accounts: sanitizeAccounts(accounts),
        });
    }));
    app.get('/admin/accounts/:accountId', asyncRoute(async (req, res) => {
        const accountId = getRouteParam(req.params.accountId);
        const account = await services.oauthService.getAccount(accountId);
        if (!account) {
            res.status(404).json({
                error: 'account_not_found',
                message: `账号不存在: ${accountId}`,
            });
            return;
        }
        res.json({ account: sanitizeAccount(account) });
    }));
    app.get('/admin/sticky-sessions', asyncRoute(async (_req, res) => {
        const stickySessions = await services.oauthService.listStickySessions();
        const sessionRoutes = await services.oauthService.listSessionRoutes();
        const recentHandoffs = await services.oauthService.listSessionHandoffs(50);
        res.json({
            stickySessions,
            sessionRoutes,
            recentHandoffs,
        });
    }));
    app.post('/admin/sticky-sessions/clear', asyncRoute(async (_req, res) => {
        await services.oauthService.clearStickySessions();
        res.json({ ok: true });
    }));
    app.post('/admin/account/clear', asyncRoute(async (_req, res) => {
        await services.oauthService.clearStoredAccounts();
        res.json({ ok: true });
    }));
    app.post('/admin/accounts/:accountId/delete', asyncRoute(async (req, res) => {
        const accountId = getRouteParam(req.params.accountId);
        const deleted = await services.oauthService.deleteAccount(accountId);
        if (!deleted) {
            res.status(404).json({
                error: 'account_not_found',
                message: `账号不存在: ${accountId}`,
            });
            return;
        }
        res.json({
            ok: true,
            account: sanitizeAccount(deleted),
        });
    }));
    app.post('/admin/accounts/create', asyncRoute(async (req, res) => {
        const provider = getOptionalString(req.body?.provider) ?? 'claude-official';
        const routingGroupId = getFirstDefinedNullableString(req.body, ['routingGroupId', 'group']);
        if (provider === 'openai-compatible') {
            const apiKey = String(req.body?.apiKey ?? '').trim();
            const apiBaseUrl = String(req.body?.apiBaseUrl ?? '').trim();
            const modelName = String(req.body?.modelName ?? '').trim();
            if (!apiKey) {
                res.status(400).json({ error: 'missing_api_key', message: 'apiKey is required' });
                return;
            }
            if (!apiBaseUrl) {
                res.status(400).json({ error: 'missing_api_base_url', message: 'apiBaseUrl is required' });
                return;
            }
            const account = await services.oauthService.createOpenAICompatibleAccount({
                apiKey,
                apiBaseUrl,
                modelName: modelName || null,
                label: getOptionalString(req.body?.label),
                proxyUrl: getOptionalString(req.body?.proxyUrl) ?? null,
                routingGroupId,
            });
            res.json({ ok: true, account: sanitizeAccount(account) });
            return;
        }
        if (provider === 'claude-compatible') {
            const apiKey = String(req.body?.apiKey ?? '').trim();
            const apiBaseUrl = String(req.body?.apiBaseUrl ?? '').trim();
            const modelName = String(req.body?.modelName ?? '').trim();
            if (!apiKey) {
                res.status(400).json({ error: 'missing_api_key', message: 'apiKey is required' });
                return;
            }
            if (!apiBaseUrl) {
                res.status(400).json({ error: 'missing_api_base_url', message: 'apiBaseUrl is required' });
                return;
            }
            if (!modelName) {
                res.status(400).json({ error: 'missing_model_name', message: 'modelName is required' });
                return;
            }
            const account = await services.oauthService.createClaudeCompatibleAccount({
                apiKey,
                apiBaseUrl,
                modelName,
                modelTierMap: parseIncomingTierMap(req.body?.modelTierMap),
                label: getOptionalString(req.body?.label),
                proxyUrl: getOptionalString(req.body?.proxyUrl) ?? null,
                routingGroupId,
            });
            res.json({ ok: true, account: sanitizeAccount(account) });
            return;
        }
        if (provider !== 'claude-official') {
            res.status(400).json({
                error: 'unsupported_provider',
                message: `Unsupported provider: ${provider}`,
            });
            return;
        }
        const email = String(req.body?.email ?? '').trim();
        if (!email) {
            res.status(400).json({ error: 'missing_email', message: 'email is required' });
            return;
        }
        const account = await services.oauthService.createSimpleAccount({
            email,
            password: getOptionalString(req.body?.password),
            label: getOptionalString(req.body?.label),
            routingGroupId,
        });
        res.json({ ok: true, account: sanitizeAccount(account) });
    }));
    app.get('/admin/routing-groups', asyncRoute(async (_req, res) => {
        const routingGroups = await services.oauthService.listRoutingGroups();
        res.json({ routingGroups });
    }));
    app.post('/admin/routing-groups', asyncRoute(async (req, res) => {
        const id = String(req.body?.id ?? '').trim();
        if (!id) {
            res.status(400).json({ error: 'missing_routing_group_id', message: 'id is required' });
            return;
        }
        const routingGroup = await services.oauthService.createRoutingGroup({
            id,
            name: getNullableStringField(req.body, 'name'),
            description: getNullableStringField(req.body, 'description'),
            isActive: typeof req.body?.isActive === 'boolean' ? req.body.isActive : undefined,
        });
        res.json({ ok: true, routingGroup });
    }));
    app.post('/admin/routing-groups/:groupId/update', asyncRoute(async (req, res) => {
        const groupId = getRouteParam(req.params.groupId);
        const routingGroup = await services.oauthService.updateRoutingGroup(groupId, {
            name: getNullableStringField(req.body, 'name'),
            description: getNullableStringField(req.body, 'description'),
            isActive: typeof req.body?.isActive === 'boolean' ? req.body.isActive : undefined,
        });
        if (!routingGroup) {
            res.status(404).json({ error: 'routing_group_not_found', message: `路由组不存在: ${groupId}` });
            return;
        }
        res.json({ ok: true, routingGroup });
    }));
    app.post('/admin/routing-groups/:groupId/delete', asyncRoute(async (req, res) => {
        const groupId = getRouteParam(req.params.groupId);
        const existing = await services.oauthService.getRoutingGroup(groupId);
        if (!existing) {
            res.status(404).json({ error: 'routing_group_not_found', message: `路由组不存在: ${groupId}` });
            return;
        }
        const linkedAccounts = (await services.oauthService.listAccounts()).filter((account) => (account.routingGroupId ?? account.group) === groupId);
        if (linkedAccounts.length > 0) {
            res.status(409).json({
                error: 'routing_group_in_use',
                message: `路由组仍被 ${linkedAccounts.length} 个账号引用，无法删除`,
            });
            return;
        }
        const linkedUsers = services.userStore
            ? (await services.userStore.listUsers()).filter((user) => (user.routingGroupId ?? user.preferredGroup) === groupId)
            : [];
        if (linkedUsers.length > 0) {
            res.status(409).json({
                error: 'routing_group_in_use',
                message: `路由组仍被 ${linkedUsers.length} 个用户引用，无法删除`,
            });
            return;
        }
        const deleted = await services.oauthService.deleteRoutingGroup(groupId);
        res.json({ ok: true, routingGroup: deleted });
    }));
    app.post('/admin/oauth/generate-auth-url', asyncRoute(async (req, res) => {
        const provider = getOptionalString(req.body?.provider) ?? 'claude-official';
        if (provider !== 'claude-official' && provider !== 'openai-codex') {
            res.status(400).json({
                error: 'unsupported_provider',
                message: `Unsupported provider: ${provider}`,
            });
            return;
        }
        const expiresIn = typeof req.body?.expiresIn === 'number' && Number.isFinite(req.body.expiresIn)
            ? req.body.expiresIn
            : undefined;
        const session = services.oauthService.createAuthSession({ provider, expiresIn });
        const instructions = provider === 'openai-codex'
            ? [
                '1. 打开 authUrl，用 ChatGPT 账号完成 Codex 登录。',
                '2. 完成后浏览器会跳到 localhost 回调地址；即使页面打不开，也可以直接复制地址栏里的完整回调 URL。',
                '3. 把完整回调 URL 或其中的 code 粘贴到 /admin/oauth/exchange-code 完成落盘。',
            ]
            : [
                '1. 打开 authUrl 登录 Claude.ai。',
                '2. 完成后复制浏览器最终回调 URL，或只复制 code。',
                '3. 调用 /admin/oauth/exchange-code 完成 token 落盘。',
            ];
        res.json({
            ok: true,
            session,
            instructions,
        });
    }));
    app.post('/admin/oauth/exchange-code', asyncRoute(async (req, res) => {
        const sessionId = String(req.body?.sessionId ?? '');
        const authorizationInput = String(req.body?.authorizationInput ?? '');
        const label = getOptionalString(req.body?.label);
        const accountId = getOptionalString(req.body?.accountId);
        const account = await services.oauthService.exchangeCode({
            sessionId,
            authorizationInput,
            label,
            accountId,
            modelName: getOptionalString(req.body?.modelName) ?? null,
            proxyUrl: getOptionalString(req.body?.proxyUrl) ?? null,
            apiBaseUrl: getOptionalString(req.body?.apiBaseUrl) ?? null,
            routingGroupId: getFirstDefinedNullableString(req.body, ['routingGroupId', 'group']),
        });
        res.json({ ok: true, account: sanitizeAccount(account) });
    }));
    app.post('/admin/oauth/login-with-session-key', asyncRoute(async (req, res) => {
        const sessionKey = String(req.body?.sessionKey ?? '');
        const label = getOptionalString(req.body?.label);
        const routingGroupId = getFirstDefinedNullableString(req.body, ['routingGroupId', 'group']);
        const account = await services.oauthService.loginWithSessionKey(sessionKey, label, routingGroupId);
        res.json({ ok: true, account: sanitizeAccount(account) });
    }));
    app.post('/admin/oauth/import-tokens', asyncRoute(async (req, res) => {
        const accessToken = String(req.body?.accessToken ?? '').trim();
        const refreshToken = getOptionalString(req.body?.refreshToken);
        const label = getOptionalString(req.body?.label);
        if (!accessToken) {
            res.status(400).json({ error: 'missing_access_token', message: 'accessToken is required' });
            return;
        }
        const account = await services.oauthService.importTokens({
            accessToken,
            refreshToken: refreshToken ?? null,
            label,
            routingGroupId: getFirstDefinedNullableString(req.body, ['routingGroupId', 'group']),
        });
        res.json({ ok: true, account: sanitizeAccount(account) });
    }));
    app.post('/admin/oauth/refresh', asyncRoute(async (req, res) => {
        const accountId = getOptionalString(req.body?.accountId);
        if (accountId) {
            const account = await services.oauthService.refreshAccount(accountId);
            res.json({ ok: true, account: sanitizeAccount(account) });
            return;
        }
        const results = await services.oauthService.refreshAllAccounts();
        res.json({
            ok: true,
            results: results.map((result) => result.ok
                ? { ...result, account: sanitizeAccount(result.account) }
                : result),
        });
    }));
    app.post('/admin/oauth/gemini/start', asyncRoute(async (req, res) => {
        if (!services.geminiLoopback) {
            res.status(503).json({ error: 'gemini_loopback_unavailable', message: 'Gemini loopback OAuth controller is not initialised.' });
            return;
        }
        try {
            const result = await services.geminiLoopback.startLogin({
                label: getOptionalString(req.body?.label),
                proxyUrl: getOptionalString(req.body?.proxyUrl),
                modelName: getOptionalString(req.body?.modelName),
                routingGroupId: getFirstDefinedNullableString(req.body, ['routingGroupId', 'group']),
                accountId: getOptionalString(req.body?.accountId),
            });
            res.json({
                ok: true,
                provider: 'google-gemini-oauth',
                session: result,
                instructions: [
                    '1. 在浏览器（ncu 本机）打开 authUrl，登录 Google 账号并授权。',
                    '2. Google 会跳转到 ' + result.redirectUri + '，即由 cor 进程内部的 loopback server 接住。',
                    '3. 然后调用 /admin/oauth/gemini/status?sessionId=' + result.sessionId + ' 查询登录是否完成。',
                ],
            });
        } catch (error) {
            res.status(500).json({ error: 'gemini_login_start_failed', message: error instanceof Error ? error.message : String(error) });
        }
    }));
    app.get('/admin/oauth/gemini/status', asyncRoute(async (req, res) => {
        if (!services.geminiLoopback) {
            res.status(503).json({ error: 'gemini_loopback_unavailable' });
            return;
        }
        const sessionId = getOptionalString(req.query?.sessionId);
        if (!sessionId) {
            res.status(400).json({ error: 'missing_session_id' });
            return;
        }
        const status = services.geminiLoopback.getStatus(sessionId);
        res.json({
            ok: true,
            sessionId: status.sessionId,
            status: status.status,
            account: status.account ? sanitizeAccount(status.account) : null,
            error: status.error ?? null,
        });
    }));
    app.post('/admin/accounts/:accountId/settings', asyncRoute(async (req, res) => {
        const accountId = getRouteParam(req.params.accountId);
        const settings = {};
        const routingGroupId = getFirstDefinedNullableString(req.body, ['routingGroupId', 'group']);
        if (routingGroupId !== undefined)
            settings.routingGroupId = routingGroupId;
        if (req.body?.maxSessions !== undefined)
            settings.maxSessions = req.body.maxSessions;
        if (req.body?.weight !== undefined)
            settings.weight = req.body.weight;
        if (req.body?.planType !== undefined)
            settings.planType = req.body.planType;
        if (req.body?.planMultiplier !== undefined)
            settings.planMultiplier = req.body.planMultiplier;
        if (req.body?.schedulerEnabled !== undefined)
            settings.schedulerEnabled = Boolean(req.body.schedulerEnabled);
        if (req.body?.schedulerState !== undefined)
            settings.schedulerState = String(req.body.schedulerState);
        if (req.body?.proxyUrl !== undefined)
            settings.proxyUrl = req.body.proxyUrl;
        if (req.body?.bodyTemplatePath !== undefined)
            settings.bodyTemplatePath = req.body.bodyTemplatePath;
        if (req.body?.vmFingerprintTemplatePath !== undefined)
            settings.vmFingerprintTemplatePath = req.body.vmFingerprintTemplatePath;
        if (req.body?.label !== undefined)
            settings.label = req.body.label;
        if (req.body?.apiBaseUrl !== undefined)
            settings.apiBaseUrl = req.body.apiBaseUrl;
        if (req.body?.modelName !== undefined)
            settings.modelName = req.body.modelName;
        if (req.body?.modelTierMap !== undefined)
            settings.modelTierMap = parseIncomingTierMap(req.body.modelTierMap);
        const account = await services.oauthService.updateAccountSettings(accountId, settings);
        res.json({ ok: true, account: sanitizeAccount(account) });
    }));
    app.post('/admin/accounts/:accountId/refresh', asyncRoute(async (req, res) => {
        const accountId = getRouteParam(req.params.accountId);
        const account = await services.oauthService.refreshAccount(accountId);
        res.json({ ok: true, account: sanitizeAccount(account) });
    }));
    app.get('/admin/scheduler/stats', asyncRoute(async (_req, res) => {
        const stats = await services.oauthService.getSchedulerStats();
        res.json(stats);
    }));
    app.get('/admin/session-routes', asyncRoute(async (_req, res) => {
        const sessionRoutes = await services.oauthService.listSessionRoutes();
        const recentHandoffs = await services.oauthService.listSessionHandoffs(200);
        res.json({ sessionRoutes, recentHandoffs });
    }));
    app.post('/admin/session-routes/clear', asyncRoute(async (_req, res) => {
        await services.oauthService.clearSessionRoutes();
        res.json({ ok: true });
    }));
    // ── Rate limit probe ──
    app.get('/admin/accounts/:accountId/ratelimit', asyncRoute(async (req, res) => {
        const accountId = getRouteParam(req.params.accountId);
        const account = await services.oauthService.getAccount(accountId);
        if (!account) {
            res.status(404).json({ error: 'account_not_found', message: `账号不存在: ${accountId}` });
            return;
        }
        if (account.provider === 'openai-codex') {
            const proxyUrl = await services.oauthService.resolveProxyUrl(account.proxyUrl);
            const result = await probeOpenAICodexRateLimits({
                accessToken: account.accessToken,
                organizationUuid: account.organizationUuid,
                apiBaseUrl: account.apiBaseUrl || appConfig.openAICodexApiBaseUrl,
                model: account.modelName || appConfig.openAICodexModel,
                proxyDispatcher: proxyUrl && services.proxyPool
                    ? services.proxyPool.getHttpDispatcher(proxyUrl)
                    : undefined,
            });
            if (result.status || result.fiveHourUtilization != null || result.sevenDayUtilization != null) {
                await services.oauthService.recordRateLimitSnapshot({
                    accountId,
                    status: result.status ?? null,
                    fiveHourUtilization: result.fiveHourUtilization ?? null,
                    sevenDayUtilization: result.sevenDayUtilization ?? null,
                    resetTimestamp: pickEarliestTimestamp(result.fiveHourReset, result.sevenDayReset),
                });
            }
            res.json(result);
            return;
        }
        if (account.provider === 'claude-compatible') {
            const proxyUrl = await services.oauthService.resolveProxyUrl(account.proxyUrl);
            const result = await probeClaudeCompatibleConnectivity({
                account,
                anthropicVersion: appConfig.anthropicVersion,
                proxyDispatcher: proxyUrl && services.proxyPool
                    ? services.proxyPool.getHttpDispatcher(proxyUrl)
                    : undefined,
                bodyTemplate: appConfig.bodyTemplateNew ?? appConfig.bodyTemplate ?? null,
            });
            res.json(result);
            return;
        }
        if (providerRequiresProxy(account.provider) && !account.proxyUrl) {
            res.status(400).json({ error: 'no_proxy', message: `账号未绑定代理: ${accountId}` });
            return;
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
        res.json(result);
    }));
    // ── User management ──
    app.get('/admin/users', asyncRoute(async (_req, res) => {
        if (!services.userStore) {
            res.status(404).json({ error: 'user_management_disabled' });
            return;
        }
        const users = await services.userStore.listUsersWithUsage();
        res.json({ users: users.map((user) => sanitizeUser(user)) });
    }));
    app.post('/admin/users', asyncRoute(async (req, res) => {
        if (!services.userStore) {
            res.status(404).json({ error: 'user_management_disabled' });
            return;
        }
        const name = getNullableStringField(req.body, 'name');
        if (!name) {
            res.status(400).json({ error: 'missing_name', message: 'name is required' });
            return;
        }
        const user = await services.userStore.createUser(name, req.body?.billingCurrency);
        let issuedApiKey = user.apiKey;
        let apiKeySource = 'relay_users_legacy';
        let primaryApiKey = null;
        if (services.apiKeyStore) {
            try {
                primaryApiKey = await services.apiKeyStore.create(user.id, { name: 'Default Key' });
                issuedApiKey = primaryApiKey.apiKey;
                apiKeySource = 'relay_api_keys';
            }
            catch (_error) {
                apiKeySource = 'relay_users_legacy';
            }
        }
        res.json({
            ok: true,
            user: sanitizeUser(user),
            apiKey: issuedApiKey,
            apiKeySource,
            primaryApiKey,
        });
    }));
    app.get('/admin/users/:userId', asyncRoute(async (req, res) => {
        if (!services.userStore) {
            res.status(404).json({ error: 'user_management_disabled' });
            return;
        }
        const userId = getRouteParam(req.params.userId);
        const user = await services.userStore.getUserById(userId);
        if (!user) {
            res.status(404).json({ error: 'user_not_found' });
            return;
        }
        const relayKeySourceSummary = typeof services.userStore.getUserRelayKeySourceSummary === 'function'
            ? await services.userStore.getUserRelayKeySourceSummary(userId)
            : undefined;
        res.json({ user: sanitizeUser({ ...user, relayKeySourceSummary }) });
    }));
    app.get('/admin/users/:userId/api-key', asyncRoute(async (req, res) => {
        if (!services.userStore) {
            res.status(404).json({ error: 'user_management_disabled' });
            return;
        }
        const userId = getRouteParam(req.params.userId);
        const user = await services.userStore.getUserById(userId);
        if (!user) {
            res.status(404).json({ error: 'user_not_found' });
            return;
        }
        res.json(await buildUserApiKeyReadResponse(services, user));
    }));
    app.get('/admin/users/:userId/api-keys', asyncRoute(async (req, res) => {
        if (!services.userStore || !services.apiKeyStore) {
            res.status(404).json({ error: 'api_key_management_disabled' });
            return;
        }
        const userId = getRouteParam(req.params.userId);
        const user = await services.userStore.getUserById(userId);
        if (!user) {
            res.status(404).json({ error: 'user_not_found' });
            return;
        }
        const apiKeys = await services.apiKeyStore.listForUser(userId);
        res.json({ apiKeys, max: 100 });
    }));
    app.post('/admin/users/:userId/api-keys', asyncRoute(async (req, res) => {
        if (!services.userStore || !services.apiKeyStore) {
            res.status(404).json({ error: 'api_key_management_disabled' });
            return;
        }
        const userId = getRouteParam(req.params.userId);
        const user = await services.userStore.getUserById(userId);
        if (!user) {
            res.status(404).json({ error: 'user_not_found' });
            return;
        }
        const rawName = typeof req.body?.name === 'string' ? req.body.name : '';
        try {
            const created = await services.apiKeyStore.create(userId, { name: rawName });
            res.json({ created: true, ...created });
        }
        catch (err) {
            const code = err && typeof err === 'object' && 'code' in err
                ? String((err).code)
                : null;
            const message = err instanceof Error ? err.message : 'create_failed';
            if (code === 'api_key_quota_exceeded') {
                res.status(409).json({ error: code, message });
                return;
            }
            res.status(500).json({ error: 'create_failed', message });
        }
    }));
    app.delete('/admin/users/:userId/api-keys/:keyId', asyncRoute(async (req, res) => {
        if (!services.userStore || !services.apiKeyStore) {
            res.status(404).json({ error: 'api_key_management_disabled' });
            return;
        }
        const userId = getRouteParam(req.params.userId);
        const keyId = getRouteParam(req.params.keyId);
        const user = await services.userStore.getUserById(userId);
        if (!user) {
            res.status(404).json({ error: 'user_not_found' });
            return;
        }
        const revoked = await services.apiKeyStore.revoke(userId, keyId);
        if (!revoked) {
            res.status(404).json({ error: 'api_key_not_found' });
            return;
        }
        res.json({ revoked: true, apiKey: revoked });
    }));
    app.post('/admin/users/:userId/update', asyncRoute(async (req, res) => {
        if (!services.userStore) {
            res.status(404).json({ error: 'user_management_disabled' });
            return;
        }
        const userId = getRouteParam(req.params.userId);
        const updates = {};
        if (req.body?.name !== undefined)
            updates.name = req.body.name;
        if (req.body?.accountId !== undefined)
            updates.accountId = req.body.accountId;
        if (req.body?.routingMode !== undefined)
            updates.routingMode = String(req.body.routingMode);
        const userRoutingGroupId = getFirstDefinedNullableString(req.body, ['routingGroupId', 'preferredGroup']);
        if (userRoutingGroupId !== undefined) {
            updates.routingGroupId = userRoutingGroupId;
            updates.preferredGroup = userRoutingGroupId;
        }
        if (req.body?.billingMode !== undefined)
            updates.billingMode = String(req.body.billingMode) === 'prepaid' ? 'prepaid' : 'postpaid';
        if (req.body?.billingCurrency !== undefined) {
            const billingCurrency = normalizeBillingCurrency(req.body.billingCurrency, { field: 'billingCurrency' });
            if (services.billingStore) {
                await services.billingStore.assertUserCurrencyChangeAllowed(userId, billingCurrency);
            }
            updates.billingCurrency = billingCurrency;
        }
        if (req.body?.isActive !== undefined)
            updates.isActive = Boolean(req.body.isActive);
        const user = await services.userStore.updateUser(userId, updates);
        if (!user) {
            res.status(404).json({ error: 'user_not_found' });
            return;
        }
        res.json({ ok: true, user: sanitizeUser(user) });
    }));
    app.post('/admin/users/:userId/delete', asyncRoute(async (req, res) => {
        if (!services.userStore) {
            res.status(404).json({ error: 'user_management_disabled' });
            return;
        }
        const userId = getRouteParam(req.params.userId);
        const deleted = await services.userStore.deleteUser(userId);
        if (!deleted) {
            res.status(404).json({ error: 'user_not_found' });
            return;
        }
        res.json({ ok: true });
    }));
    app.post('/admin/users/:userId/regenerate-key', asyncRoute(async (req, res) => {
        if (!services.userStore) {
            res.status(404).json({ error: 'user_management_disabled' });
            return;
        }
        const userId = getRouteParam(req.params.userId);
        const user = await services.userStore.getUserById(userId);
        if (!user) {
            res.status(404).json({ error: 'user_not_found' });
            return;
        }
        if (!services.apiKeyStore) {
            const regenerated = await services.userStore.regenerateApiKey(userId);
            if (!regenerated) {
                res.status(404).json({ error: 'user_not_found' });
                return;
            }
            res.json({
                ok: true,
                user: sanitizeUser(regenerated),
                apiKey: regenerated.apiKey,
                apiKeySource: 'relay_users_legacy',
                primaryApiKey: null,
                revokedApiKey: null,
                rotationMode: 'legacy_fallback',
            });
            return;
        }
        try {
            const rotated = typeof services.apiKeyStore.rotateLatestForUser === 'function'
                ? await services.apiKeyStore.rotateLatestForUser(userId, { name: 'Rotated Key' })
                : null;
            const primaryApiKey = rotated
                ? rotated.created
                : await services.apiKeyStore.create(userId, { name: 'Rotated Key' });
            const revokedApiKey = rotated?.revoked ?? null;
            res.json({
                ok: true,
                user: sanitizeUser(user),
                apiKey: primaryApiKey.apiKey,
                apiKeySource: 'relay_api_keys',
                primaryApiKey,
                revokedApiKey,
                legacyApiKeyRetained: Boolean(user.apiKey),
                rotationMode: revokedApiKey
                    ? 'rotated_latest_active_relay_key'
                    : 'issued_new_key_without_prior_active_key',
            });
        }
        catch (err) {
            const code = err && typeof err === 'object' && 'code' in err
                ? String((err).code)
                : null;
            const message = err instanceof Error ? err.message : 'regenerate_failed';
            if (code === 'api_key_quota_exceeded') {
                res.status(409).json({ error: code, message });
                return;
            }
            res.status(500).json({ error: 'regenerate_failed', message });
        }
    }));
    app.get('/admin/users/:userId/sessions', asyncRoute(async (req, res) => {
        if (!services.userStore) {
            res.status(404).json({ error: 'user_management_disabled' });
            return;
        }
        const userId = getRouteParam(req.params.userId);
        const sessions = await services.userStore.getUserSessions(userId);
        res.json({ sessions });
    }));
    app.get('/admin/users/:userId/sessions/:sessionKey/requests', asyncRoute(async (req, res) => {
        if (!services.userStore) {
            res.status(404).json({ error: 'user_management_disabled' });
            return;
        }
        const userId = getRouteParam(req.params.userId);
        const sessionKey = getRouteParam(req.params.sessionKey);
        const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
        const offset = typeof req.query.offset === 'string' ? Number(req.query.offset) : 0;
        let relayKeySource;
        try {
            relayKeySource = getOptionalRelayKeySource(req.query.relayKeySource) ?? null;
        }
        catch (error) {
            if (error instanceof InputValidationError) {
                res.status(400).json({ error: 'invalid_relay_key_source', message: error.message });
                return;
            }
            throw error;
        }
        const result = await services.userStore.getSessionRequests(userId, sessionKey, limit, offset, relayKeySource);
        res.json(result);
    }));
    app.get('/admin/users/:userId/requests', asyncRoute(async (req, res) => {
        if (!services.userStore) {
            res.status(404).json({ error: 'user_management_disabled' });
            return;
        }
        const userId = getRouteParam(req.params.userId);
        const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
        const offset = typeof req.query.offset === 'string' ? Number(req.query.offset) : 0;
        let relayKeySource;
        try {
            relayKeySource = getOptionalRelayKeySource(req.query.relayKeySource) ?? null;
        }
        catch (error) {
            if (error instanceof InputValidationError) {
                res.status(400).json({ error: 'invalid_relay_key_source', message: error.message });
                return;
            }
            throw error;
        }
        const result = await services.userStore.getUserRequests(userId, limit, offset, relayKeySource);
        res.json(result);
    }));
    app.get('/admin/users/:userId/requests/:requestId', asyncRoute(async (req, res) => {
        if (!services.userStore) {
            res.status(404).json({ error: 'user_management_disabled' });
            return;
        }
        const userId = getRouteParam(req.params.userId);
        const requestId = getRouteParam(req.params.requestId);
        const usageRecordId = typeof req.query.usageRecordId === 'string' ? Number(req.query.usageRecordId) : undefined;
        const detail = await services.userStore.getRequestDetail(userId, requestId, usageRecordId);
        if (!detail) {
            res.status(404).json({ error: 'request_not_found' });
            return;
        }
        res.json({ request: detail });
    }));
    // ── Proxy / VPN management ──
    app.get('/admin/proxies', asyncRoute(async (_req, res) => {
        const proxies = await services.oauthService.listProxies();
        const accounts = await services.oauthService.listAccounts();
        // Attach linked account summaries to each proxy
        const result = proxies.map((proxy) => ({
            ...proxy,
            accounts: accounts
                .filter((a) => a.proxyUrl === proxy.url || (proxy.localUrl && a.proxyUrl === proxy.localUrl))
                .map((a) => ({ id: a.id, label: a.label, emailAddress: a.emailAddress, status: a.status })),
        }));
        res.json({ proxies: result });
    }));
    app.post('/admin/proxies', asyncRoute(async (req, res) => {
        const label = String(req.body?.label ?? '').trim();
        const url = String(req.body?.url ?? '').trim();
        if (!url) {
            res.status(400).json({ error: 'missing_url', message: 'Proxy URL is required' });
            return;
        }
        const proxy = await services.oauthService.addProxy(label, url);
        res.json({ ok: true, proxy });
    }));
    app.post('/admin/proxies/:proxyId/update', asyncRoute(async (req, res) => {
        const proxyId = getRouteParam(req.params.proxyId);
        const updates = {};
        if (req.body?.label !== undefined)
            updates.label = String(req.body.label);
        if (req.body?.url !== undefined)
            updates.url = String(req.body.url);
        if (req.body?.localUrl !== undefined)
            updates.localUrl = req.body.localUrl ? String(req.body.localUrl) : null;
        const proxy = await services.oauthService.updateProxy(proxyId, updates);
        res.json({ ok: true, proxy });
    }));
    app.post('/admin/proxies/:proxyId/delete', asyncRoute(async (req, res) => {
        const proxyId = getRouteParam(req.params.proxyId);
        const proxy = await services.oauthService.deleteProxy(proxyId);
        res.json({ ok: true, proxy });
    }));
    app.post('/admin/proxies/:proxyId/link', asyncRoute(async (req, res) => {
        const proxyId = getRouteParam(req.params.proxyId);
        const accountIds = req.body?.accountIds;
        if (!Array.isArray(accountIds)) {
            res.status(400).json({ error: 'invalid_body', message: 'accountIds must be an array' });
            return;
        }
        await services.oauthService.linkAccountsToProxy(proxyId, accountIds);
        res.json({ ok: true });
    }));
    app.post('/admin/proxies/:proxyId/unlink', asyncRoute(async (req, res) => {
        const accountId = String(req.body?.accountId ?? '');
        if (!accountId) {
            res.status(400).json({ error: 'missing_account_id', message: 'accountId is required' });
            return;
        }
        await services.oauthService.unlinkAccountFromProxy(accountId);
        res.json({ ok: true });
    }));
    app.post('/admin/proxies/:proxyId/probe', asyncRoute(async (req, res) => {
        const proxyId = getRouteParam(req.params.proxyId);
        const proxies = await services.oauthService.listProxies();
        const proxy = proxies.find((item) => item.id === proxyId);
        if (!proxy) {
            res.status(404).json({ error: 'proxy_not_found', message: `Proxy not found: ${proxyId}` });
            return;
        }
        const diagnostics = await probeProxyExit(proxy);
        res.json({
            ok: diagnostics.status === 'healthy',
            diagnostics,
        });
    }));
    // ── Usage tracking endpoints ──
    app.get('/admin/usage/summary', asyncRoute(async (req, res) => {
        if (!services.usageStore) {
            res.status(404).json({ error: 'usage_tracking_disabled' });
            return;
        }
        const since = typeof req.query.since === 'string' ? new Date(req.query.since) : null;
        const summary = await services.usageStore.getSummary(since);
        res.json(summary);
    }));
    app.get('/admin/usage/accounts', asyncRoute(async (req, res) => {
        if (!services.usageStore) {
            res.status(404).json({ error: 'usage_tracking_disabled' });
            return;
        }
        const since = typeof req.query.since === 'string' ? new Date(req.query.since) : null;
        const accounts = await services.usageStore.getAccountUsage(since);
        res.json({ accounts });
    }));
    app.get('/admin/usage/accounts/:accountId', asyncRoute(async (req, res) => {
        if (!services.usageStore) {
            res.status(404).json({ error: 'usage_tracking_disabled' });
            return;
        }
        const accountId = getRouteParam(req.params.accountId);
        const since = typeof req.query.since === 'string' ? new Date(req.query.since) : null;
        const detail = await services.usageStore.getAccountDetail(accountId, since);
        res.json(detail);
    }));
    app.get('/admin/usage/trend', asyncRoute(async (req, res) => {
        if (!services.usageStore) {
            res.status(404).json({ error: 'usage_tracking_disabled' });
            return;
        }
        const days = typeof req.query.days === 'string' ? Number(req.query.days) : 30;
        const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : null;
        const trend = await services.usageStore.getTrend(days, accountId);
        res.json({ trend });
    }));
    // ── Billing endpoints ──
    app.get('/admin/billing/summary', asyncRoute(async (req, res) => {
        if (!services.billingStore) {
            res.status(404).json({ error: 'billing_disabled' });
            return;
        }
        const since = typeof req.query.since === 'string' ? new Date(req.query.since) : null;
        const currency = getOptionalBillingCurrency(req.query.currency, 'currency');
        const summary = await services.billingStore.getSummary(since, currency);
        res.json(summary);
    }));
    app.get('/admin/billing/users', asyncRoute(async (req, res) => {
        if (!services.billingStore) {
            res.status(404).json({ error: 'billing_disabled' });
            return;
        }
        const since = typeof req.query.since === 'string' ? new Date(req.query.since) : null;
        const currency = getOptionalBillingCurrency(req.query.currency, 'currency');
        const users = await services.billingStore.getUserBilling(since, currency);
        res.json({ users, currency: currency ?? normalizeBillingCurrency(appConfig.billingCurrency, { field: 'BILLING_CURRENCY' }) });
    }));
    app.get('/admin/billing/users/:userId', asyncRoute(async (req, res) => {
        if (!services.billingStore) {
            res.status(404).json({ error: 'billing_disabled' });
            return;
        }
        const userId = getRouteParam(req.params.userId);
        const since = typeof req.query.since === 'string' ? new Date(req.query.since) : null;
        const detail = await services.billingStore.getUserDetail(userId, since);
        if (!detail) {
            res.status(404).json({ error: 'billing_user_not_found' });
            return;
        }
        res.json(detail);
    }));
    app.get('/admin/billing/users/:userId/items', asyncRoute(async (req, res) => {
        if (!services.billingStore) {
            res.status(404).json({ error: 'billing_disabled' });
            return;
        }
        const userId = getRouteParam(req.params.userId);
        const since = typeof req.query.since === 'string' ? new Date(req.query.since) : null;
        const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
        const offset = typeof req.query.offset === 'string' ? Number(req.query.offset) : 0;
        const result = await services.billingStore.getUserLineItems(userId, since, limit, offset);
        res.json(result);
    }));
    app.get('/admin/billing/users/:userId/balance', asyncRoute(async (req, res) => {
        if (!services.billingStore) {
            res.status(404).json({ error: 'billing_disabled' });
            return;
        }
        const userId = getRouteParam(req.params.userId);
        const balance = await services.billingStore.getUserBalanceSummary(userId);
        if (!balance) {
            res.status(404).json({ error: 'billing_user_not_found' });
            return;
        }
        res.json(balance);
    }));
    app.get('/admin/billing/users/:userId/ledger', asyncRoute(async (req, res) => {
        if (!services.billingStore) {
            res.status(404).json({ error: 'billing_disabled' });
            return;
        }
        const userId = getRouteParam(req.params.userId);
        const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
        const offset = typeof req.query.offset === 'string' ? Number(req.query.offset) : 0;
        const balance = await services.billingStore.getUserBalanceSummary(userId);
        if (!balance) {
            res.status(404).json({ error: 'billing_user_not_found' });
            return;
        }
        const result = await services.billingStore.listUserLedger(userId, limit, offset);
        res.json(result);
    }));
    app.post('/admin/billing/users/:userId/ledger', asyncRoute(async (req, res) => {
        if (!services.billingStore) {
            res.status(404).json({ error: 'billing_disabled' });
            return;
        }
        const userId = getRouteParam(req.params.userId);
        const kind = req.body?.kind === 'topup' ? 'topup' : 'manual_adjustment';
        const amountMicros = req.body?.amountMicros;
        if (amountMicros === undefined || amountMicros === null || String(amountMicros).trim() === '') {
            res.status(400).json({ error: 'missing_amount_micros', message: 'amountMicros is required' });
            return;
        }
        const existing = await services.billingStore.getUserBalanceSummary(userId);
        if (!existing) {
            res.status(404).json({ error: 'billing_user_not_found' });
            return;
        }
        let result;
        try {
            result = await services.billingStore.createLedgerEntry({
                userId,
                kind,
                amountMicros,
                note: req.body?.note,
            });
        }
        catch (error) {
            const message = sanitizeErrorMessage(error);
            res.status(400).json({ error: 'invalid_billing_ledger_entry', message });
            return;
        }
        res.json({ ok: true, entry: result.entry, balance: result.balance });
    }));
    app.get('/admin/billing/rules', asyncRoute(async (req, res) => {
        if (!services.billingStore) {
            res.status(404).json({ error: 'billing_disabled' });
            return;
        }
        const currency = getOptionalBillingCurrency(req.query.currency, 'currency');
        const rules = await services.billingStore.listRules(currency);
        res.json({ rules, currency: currency ?? normalizeBillingCurrency(appConfig.billingCurrency, { field: 'BILLING_CURRENCY' }) });
    }));
    app.post('/admin/billing/rules', asyncRoute(async (req, res) => {
        if (!services.billingStore) {
            res.status(404).json({ error: 'billing_disabled' });
            return;
        }
        const rule = await services.billingStore.createRule({
            name: getNullableStringField(req.body, 'name'),
            currency: getOptionalBillingCurrency(req.body?.currency, 'currency'),
            isActive: req.body?.isActive,
            priority: req.body?.priority,
            provider: req.body?.provider,
            accountId: req.body?.accountId,
            userId: req.body?.userId,
            model: req.body?.model,
            effectiveFrom: req.body?.effectiveFrom,
            effectiveTo: req.body?.effectiveTo,
            inputPriceMicrosPerMillion: req.body?.inputPriceMicrosPerMillion,
            outputPriceMicrosPerMillion: req.body?.outputPriceMicrosPerMillion,
            cacheCreationPriceMicrosPerMillion: req.body?.cacheCreationPriceMicrosPerMillion,
            cacheReadPriceMicrosPerMillion: req.body?.cacheReadPriceMicrosPerMillion,
        });
        const result = await services.billingStore.syncLineItems({ reconcileMissing: true });
        res.json({ ok: true, rule, result, currency: rule.currency });
    }));
    app.post('/admin/billing/rules/:ruleId/update', asyncRoute(async (req, res) => {
        if (!services.billingStore) {
            res.status(404).json({ error: 'billing_disabled' });
            return;
        }
        const ruleId = getRouteParam(req.params.ruleId);
        const rule = await services.billingStore.updateRule(ruleId, {
            name: hasOwnProperty(req.body, 'name') ? getNullableStringField(req.body, 'name') : undefined,
            currency: hasOwnProperty(req.body, 'currency') ? getOptionalBillingCurrency(req.body?.currency, 'currency') : undefined,
            isActive: req.body?.isActive,
            priority: req.body?.priority,
            provider: req.body?.provider,
            accountId: req.body?.accountId,
            userId: req.body?.userId,
            model: req.body?.model,
            effectiveFrom: req.body?.effectiveFrom,
            effectiveTo: req.body?.effectiveTo,
            inputPriceMicrosPerMillion: req.body?.inputPriceMicrosPerMillion,
            outputPriceMicrosPerMillion: req.body?.outputPriceMicrosPerMillion,
            cacheCreationPriceMicrosPerMillion: req.body?.cacheCreationPriceMicrosPerMillion,
            cacheReadPriceMicrosPerMillion: req.body?.cacheReadPriceMicrosPerMillion,
        });
        if (!rule) {
            res.status(404).json({ error: 'billing_rule_not_found' });
            return;
        }
        res.json({ ok: true, rule, currency: rule.currency });
    }));
    app.post('/admin/billing/rules/:ruleId/delete', asyncRoute(async (req, res) => {
        if (!services.billingStore) {
            res.status(404).json({ error: 'billing_disabled' });
            return;
        }
        const ruleId = getRouteParam(req.params.ruleId);
        const deleted = await services.billingStore.deleteRule(ruleId);
        if (!deleted) {
            res.status(404).json({ error: 'billing_rule_not_found' });
            return;
        }
        res.json({ ok: true });
    }));
    app.post('/admin/billing/sync', asyncRoute(async (req, res) => {
        if (!services.billingStore) {
            res.status(404).json({ error: 'billing_disabled' });
            return;
        }
        const result = await services.billingStore.syncLineItems({
            reconcileMissing: Boolean(req.body?.reconcileMissing),
        });
        res.json({ ok: true, result });
    }));
    app.post('/admin/billing/rebuild', asyncRoute(async (_req, res) => {
        if (!services.billingStore) {
            res.status(404).json({ error: 'billing_disabled' });
            return;
        }
        const result = await services.billingStore.rebuildLineItems();
        res.json({ ok: true, result });
    }));
    if (fs.existsSync(ADMIN_UI_DIST_DIR)) {
        app.use(express.static(ADMIN_UI_DIST_DIR, {
            index: false,
        }));
        app.get('*', (req, res, next) => {
            if (!shouldServeAdminUi(req)) {
                next();
                return;
            }
            res.type('html').send(renderAdminUiIndex(req));
        });
    }
    // ── Relay catch-all (must be after all admin routes) ──
    app.all('*', async (req, res) => {
        try {
            await services.relayService.handle(req, res);
        }
        catch (error) {
            const clientError = classifyClientFacingRelayError(error);
            if (!res.headersSent) {
                res.status(clientError?.statusCode ?? 500).json({
                    type: 'error',
                    error: {
                        type: 'api_error',
                        message: clientError?.message ?? 'Internal server error.',
                        internal_code: clientError?.code ?? RELAY_ERROR_CODES.INTERNAL_ERROR,
                    },
                });
            }
            else {
                res.end();
            }
        }
    });
    app.use((error, _req, res, _next) => {
        if (res.headersSent) {
            res.end();
            return;
        }
        if (error instanceof AdminSessionAuthError) {
            res.status(error.statusCode).json({
                error: 'admin_session_error',
                message: error.message,
            });
            return;
        }
        const message = sanitizeErrorMessage(error);
        const statusCode = error instanceof InputValidationError ? 400 : 500;
        res.status(statusCode).json({
            type: 'error',
            error: { type: 'api_error', message },
        });
    });
    return app;
}
