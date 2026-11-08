exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(254) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role VARCHAR(16) NOT NULL DEFAULT 'customer'
        CHECK (role IN ('customer', 'admin')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS product_reviews (
      id UUID PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      variant_id TEXT NOT NULL,
      rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
      name VARCHAR(60) NOT NULL,
      review TEXT NOT NULL CHECK (char_length(review) BETWEEN 10 AND 1000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS product_reviews_variant_created_idx
      ON product_reviews(product_id, variant_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS orders (
      id VARCHAR(80) PRIMARY KEY,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      guest_token_hash CHAR(64),
      contact JSONB NOT NULL,
      items JSONB NOT NULL,
      subtotal NUMERIC(12, 2) NOT NULL,
      shipping NUMERIC(12, 2) NOT NULL,
      total NUMERIC(12, 2) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'received'
        CHECK (status IN ('received', 'processing', 'shipped', 'complete', 'cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS orders_user_created_idx
      ON orders(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS orders_created_idx
      ON orders(created_at DESC);
  `);
};
