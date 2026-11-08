function createRefreshHandler({
  pool,
  readCookie,
  refreshTokenCookie,
  hashToken,
  clearAuthCookies,
  rotateRefreshToken,
  createSessionToken,
  publicUser,
  sessionCookie,
  accessTokenLifetimeSeconds,
  refreshTokenLifetimeSeconds,
  secureCookies,
}) {
  return async function refresh(req, res) {
    const refreshToken = readCookie(req, refreshTokenCookie);
    if (!refreshToken) {
      clearAuthCookies(res);
      return res.status(401).json({
        message: "Your session has expired. Please sign in again.",
      });
    }

    const tokenHash = hashToken(refreshToken);
    const result = await pool.query(
      "SELECT user_id, expires_at FROM refresh_tokens WHERE token_hash = $1",
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row || new Date(row.expires_at).getTime() <= Date.now()) {
      if (row) {
        await pool.query("DELETE FROM refresh_tokens WHERE token_hash = $1", [tokenHash]);
      }
      clearAuthCookies(res);
      return res.status(401).json({
        message: "Your session has expired. Please sign in again.",
      });
    }

    const userResult = await pool.query(
      "SELECT id, name, email, role FROM users WHERE id = $1",
      [row.user_id],
    );
    const user = userResult.rows[0];
    if (!user) {
      await pool.query("DELETE FROM refresh_tokens WHERE user_id = $1", [row.user_id]);
      clearAuthCookies(res);
      return res.status(401).json({
        message: "Your session has expired. Please sign in again.",
      });
    }

    const nextRefreshToken = await rotateRefreshToken(row.user_id, refreshToken);
    if (!nextRefreshToken) {
      clearAuthCookies(res);
      return res.status(401).json({
        message: "Your session has expired. Please sign in again.",
      });
    }

    const secure = secureCookies ? "; Secure" : "";
    res.setHeader("Set-Cookie", [
      `${sessionCookie}=${encodeURIComponent(createSessionToken(user.id))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${accessTokenLifetimeSeconds}${secure}`,
      `${refreshTokenCookie}=${encodeURIComponent(nextRefreshToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${refreshTokenLifetimeSeconds}${secure}`,
    ]);
    return res.json({ user: publicUser(user) });
  };
}

module.exports = { createRefreshHandler };
