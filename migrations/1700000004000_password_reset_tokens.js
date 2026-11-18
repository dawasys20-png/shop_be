exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash CHAR(64) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS password_reset_tokens_user_expires_idx
      ON password_reset_tokens(user_id, expires_at DESC);
    CREATE INDEX IF NOT EXISTS password_reset_tokens_expires_idx
      ON password_reset_tokens(expires_at);
  `);
};

exports.down = (pgm) => {
  pgm.sql("DROP TABLE IF EXISTS password_reset_tokens;");
};
