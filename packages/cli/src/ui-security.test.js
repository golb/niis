import test from "node:test";
import assert from "node:assert/strict";

import {
  createUiRequestGuard,
  isLoopbackHost,
  normalizeUiAccessConfig,
} from "./ui-security.js";

const ORIGIN = "http://127.0.0.1:4173";
const BOOTSTRAP_SECRET = "synthetic-bootstrap-secret-with-ample-length";

function createRequest({
  cookie = null,
  headers = {},
  host = "127.0.0.1:4173",
  method = "GET",
  origin = null,
  url = "/",
} = {}) {
  return {
    headers: {
      host,
      ...(cookie ? { cookie } : {}),
      ...(origin ? { origin } : {}),
      ...headers,
    },
    method,
    url,
  };
}

function createResponse() {
  const headers = new Map();
  return {
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    snapshot() {
      return headers;
    },
  };
}

function sessionCookie(response) {
  const value = response.snapshot().get("set-cookie");
  const line = Array.isArray(value) ? value[0] : value;
  return String(line).split(";", 1)[0];
}

function authenticate(guard) {
  const url = new URL(
    `/__niis/auth/bootstrap?token=${encodeURIComponent(BOOTSTRAP_SECRET)}`,
    ORIGIN,
  );
  const authorization = guard.authorizeHttp(createRequest({ url: url.pathname + url.search }), url);
  assert.equal(authorization.ok, true);
  assert.equal(authorization.redirectTo, "/");
  const response = createResponse();
  guard.attachCookies(response, authorization);
  return sessionCookie(response);
}

test("loopback detection covers the full IPv4 loopback range and IPv6", () => {
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("127.42.1.9"), true);
  assert.equal(isLoopbackHost("[::1]"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("192.0.2.5"), false);
});

test("UI access is loopback-only and legacy remote configuration fails closed", () => {
  assert.throws(
    () => normalizeUiAccessConfig({ host: "0.0.0.0" }),
    /non-loopback/u,
  );
  assert.throws(
    () => normalizeUiAccessConfig({ host: "127.0.0.1", remoteRequested: true }),
    /not available/u,
  );
  assert.throws(
    () => normalizeUiAccessConfig({ host: "127.0.0.1", token: BOOTSTRAP_SECRET }),
    /not available/u,
  );
  assert.throws(
    () => normalizeUiAccessConfig({
      allowedOrigins: ["https://console.example.invalid"],
      host: "127.0.0.1",
    }),
    /loopback origins/u,
  );
  assert.deepEqual(
    normalizeUiAccessConfig({ host: "127.0.0.1" }),
    { allowedOrigins: [], host: "127.0.0.1", remote: false, token: null },
  );
});

test("the one-time bootstrap exchanges for a session and cannot be replayed", () => {
  const guard = createUiRequestGuard({
    bootstrapSecret: BOOTSTRAP_SECRET,
    sessionSecret: "synthetic-ui-session-secret",
  });
  assert.equal(guard.authorizeHttp(
    createRequest(),
    new URL(ORIGIN),
  ).code, "ui_auth_required");
  assert.equal(guard.authorizeHttp(
    createRequest({ url: "/__niis/auth/bootstrap?token=wrong" }),
    new URL("/__niis/auth/bootstrap?token=wrong", ORIGIN),
  ).code, "ui_auth_required");

  const cookie = authenticate(guard);
  assert.match(cookie, /^niis_ui_session=/u);
  assert.equal(guard.authorizeHttp(
    createRequest({ cookie }),
    new URL(ORIGIN),
  ).ok, true);
  assert.equal(guard.authorizeHttp(
    createRequest({ url: `/__niis/auth/bootstrap?token=${BOOTSTRAP_SECRET}` }),
    new URL(`/__niis/auth/bootstrap?token=${BOOTSTRAP_SECRET}`, ORIGIN),
  ).code, "ui_auth_required");
});

test("health is the only unauthenticated application route", () => {
  const guard = createUiRequestGuard({ bootstrapSecret: BOOTSTRAP_SECRET });
  assert.equal(guard.authorizeHttp(
    createRequest({ url: "/health" }),
    new URL("/health", ORIGIN),
  ).ok, true);
  assert.equal(guard.authorizeHttp(
    createRequest({ url: "/api/tasks" }),
    new URL("/api/tasks", ORIGIN),
  ).code, "ui_auth_required");
});

test("authenticated mutations still require exact same-origin evidence", () => {
  const guard = createUiRequestGuard({ bootstrapSecret: BOOTSTRAP_SECRET });
  const cookie = authenticate(guard);
  assert.equal(guard.authorizeHttp(
    createRequest({ cookie, method: "POST" }),
    new URL("/tasks/t-1/actions/start", ORIGIN),
  ).code, "cross_origin_request");
  assert.equal(guard.authorizeHttp(
    createRequest({ cookie, method: "POST", origin: "http://localhost:4173" }),
    new URL("/tasks/t-1/actions/start", ORIGIN),
  ).code, "cross_origin_request");
  assert.equal(guard.authorizeHttp(
    createRequest({ cookie, method: "POST", origin: ORIGIN }),
    new URL("/tasks/t-1/actions/start", ORIGIN),
  ).ok, true);
});

test("DNS rebinding and conflicting forwarded authority are rejected", () => {
  const guard = createUiRequestGuard({ bootstrapSecret: BOOTSTRAP_SECRET });
  assert.equal(guard.authorizeHttp(
    createRequest({ host: "attacker.invalid:4173" }),
    new URL("http://attacker.invalid:4173/"),
  ).code, "untrusted_host");
  assert.equal(guard.authorizeHttp(
    createRequest({ headers: { "x-forwarded-host": "attacker.invalid:4173" } }),
    new URL(ORIGIN),
  ).code, "untrusted_host");
});

test("WebSockets require the authenticated session and exact origin", () => {
  const guard = createUiRequestGuard({ bootstrapSecret: BOOTSTRAP_SECRET });
  assert.equal(guard.authorizeWebSocket(createRequest({
    origin: ORIGIN,
    url: "/__niis/live/ws",
  })), false);
  const cookie = authenticate(guard);
  assert.equal(guard.authorizeWebSocket(createRequest({
    cookie,
    origin: ORIGIN,
    url: "/__niis/live/ws",
  })), true);
  assert.equal(guard.authorizeWebSocket(createRequest({
    cookie,
    origin: "http://localhost:4173",
    url: "/__niis/live/ws",
  })), false);
});

test("security headers deny framing, referrers, and MIME sniffing", () => {
  const guard = createUiRequestGuard({ bootstrapSecret: BOOTSTRAP_SECRET });
  const response = createResponse();
  const nonce = guard.applyResponseHeaders(response);
  const headers = response.snapshot();
  const contentSecurityPolicy = headers.get("content-security-policy");
  assert.match(contentSecurityPolicy, /frame-ancestors 'none'/u);
  assert.match(contentSecurityPolicy, /connect-src 'self' ws:\/\/127\.0\.0\.1:4173/u);
  assert.match(contentSecurityPolicy, new RegExp(`script-src 'self' 'nonce-${nonce}'`, "u"));
  assert.doesNotMatch(contentSecurityPolicy, /script-src[^;]*'unsafe-inline'/u);
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("referrer-policy"), "no-referrer");
});
