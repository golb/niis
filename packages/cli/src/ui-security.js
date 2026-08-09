import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import net from "node:net";




const SESSION_COOKIE = "niis_ui_session";
const BOOTSTRAP_PATH = "/__niis/auth/bootstrap";

function normalizeHostname(value) {
  let hostname = String(value ?? "").trim().toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  if (hostname.endsWith(".")) {
    hostname = hostname.slice(0, -1);
  }
  return hostname;
}

function isLoopbackHost(host) {
  const hostname = normalizeHostname(host);
  if (hostname === "localhost" || hostname === "::1") {
    return true;
  }
  if (hostname.startsWith("::ffff:")) {
    return isLoopbackHost(hostname.slice("::ffff:".length));
  }
  if (net.isIP(hostname) === 4) {
    const firstOctet = Number.parseInt(hostname.split(".", 1)[0], 10);
    return firstOctet === 127;
  }
  return false;
}

function normalizeUiAccessConfig({
  allowedOrigins = [],
  host,
  remoteRequested = false,
  token = null,
} = {}) {
  const normalizedHost = String(host ?? "127.0.0.1").trim();
  if (normalizedHost === "") {
    throw new Error("UI host must not be empty");
  }

  if (!isLoopbackHost(normalizedHost)) {
    throw new Error(`Refusing to bind the UI to non-loopback host ${normalizedHost}`);
  }
  if (remoteRequested || (typeof token === "string" && token.trim() !== "")) {
    throw new Error("Remote UI is not available in this release");
  }

  const normalizedAllowedOrigins = normalizeAllowedOrigins(allowedOrigins);
  for (const origin of normalizedAllowedOrigins) {
    if (!isLoopbackHost(new URL(origin).hostname)) {
      throw new Error(
        `Local UI allowed origins must be loopback origins: ${origin}`,
      );
    }
  }

  return Object.freeze({
    allowedOrigins: Object.freeze(normalizedAllowedOrigins),
    host: normalizedHost,
    remote: false,
    token: null,
  });
}

function normalizeAllowedOrigins(values) {
  const entries = Array.isArray(values)
    ? values
    : values === null || values === undefined || values === ""
      ? []
      : [values];
  const normalized = [];

  for (const entry of entries) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error("UI allowed origins must be non-empty URL strings");
    }

    let parsed;
    try {
      parsed = new URL(entry.trim());
    } catch {
      throw new Error(`Invalid UI allowed origin: ${entry}`);
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`UI allowed origin must use http or https: ${entry}`);
    }
    if (
      parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
    ) {
      throw new Error(`UI allowed origin must contain only scheme and authority: ${entry}`);
    }

    const origin = parsed.origin.toLowerCase();
    if (!normalized.includes(origin)) {
      normalized.push(origin);
    }
  }

  return normalized;
}

function parseCookies(header) {
  const cookies = new Map();
  for (const part of String(header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key || cookies.has(key)) continue;
    try {
      cookies.set(key, decodeURIComponent(value));
    } catch {
      cookies.set(key, value);
    }
  }
  return cookies;
}

function digestSecret(value) {
  return createHash("sha256").update(String(value), "utf8").digest();
}

function secretMatches(candidate, expectedDigest) {
  if (typeof candidate !== "string" || candidate === "") return false;
  const candidateDigest = digestSecret(candidate);
  return candidateDigest.length === expectedDigest.length
    && timingSafeEqual(candidateDigest, expectedDigest);
}

function parseAuthority(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const authority = value.trim();
  if (authority.includes(",") || /[\s/@\\]/u.test(authority)) return null;
  try {
    const parsed = new URL(`http://${authority}`);
    if (
      parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
    ) {
      return null;
    }
    return Object.freeze({
      authority: parsed.host.toLowerCase(),
      hostname: normalizeHostname(parsed.hostname),
    });
  } catch {
    return null;
  }
}

function unquoteForwardedValue(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized.startsWith("\"")) return normalized;
  if (
    normalized.length < 2
    || !normalized.endsWith("\"")
    || normalized.slice(1, -1).includes("\\")
  ) {
    return null;
  }
  return normalized.slice(1, -1);
}

function normalizeRequestProtocol(value) {
  if (typeof value !== "string" || value.trim() === "" || value.includes(",")) {
    return null;
  }
  const protocol = value.trim().toLowerCase().replace(/:$/u, "");
  return ["http", "https"].includes(protocol) ? `${protocol}:` : null;
}

function parseForwardedMetadata(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "" || value.includes(",")) {
    return null;
  }
  let forwardedHost;
  let forwardedProtocol;
  for (const parameter of value.split(";")) {
    const separator = parameter.indexOf("=");
    if (separator <= 0) return null;
    const key = parameter.slice(0, separator).trim().toLowerCase();
    const parameterValue = unquoteForwardedValue(
      parameter.slice(separator + 1),
    );
    if (parameterValue === null || parameterValue === "") return null;
    if (key === "host") {
      if (forwardedHost !== undefined) return null;
      forwardedHost = parameterValue;
    }
    if (key === "proto") {
      if (forwardedProtocol !== undefined) return null;
      forwardedProtocol = normalizeRequestProtocol(parameterValue);
      if (!forwardedProtocol) return null;
    }
  }
  return Object.freeze({
    host: forwardedHost,
    protocol: forwardedProtocol,
  });
}

function parseRequestOriginContext(request) {
  const direct = parseAuthority(request.headers.host);
  if (!direct) return null;

  const authorityHeaders = [];
  const http2Authority = request.headers[":authority"];
  if (http2Authority !== undefined) {
    authorityHeaders.push(http2Authority);
  }
  const forwarded = parseForwardedMetadata(request.headers.forwarded);
  if (forwarded === null) return null;
  if (forwarded?.host !== undefined) {
    authorityHeaders.push(forwarded.host);
  }
  const xForwardedHost = request.headers["x-forwarded-host"];
  if (xForwardedHost !== undefined) {
    authorityHeaders.push(xForwardedHost);
  }

  for (const value of authorityHeaders) {
    const forwarded = parseAuthority(value);
    if (!forwarded || forwarded.authority !== direct.authority) {
      return null;
    }
  }

  const forwardedProtocols = [];
  if (forwarded?.protocol !== undefined) {
    forwardedProtocols.push(forwarded.protocol);
  }
  const xForwardedProtocol = request.headers["x-forwarded-proto"];
  if (xForwardedProtocol !== undefined) {
    const protocol = normalizeRequestProtocol(xForwardedProtocol);
    if (!protocol) return null;
    forwardedProtocols.push(protocol);
  }
  const http2Scheme = request.headers[":scheme"];
  if (http2Scheme !== undefined) {
    const protocol = normalizeRequestProtocol(http2Scheme);
    if (!protocol) return null;
    forwardedProtocols.push(protocol);
  }
  if (
    forwardedProtocols.some((protocol) =>
      protocol !== forwardedProtocols[0])
  ) {
    return null;
  }
  const directlyEncrypted =
    request.socket?.encrypted === true
    || request.connection?.encrypted === true;
  const protocol = forwardedProtocols[0]
    ?? (directlyEncrypted ? "https:" : "http:");
  if (directlyEncrypted && protocol !== "https:") return null;

  let origin;
  try {
    origin = new URL(`${protocol}//${direct.authority}`).origin.toLowerCase();
  } catch {
    return null;
  }
  return Object.freeze({
    ...direct,
    origin,
    protocol,
  });
}

function parseRequestAuthority(request) {
  const context = parseRequestOriginContext(request);
  if (!context) return null;
  return Object.freeze({
    authority: context.authority,
    hostname: context.hostname,
  });
}

function normalizeOriginHeader(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

function requestEvidenceOrigin(request, { allowReferer = true } = {}) {
  const origin = request.headers.origin;
  if (typeof origin === "string" && origin.trim() !== "") {
    return normalizeOriginHeader(origin);
  }

  if (!allowReferer) return null;
  const referer = request.headers.referer;
  if (typeof referer === "string" && referer.trim() !== "") {
    return normalizeOriginHeader(referer);
  }

  return null;
}

function formatConfiguredOrigin({ host, port }) {
  const normalizedHost = normalizeHostname(host);
  if (normalizedHost === "" || !isLoopbackHost(normalizedHost)) {
    throw new Error("Local UI guard requires a configured loopback bind host");
  }
  const normalizedPort = Number.parseInt(String(port), 10);
  if (
    !Number.isInteger(normalizedPort)
    || normalizedPort < 1
    || normalizedPort > 65535
  ) {
    throw new Error(
      "Local UI guard requires the effective configured port between 1 and 65535",
    );
  }
  const authorityHost = net.isIP(normalizedHost) === 6
    ? `[${normalizedHost}]`
    : normalizedHost;
  return new URL(`http://${authorityHost}:${normalizedPort}`).origin.toLowerCase();
}

function appendSetCookie(response, value) {
  const current = response.getHeader("set-cookie");
  if (!current) {
    response.setHeader("set-cookie", value);
    return;
  }
  response.setHeader("set-cookie", [
    ...(Array.isArray(current) ? current : [String(current)]),
    value,
  ]);
}

function cookieValue(name, value) {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/`;
}

function createUiRequestGuard({
  allowedOrigins = [],
  bindHost = "127.0.0.1",
  bindPort = 4173,
  bootstrapSecret = randomBytes(32).toString("base64url"),
  sessionSecret = randomBytes(32).toString("base64url"),
} = {}) {
  if (typeof bootstrapSecret !== "string" || bootstrapSecret.length < 32) {
    throw new Error("Local UI bootstrap secret must contain at least 32 characters");
  }

  const normalizedAllowedOrigins = normalizeAllowedOrigins(allowedOrigins);
  for (const origin of normalizedAllowedOrigins) {
    if (!isLoopbackHost(new URL(origin).hostname)) {
      throw new Error(`Local UI guard only accepts loopback allowed origins: ${origin}`);
    }
  }

  const trustedOrigins = new Set(
    normalizedAllowedOrigins.length > 0
      ? normalizedAllowedOrigins
      : [formatConfiguredOrigin({ host: bindHost, port: bindPort })],
  );
  const trustedAuthorities = new Set(
    [...trustedOrigins].map((origin) => new URL(origin).host.toLowerCase()),
  );
  const trustedWebSocketOrigins = [...trustedOrigins].map((origin) => {
    const parsed = new URL(origin);
    const protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${parsed.host}`;
  });
  const bootstrapDigest = digestSecret(bootstrapSecret);
  const sessionDigest = digestSecret(sessionSecret);
  let bootstrapConsumed = false;

  function hasTrustedAuthority(request) {
    const authority = parseRequestAuthority(request);
    if (!authority) return false;
    if (!isLoopbackHost(authority.hostname)) return false;
    return trustedAuthorities.has(authority.authority);
  }

  function isSameOriginRequest(request, options) {
    const origin = requestEvidenceOrigin(request, options);
    if (origin === null || !trustedOrigins.has(origin)) return false;
    const requestContext = parseRequestOriginContext(request);
    return requestContext !== null && origin === requestContext.origin;
  }

  function applyResponseHeaders(response) {
    const scriptNonce = randomBytes(24).toString("base64url");
    response.setHeader("content-security-policy", [
      "default-src 'self'",
      "base-uri 'none'",
      `connect-src 'self' ${trustedWebSocketOrigins.join(" ")}`,
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data:",
      "object-src 'none'",
      `script-src 'self' 'nonce-${scriptNonce}'`,
      "style-src 'self' 'unsafe-inline'",
    ].join("; "));
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "DENY");
    return scriptNonce;
  }

  function hasSessionCookie(request) {
    return secretMatches(
      parseCookies(request.headers.cookie).get(SESSION_COOKIE),
      sessionDigest,
    );
  }

  function authorizeHttp(request, requestUrl) {
    if (!hasTrustedAuthority(request)) {
      return Object.freeze({
        code: "untrusted_host",
        ok: false,
        status: 421,
      });
    }

    const method = String(request.method ?? "GET").toUpperCase();
    if (requestUrl.pathname === "/health" && ["GET", "HEAD"].includes(method)) {
      return Object.freeze({ ok: true });
    }

    if (requestUrl.pathname === BOOTSTRAP_PATH) {
      const candidate = requestUrl.searchParams.get("token");
      if (
        method !== "GET"
        || bootstrapConsumed
        || !secretMatches(candidate, bootstrapDigest)
      ) {
        return Object.freeze({
          code: "ui_auth_required",
          ok: false,
          status: 401,
        });
      }
      bootstrapConsumed = true;
      return Object.freeze({
        ok: true,
        redirectTo: "/",
        setSessionCookie: true,
      });
    }

    if (!hasSessionCookie(request)) {
      return Object.freeze({
        code: "ui_auth_required",
        ok: false,
        status: 401,
      });
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      if (!isSameOriginRequest(request)) {
        return Object.freeze({
          code: "cross_origin_request",
          ok: false,
          status: 403,
        });
      }
    }

    return Object.freeze({ ok: true });
  }

  function attachCookies(response, authorization) {
    if (authorization?.setSessionCookie) {
      appendSetCookie(response, cookieValue(SESSION_COOKIE, sessionSecret));
    }
  }

  function authorizeWebSocket(request) {
    let requestUrl;
    try {
      requestUrl = new URL(request.url ?? "/", "http://niis.invalid");
    } catch {
      return false;
    }
    return requestUrl.pathname === "/__niis/live/ws"
      && hasTrustedAuthority(request)
      && hasSessionCookie(request)
      && isSameOriginRequest(request, { allowReferer: false });
  }

  return Object.freeze({
    applyResponseHeaders,
    attachCookies,
    authorizeHttp,
    authorizeWebSocket,
  });
}

export {
  createUiRequestGuard,
  isLoopbackHost,
  normalizeUiAccessConfig,
};
