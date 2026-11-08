const assert = require("node:assert/strict");
const test = require("node:test");
const { createRefreshHandler } = require("../auth-refresh");

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function createDependencies({
  refreshToken = "valid-refresh-token",
  expiresAt = new Date(Date.now() + 60_000),
  user = { id: "user-1", name: "Test User", email: "test@example.com", role: "customer" },
  nextRefreshToken = "rotated-refresh-token",
} = {}) {
  const queries = [];
  const rotated = [];
  const cleared = [];
  const pool = {
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.startsWith("SELECT user_id, expires_at")) {
        return {
          rows: expiresAt
            ? [{ user_id: "user-1", expires_at: expiresAt }]
            : [],
        };
      }
      if (sql.startsWith("SELECT id, name, email, role")) {
        return { rows: user ? [user] : [] };
      }
      return { rows: [], rowCount: 1 };
    },
  };

  const handler = createRefreshHandler({
    pool,
    readCookie: (req, name) => {
      assert.equal(name, "form_function_refresh");
      return req.refreshToken ?? refreshToken;
    },
    refreshTokenCookie: "form_function_refresh",
    hashToken: (token) => `hash:${token}`,
    clearAuthCookies: (res) => cleared.push(res),
    rotateRefreshToken: async (userId, token) => {
      rotated.push({ userId, token });
      return nextRefreshToken;
    },
    createSessionToken: (userId) => `access:${userId}`,
    publicUser: (value) => ({ id: value.id, name: value.name, role: value.role }),
    sessionCookie: "form_function_session",
    accessTokenLifetimeSeconds: 900,
    refreshTokenLifetimeSeconds: 604800,
    secureCookies: false,
  });

  return { handler, pool, queries, rotated, cleared };
}

test("refresh endpoint rotates a valid refresh token and sets both cookies", async () => {
  const { handler, queries, rotated } = createDependencies();
  const response = createResponse();

  await handler({ headers: {} }, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    user: { id: "user-1", name: "Test User", role: "customer" },
  });
  assert.deepEqual(rotated, [{ userId: "user-1", token: "valid-refresh-token" }]);
  assert.equal(queries.length, 2);
  assert.deepEqual(response.headers["Set-Cookie"], [
    "form_function_session=access%3Auser-1; Path=/; HttpOnly; SameSite=Lax; Max-Age=900",
    "form_function_refresh=rotated-refresh-token; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800",
  ]);
});

test("refresh endpoint rejects a missing refresh token and clears auth cookies", async () => {
  const { handler, queries, cleared } = createDependencies();
  const response = createResponse();

  await handler({ refreshToken: "" }, response);

  assert.equal(response.statusCode, 401);
  assert.match(response.body.message, /session has expired/i);
  assert.equal(queries.length, 0);
  assert.deepEqual(cleared, [response]);
});

test("refresh endpoint rejects an expired refresh token and removes it", async () => {
  const expiredAt = new Date(Date.now() - 1_000);
  const { handler, queries, cleared } = createDependencies({ expiresAt: expiredAt });
  const response = createResponse();

  await handler({ headers: {} }, response);

  assert.equal(response.statusCode, 401);
  assert.equal(queries.length, 2);
  assert.match(queries[1].sql, /^DELETE FROM refresh_tokens/);
  assert.deepEqual(cleared, [response]);
});

test("refresh endpoint rejects a token that lost a concurrent rotation", async () => {
  const { handler, rotated, cleared } = createDependencies({ nextRefreshToken: null });
  const response = createResponse();

  await handler({ headers: {} }, response);

  assert.equal(response.statusCode, 401);
  assert.equal(rotated.length, 1);
  assert.deepEqual(cleared, [response]);
});
