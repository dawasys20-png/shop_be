require("dotenv").config();

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcrypt");
const express = require("express");
const morgan = require("morgan");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const { Pool } = require("pg");
const { runMigrations } = require("./scripts/migrate");
const { createRefreshHandler } = require("./auth-refresh");

const app = express();
const port = Number(process.env.PORT || 4000);
const sessionSecret = process.env.SESSION_SECRET;
const sessionCookie = "form_function_session";
const sessionLifetimeSeconds = 60 * 15;
const validOrderStatuses = new Set([
  "received",
  "processing",
  "shipped",
  "complete",
  "cancelled",
]);
const accessTokenLifetimeSeconds = 60 * 15;
const refreshTokenLifetimeSeconds = 60 * 60 * 24 * 7;
const refreshTokenCookie = "form_function_refresh";
const allowedOrigins = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  ...(process.env.WEB_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
]);

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Add it to backend/.env before starting the API.");
}
if (
  !sessionSecret ||
  sessionSecret.length < 32 ||
  sessionSecret === "replace-this-with-a-random-secret-at-least-32-characters"
) {
  throw new Error("SESSION_SECRET must contain at least 32 characters.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  // Render external PostgreSQL requires TLS.
  ssl: {
    rejectUnauthorized: true,
  },

  max: Number(process.env.PG_POOL_SIZE || 5),
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  keepAlive: true,
});

pool.on("error", (err) => {
  console.error("PostgreSQL pool error:", err);
});

app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "true");
app.use(morgan("dev"));
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && !allowedOrigins.has(origin)) {
    return res.status(403).json({ message: "This website origin is not allowed." });
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, X-Order-Access-Token",
    );
    return res.status(204).end();
  }
  next();
});
app.use(express.json({ limit: "1mb" }));

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value, label, maxLength = 500) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    fail(400, `${label} is required and must be at most ${maxLength} characters.`);
  }
  return value.trim();
}

function optionalText(value, label, maxLength) {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredText(value, label, maxLength);
}

function parseContact(value) {
  if (!isRecord(value)) fail(400, "Contact details are required.");
  const contact = {
    name: requiredText(value.name, "Name", 120),
    email: requiredText(value.email, "Email", 254).toLowerCase(),
    phone: requiredText(value.phone, "Phone", 40),
    address: requiredText(value.address, "Address", 300),
    city: requiredText(value.city, "City", 120),
  };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) {
    fail(400, "Enter a valid email address.");
  }
  return contact;
}

function parseProduct(value, expectedId) {
  if (!isRecord(value)) fail(400, "A product object is required.");
  const id = requiredText(value.id, "Product ID", 100);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || (expectedId && id !== expectedId)) {
    fail(400, "Product ID must be a lowercase URL-safe slug and cannot be changed.");
  }
  function parseImages(imageValues, label) {
    if (!Array.isArray(imageValues) || imageValues.length < 1 || imageValues.length > 12) {
      fail(400, `${label} must contain between 1 and 12 images.`);
    }
    return imageValues.map((image) => {
      if (!isRecord(image)) fail(400, "A product image is invalid.");
      const url = requiredText(image.url, "Image URL", 2000);
      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch {
        if (!url.startsWith("/") || url.startsWith("//")) {
          fail(400, "Product images must use HTTP(S) or a local path.");
        }
      }
      if (
        parsedUrl &&
        parsedUrl.protocol !== "https:" &&
        parsedUrl.protocol !== "http:"
      ) {
        fail(400, "Product images must use HTTP(S) or a local path.");
      }
      const parsedImage = { url };
      if (image.publicId !== undefined) {
        parsedImage.publicId = requiredText(image.publicId, "Image public ID", 255);
      }
      return parsedImage;
    });
  }
  const product = {
    id,
    name: requiredText(value.name, "Product name", 160),
    category: requiredText(value.category, "Category", 80),
    brand: requiredText(value.brand, "Brand", 100),
  };
  const legacyImages = value.images !== undefined
    ? parseImages(value.images, "Product images")
    : typeof value.image === "string" && value.image
      ? parseImages([{ url: value.image }], "Product images")
      : undefined;
  if (!Array.isArray(value.variants) || value.variants.length < 1 ||
      value.variants.length > 50) {
    fail(400, "Add at least one purchase option.");
  }
  const variantIds = new Set();
  product.variants = value.variants.map((variant) => {
    if (!isRecord(variant)) fail(400, "A purchase option is invalid.");
    const parsed = {
      id: requiredText(variant.id, "Purchase option ID", 100),
      form: requiredText(variant.form, "Purchase option form", 100),
      potency: requiredText(variant.potency, "Purchase option potency", 100),
      packageQuantity: requiredText(variant.packageQuantity, "Package quantity", 100),
      detail: optionalText(variant.detail ?? value.detail, "Purchase option details", 250),
      tag: optionalText(variant.tag ?? value.tag, "Product badge", 80),
      type: optionalText(variant.type ?? value.type, "Product type", 100),
      rating: variant.rating ?? value.rating ?? null,
      alt: optionalText(variant.alt ?? value.alt, "Image description", 300),
      description: optionalText(variant.description ?? value.description, "Description", 5000),
      ingredients: optionalText(variant.ingredients ?? value.ingredients, "Ingredients", 3000),
      howToUse: optionalText(variant.howToUse ?? value.howToUse, "How to use", 3000),
      warnings: optionalText(variant.warnings ?? value.warnings, "Warnings", 3000),
      supplementInformation: optionalText(
        variant.supplementInformation ?? value.supplementInformation,
        "Supplement information",
        5000,
      ),
      tone: optionalText(variant.tone ?? value.tone, "Product tone", 100),
      benefits: variant.benefits ?? value.benefits ?? [],
      bestBefore:
        variant.bestBefore === undefined || variant.bestBefore === ""
          ? undefined
          : requiredText(variant.bestBefore, "Best-before date", 10),
      price: Number(variant.price),
      images:
        variant.images === undefined
          ? legacyImages
          : parseImages(variant.images, "Purchase option images"),
    };
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(parsed.id) ||
      variantIds.has(parsed.id) ||
      !parsed.images?.length ||
      (parsed.rating !== null &&
        (typeof parsed.rating !== "number" ||
          !Number.isFinite(parsed.rating) ||
          parsed.rating < 0 ||
          parsed.rating > 5)) ||
      !Array.isArray(parsed.benefits) ||
      parsed.benefits.length > 30 ||
      !parsed.benefits.every((benefit) => typeof benefit === "string" && benefit.length <= 300) ||
      (parsed.bestBefore !== undefined &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.bestBefore) ||
          Number.isNaN(Date.parse(`${parsed.bestBefore}T00:00:00Z`)) ||
          new Date(`${parsed.bestBefore}T00:00:00Z`).toISOString().slice(0, 10) !== parsed.bestBefore)) ||
      !Number.isFinite(parsed.price) ||
      parsed.price < 0
    ) {
      fail(400, "Purchase option IDs must be unique and prices must be valid.");
    }
    variantIds.add(parsed.id);
    return parsed;
  });
  if (product.variants.some(({ price }) => !Number.isFinite(price) || price < 0)) {
    fail(400, "Purchase option prices must be valid.");
  }
  return product;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createSignedToken(userId, lifetimeSeconds) {
  const payload = Buffer.from(
    JSON.stringify({
      sub: userId,
      exp: Math.floor(Date.now() / 1000) + lifetimeSeconds,
    }),
  ).toString("base64url");
  const signature = crypto
    .createHmac("sha256", sessionSecret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function createSessionToken(userId) {
  return createSignedToken(userId, sessionLifetimeSeconds);
}

function createRefreshToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function verifySessionToken(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const expected = crypto
    .createHmac("sha256", sessionSecret)
    .update(parts[0])
    .digest();
  let actual;
  try {
    actual = Buffer.from(parts[1], "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    return typeof payload.sub === "string" &&
      Number.isInteger(payload.exp) &&
      payload.exp > Date.now() / 1000
      ? payload
      : null;
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  const prefix = `${name}=`;
  for (const pair of (req.headers.cookie || "").split(";")) {
    const value = pair.trim();
    if (value.startsWith(prefix)) {
      try {
        return decodeURIComponent(value.slice(prefix.length));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function setSessionCookie(res, userId) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${sessionCookie}=${encodeURIComponent(createSessionToken(userId))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${accessTokenLifetimeSeconds}${secure}`;
}

function setRefreshCookie(res, userId) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${refreshTokenCookie}=${encodeURIComponent(createRefreshToken(userId))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${refreshTokenLifetimeSeconds}${secure}`;
}

function setAuthCookies(res, userId) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const accessToken = createSessionToken(userId);
  const refreshToken = createRefreshToken();
  res.setHeader("Set-Cookie", [
    `${sessionCookie}=${encodeURIComponent(accessToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${accessTokenLifetimeSeconds}${secure}`,
    `${refreshTokenCookie}=${encodeURIComponent(refreshToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${refreshTokenLifetimeSeconds}${secure}`,
  ]);
  return { accessToken, refreshToken };
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function clearRefreshCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${refreshTokenCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function clearAuthCookies(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", [
    `${sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
    `${refreshTokenCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  ]);
}

async function storeRefreshToken(userId, refreshToken) {
  const expiresAt = new Date(Date.now() + refreshTokenLifetimeSeconds * 1000);
  await pool.query(
    "INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)",
    [crypto.randomUUID(), userId, hashToken(refreshToken), expiresAt],
  );
}

async function rotateRefreshToken(userId, currentRefreshToken) {
  const nextRefreshToken = createRefreshToken();
  const currentTokenHash = hashToken(currentRefreshToken);
  const expiresAt = new Date(Date.now() + refreshTokenLifetimeSeconds * 1000);
  const result = await pool.query(
    "UPDATE refresh_tokens SET token_hash = $1, expires_at = $2 WHERE user_id = $3 AND token_hash = $4",
    [hashToken(nextRefreshToken), expiresAt, userId, currentTokenHash],
  );
  return result.rowCount === 1 ? nextRefreshToken : null;
}

async function optionalUser(req) {
  const payload = verifySessionToken(readCookie(req, sessionCookie));
  if (!payload) return null;
  const result = await pool.query(
    "SELECT id, name, email, role FROM users WHERE id = $1",
    [payload.sub],
  );
  return result.rows[0] || null;
}

async function requireUser(req, res, next) {
  try {
    req.user = await optionalUser(req);
    if (!req.user) return res.status(401).json({ message: "Please sign in to continue." });
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ message: "Administrator access is required." });
  }
  return next();
}

const supportedImageTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
]);
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 12, fileSize: 8 * 1024 * 1024, fields: 0 },
  fileFilter(_req, file, callback) {
    if (!supportedImageTypes.has(file.mimetype)) {
      const error = new Error("Choose JPEG, PNG, WebP, or AVIF image files.");
      error.status = 400;
      callback(error);
      return;
    }
    callback(null, true);
  },
});

function requireCloudinary(req, res, next) {
  if (
    !process.env.CLOUDINARY_CLOUD_NAME ||
    !process.env.CLOUDINARY_API_KEY ||
    !process.env.CLOUDINARY_API_SECRET
  ) {
    return res.status(503).json({
      message: "Image uploads are unavailable until Cloudinary is configured.",
    });
  }
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  return next();
}

function hasValidImageSignature(file) {
  const buffer = file.buffer;
  if (file.mimetype === "image/jpeg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (file.mimetype === "image/png") {
    return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (file.mimetype === "image/webp") {
    return buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP";
  }
  if (file.mimetype === "image/avif") {
    return buffer.toString("ascii", 4, 8) === "ftyp" &&
      /avif|avis/.test(buffer.toString("ascii", 8, Math.min(buffer.length, 40)));
  }
  return false;
}

function uploadImageToCloudinary(file) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(
        { folder: "form-function/products", resource_type: "image" },
        (error, result) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(result);
        },
      )
      .end(file.buffer);
  });
}

function rateLimitAuth(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const current = authAttempts.get(key);
  if (!current || now - current.startedAt >= 60_000) {
    authAttempts.set(key, { startedAt: now, count: 1 });
    return next();
  }
  current.count += 1;
  if (current.count > 30) {
    return res.status(429).json({ message: "Too many sign-in attempts. Try again shortly." });
  }
  return next();
}

const authAttempts = new Map();
const authLimiterCleanup = setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [key, value] of authAttempts) {
    if (value.startedAt < cutoff) authAttempts.delete(key);
  }
}, 60_000);
authLimiterCleanup.unref();

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

function mapOrder(row) {
  return {
    id: row.id,
    createdAt: new Date(row.created_at).toISOString(),
    status: row.status,
    contact: row.contact,
    items: row.items,
    subtotal: Number(row.subtotal),
    shipping: Number(row.shipping),
    total: Number(row.total),
  };
}

function hashAccessToken(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function constantTimeHexEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" ||
      !/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function orderId() {
  return `FF-${Date.now().toString(36).toUpperCase()}-${crypto
    .randomBytes(4)
    .toString("hex")
    .toUpperCase()}`;
}

async function buildOrderItems(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    fail(400, "An order must contain between 1 and 100 items.");
  }
  const productIds = [...new Set(value.map((item) =>
    isRecord(item) ? String(item.productId || item.id || "") : "",
  ))];
  if (productIds.some((id) => !id)) fail(400, "Every order item must include a product.");
  const result = await pool.query(
    "SELECT id, data FROM products WHERE id = ANY($1::text[])",
    [productIds],
  );
  const products = new Map(result.rows.map((row) => [row.id, row.data]));
  const items = value.map((line) => {
    if (!isRecord(line)) fail(400, "An order item is invalid.");
    const id = String(line.productId || line.id || "");
    const product = products.get(id);
    if (!product) fail(400, `Product "${id}" is no longer available.`);
    const variantId = String(line.variantId || product.variants[0]?.id || "");
    const variant = product.variants.find((option) => option.id === variantId);
    if (!variant) fail(400, `The selected option for "${product.name}" is unavailable.`);
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 1000) {
      fail(400, "Each item quantity must be a whole number between 1 and 1000.");
    }
    return {
      id: product.id,
      name: product.name,
      detail: variant.detail || "",
      image: variant.images?.[0]?.url || "",
      images: variant.images || [],
      alt: variant.alt || "",
      price: variant.price,
      quantity: line.quantity,
      variantId: variant.id,
      variantForm: variant.form,
      variantPotency: variant.potency,
      variantPackageQuantity: variant.packageQuantity,
    };
  });
  const subtotal = Math.round(
    items.reduce((total, item) => total + item.price * item.quantity, 0) * 100,
  ) / 100;
  const shipping = subtotal === 0 || subtotal >= 60 ? 0 : 5;
  return { items, subtotal, shipping, total: subtotal + shipping };
}

async function initializeDatabase() {
  await runMigrations();

  const productCount = await pool.query("SELECT COUNT(*)::int AS count FROM products");
  if (productCount.rows[0].count === 0) {
    const seedProducts = JSON.parse(
      fs.readFileSync(path.join(__dirname, "seed-products.json"), "utf8"),
    );
    for (const value of seedProducts) {
      const product = parseProduct(value);
      await pool.query(
        "INSERT INTO products (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING",
        [product.id, JSON.stringify(product)],
      );
    }
    console.log(`Seeded ${seedProducts.length} catalog products.`);
  }

  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword) {
    if (
      adminPassword.length < 12 ||
      Buffer.byteLength(adminPassword, "utf8") > 72 ||
      adminPassword.startsWith("replace-with-")
    ) {
      throw new Error(
        "ADMIN_PASSWORD must be a unique password between 12 and 72 UTF-8 bytes.",
      );
    }
    const existing = await pool.query("SELECT id, role FROM users WHERE email = $1", [adminEmail]);
    if (existing.rowCount === 0) {
      const id = crypto.randomUUID();
      const passwordHash = await bcrypt.hash(adminPassword, 12);
      await pool.query(
        "INSERT INTO users (id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, 'admin')",
        [id, process.env.ADMIN_NAME?.trim() || "Store administrator", adminEmail, passwordHash],
      );
      console.log(`Created initial administrator account ${adminEmail}.`);
    } else if (existing.rows[0].role !== "admin") {
      throw new Error(
        "ADMIN_EMAIL is already registered as a customer. Configure a different administrator email.",
      );
    }
  } else {
    console.warn("ADMIN_EMAIL and ADMIN_PASSWORD are unset; the admin dashboard will remain locked.");
  }
}

app.get("/health", asyncRoute(async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ status: "ok" });
}));

app.post("/api/auth/signup", rateLimitAuth, asyncRoute(async (req, res) => {
  if (!isRecord(req.body)) fail(400, "Signup details are required.");
  const name = requiredText(req.body.name, "Name", 120);
  const email = requiredText(req.body.email, "Email", 254).toLowerCase();
  const password = req.body.password;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "Enter a valid email address.");
  if (
    typeof password !== "string" ||
    password.length < 8 ||
    Buffer.byteLength(password, "utf8") > 72
  ) {
    fail(400, "Password must be between 8 and 72 characters.");
  }
  const id = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(password, 12);
  const inserted = await pool.query(
    "INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role",
    [id, name, email, passwordHash],
  );
  const { refreshToken } = setAuthCookies(res, id);
  await storeRefreshToken(id, refreshToken);
  res.status(201).json({ user: publicUser(inserted.rows[0]) });
}));

app.post("/api/auth/login", rateLimitAuth, asyncRoute(async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!email || !password) fail(400, "Email and password are required.");
  const result = await pool.query(
    "SELECT id, name, email, role, password_hash FROM users WHERE email = $1",
    [email],
  );
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    fail(401, "Email or password is incorrect.");
  }
  const { refreshToken } = setAuthCookies(res, user.id);
  await storeRefreshToken(user.id, refreshToken);
  res.json({ user: publicUser(user) });
}));

app.post("/api/auth/admin/login", rateLimitAuth, asyncRoute(async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!email || !password) fail(400, "Email and password are required.");
  const result = await pool.query(
    "SELECT id, name, email, role, password_hash FROM users WHERE email = $1",
    [email],
  );
  const user = result.rows[0];
  if (
    !user ||
    user.role !== "admin" ||
    !(await bcrypt.compare(password, user.password_hash))
  ) {
    fail(401, "Administrator email or password is incorrect.");
  }
  const { refreshToken } = setAuthCookies(res, user.id);
  await storeRefreshToken(user.id, refreshToken);
  res.json({ user: publicUser(user) });
}));

app.post(
  "/api/auth/refresh",
  asyncRoute(
    createRefreshHandler({
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
      secureCookies: process.env.NODE_ENV === "production",
    }),
  ),
);

app.post("/api/auth/logout", asyncRoute(async (req, res) => {
  const refreshToken = readCookie(req, refreshTokenCookie);
  if (refreshToken) {
    await pool.query("DELETE FROM refresh_tokens WHERE token_hash = $1", [hashToken(refreshToken)]);
  }

  const accessToken = readCookie(req, sessionCookie);
  if (accessToken) {
    const payload = verifySessionToken(accessToken);
    if (payload) {
      await pool.query("DELETE FROM refresh_tokens WHERE user_id = $1", [payload.sub]);
    }
  }

  clearAuthCookies(res);
  res.status(204).end();
}));

app.get("/api/auth/me", asyncRoute(async (req, res) => {
  const user = await optionalUser(req);
  if (!user && readCookie(req, refreshTokenCookie)) {
    return res.status(401).json({ message: "Your session must be refreshed." });
  }
  res.json({ user: user ? publicUser(user) : null });
}));

app.get("/api/products", asyncRoute(async (_req, res) => {
  const result = await pool.query("SELECT data FROM products ORDER BY created_at ASC");
  res.json({ products: result.rows.map((row) => row.data) });
}));

const reviewAttempts = new Map();
const reviewLimiterCleanup = setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [ip, timestamps] of reviewAttempts) {
    const recent = timestamps.filter((timestamp) => timestamp > cutoff);
    if (recent.length) reviewAttempts.set(ip, recent);
    else reviewAttempts.delete(ip);
  }
}, 60 * 60 * 1000);
reviewLimiterCleanup.unref();

function rateLimitReviews(req, res, next) {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const recent = (reviewAttempts.get(ip) || []).filter(
    (timestamp) => timestamp > now - 60 * 60 * 1000,
  );
  if (recent.length >= 8) {
    return res.status(429).json({
      message: "Too many reviews submitted. Please try again later.",
    });
  }
  recent.push(now);
  reviewAttempts.set(ip, recent);
  return next();
}

async function findProductVariant(productId, variantId) {
  const result = await pool.query("SELECT data FROM products WHERE id = $1", [productId]);
  const product = result.rows[0]?.data;
  if (!product) fail(404, "Product not found.");
  if (!product.variants?.some((variant) => variant.id === variantId)) {
    fail(404, "Product option not found.");
  }
}

app.get(
  "/api/products/:productId/variants/:variantId/reviews",
  asyncRoute(async (req, res) => {
    await findProductVariant(req.params.productId, req.params.variantId);
    const result = await pool.query(
      `SELECT id, rating, name, review AS text, created_at
       FROM product_reviews
       WHERE product_id = $1 AND variant_id = $2
       ORDER BY created_at DESC`,
      [req.params.productId, req.params.variantId],
    );
    res.json({
      reviews: result.rows.map((row) => ({
        id: row.id,
        rating: row.rating,
        name: row.name,
        text: row.text,
        createdAt: new Date(row.created_at).toISOString(),
      })),
    });
  }),
);

app.post(
  "/api/products/:productId/variants/:variantId/reviews",
  rateLimitReviews,
  asyncRoute(async (req, res) => {
    await findProductVariant(req.params.productId, req.params.variantId);
    if (!isRecord(req.body)) fail(400, "Review details are required.");
    const name = requiredText(req.body.name, "Name", 60);
    const text = requiredText(req.body.text, "Review", 1000);
    if (text.length < 10) fail(400, "Review must be at least 10 characters.");
    if (!Number.isInteger(req.body.rating) || req.body.rating < 1 || req.body.rating > 5) {
      fail(400, "Rating must be a whole number from 1 to 5.");
    }
    const result = await pool.query(
      `INSERT INTO product_reviews
        (id, product_id, variant_id, rating, name, review)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, rating, name, review AS text, created_at`,
      [
        crypto.randomUUID(),
        req.params.productId,
        req.params.variantId,
        req.body.rating,
        name,
        text,
      ],
    );
    const row = result.rows[0];
    res.status(201).json({
      review: {
        id: row.id,
        rating: row.rating,
        name: row.name,
        text: row.text,
        createdAt: new Date(row.created_at).toISOString(),
      },
    });
  }),
);

app.post(
  "/api/uploads/images",
  requireUser,
  requireAdmin,
  requireCloudinary,
  imageUpload.array("images", 12),
  asyncRoute(async (req, res) => {
    const files = req.files || [];
    if (files.length < 1 || files.length > 12) {
      fail(400, "Select between 1 and 12 images to upload.");
    }
    if (files.some((file) => !hasValidImageSignature(file))) {
      fail(400, "One or more files are not valid JPEG, PNG, WebP, or AVIF images.");
    }

    const results = await Promise.allSettled(files.map(uploadImageToCloudinary));
    const failedResult = results.find((result) => result.status === "rejected");
    if (failedResult) {
      const uploaded = results
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value.public_id);
      const cleanupResults = await Promise.allSettled(
        uploaded.map((publicId) =>
          cloudinary.uploader.destroy(publicId, { resource_type: "image" }),
        ),
      );
      cleanupResults.forEach((result) => {
        if (result.status === "rejected") {
          console.error("Could not clean up a partial Cloudinary upload:", result.reason);
        }
      });
      const error = new Error("Cloudinary could not upload the selected images.");
      error.status = 502;
      error.cause = failedResult.reason;
      throw error;
    }

    res.status(201).json({
      images: results.map(({ value }) => ({
        url: value.secure_url,
        publicId: value.public_id,
      })),
    });
  }),
);

app.post("/api/products", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const product = parseProduct(req.body);
  await pool.query(
    "INSERT INTO products (id, data) VALUES ($1, $2::jsonb)",
    [product.id, JSON.stringify(product)],
  );
  res.status(201).json({ product });
}));

app.put("/api/products/:id", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const product = parseProduct(req.body, req.params.id);
  const updated = await pool.query(
    "UPDATE products SET data = $2::jsonb, updated_at = NOW() WHERE id = $1",
    [product.id, JSON.stringify(product)],
  );
  if (!updated.rowCount) fail(404, "Product not found.");
  res.json({ product });
}));

app.delete("/api/products/:id", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const deleted = await pool.query("DELETE FROM products WHERE id = $1", [req.params.id]);
  if (!deleted.rowCount) fail(404, "Product not found.");
  res.status(204).end();
}));

app.get("/api/orders", asyncRoute(async (req, res) => {
  const user = await optionalUser(req);
  if (!user) return res.json({ orders: [] });
  const result = user.role === "admin"
    ? await pool.query("SELECT * FROM orders ORDER BY created_at DESC")
    : await pool.query("SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC", [user.id]);
  res.json({ orders: result.rows.map(mapOrder) });
}));

app.post("/api/orders/lookup", asyncRoute(async (req, res) => {
  const tokens = req.body?.tokens;
  if (!Array.isArray(tokens) || tokens.length > 50) fail(400, "Order lookup request is invalid.");
  const ids = tokens
    .filter((entry) => isRecord(entry) && typeof entry.id === "string" && typeof entry.token === "string")
    .map((entry) => entry.id);
  if (!ids.length) return res.json({ orders: [] });
  const result = await pool.query("SELECT * FROM orders WHERE id = ANY($1::text[])", [ids]);
  const tokenMap = new Map(
    tokens.filter((entry) =>
      isRecord(entry) &&
      typeof entry.id === "string" &&
      typeof entry.token === "string",
    )
      .map((entry) => [entry.id, entry.token]),
  );
  const orders = result.rows.filter((row) =>
    constantTimeHexEqual(row.guest_token_hash, hashAccessToken(tokenMap.get(row.id))),
  );
  res.json({ orders: orders.map(mapOrder) });
}));

app.post("/api/orders", asyncRoute(async (req, res) => {
  if (!isRecord(req.body)) fail(400, "Order details are required.");
  const contact = parseContact(req.body.contact);
  const items = await buildOrderItems(req.body.items);
  const user = await optionalUser(req);
  const id = orderId();
  const accessToken = user ? null : crypto.randomBytes(32).toString("base64url");
  const inserted = await pool.query(
    `INSERT INTO orders
      (id, user_id, guest_token_hash, contact, items, subtotal, shipping, total)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)
     RETURNING *`,
    [
      id,
      user?.id || null,
      accessToken ? hashAccessToken(accessToken) : null,
      JSON.stringify(contact),
      JSON.stringify(items.items),
      items.subtotal,
      items.shipping,
      items.total,
    ],
  );
  res.status(201).json({ order: mapOrder(inserted.rows[0]), accessToken });
}));

app.get("/api/orders/:id", asyncRoute(async (req, res) => {
  const user = await optionalUser(req);
  const result = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  const order = result.rows[0];
  if (!order) fail(404, "Order not found.");
  const token = req.get("x-order-access-token");
  const hasGuestAccess = token &&
    constantTimeHexEqual(order.guest_token_hash, hashAccessToken(token));
  const hasUserAccess = user?.role === "admin" || user?.id === order.user_id;
  if (!hasGuestAccess && !hasUserAccess) fail(404, "Order not found.");
  res.json({ order: mapOrder(order) });
}));

app.post("/api/admin/orders", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  if (!isRecord(req.body)) fail(400, "Order details are required.");
  const contact = parseContact(req.body.contact);
  const items = await buildOrderItems(req.body.items);
  const status = req.body.status || "received";
  if (!validOrderStatuses.has(status)) fail(400, "Order status is invalid.");
  const id = typeof req.body.id === "string" && /^[A-Za-z0-9-]{1,80}$/.test(req.body.id)
    ? req.body.id
    : orderId();
  const createdAt = typeof req.body.createdAt === "string" &&
    !Number.isNaN(Date.parse(req.body.createdAt))
    ? new Date(req.body.createdAt).toISOString()
    : new Date().toISOString();
  const inserted = await pool.query(
    `INSERT INTO orders
      (id, contact, items, subtotal, shipping, total, status, created_at)
     VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      id,
      JSON.stringify(contact),
      JSON.stringify(items.items),
      items.subtotal,
      items.shipping,
      items.total,
      status,
      createdAt,
    ],
  );
  res.status(201).json({ order: mapOrder(inserted.rows[0]) });
}));

app.put("/api/admin/orders/:id", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  if (!isRecord(req.body)) fail(400, "Order details are required.");
  const contact = parseContact(req.body.contact);
  const items = await buildOrderItems(req.body.items);
  const status = req.body.status;
  if (!validOrderStatuses.has(status)) fail(400, "Order status is invalid.");
  const updated = await pool.query(
    `UPDATE orders
     SET contact = $2::jsonb, items = $3::jsonb, subtotal = $4, shipping = $5,
         total = $6, status = $7
     WHERE id = $1
     RETURNING *`,
    [
      req.params.id,
      JSON.stringify(contact),
      JSON.stringify(items.items),
      items.subtotal,
      items.shipping,
      items.total,
      status,
    ],
  );
  if (!updated.rowCount) fail(404, "Order not found.");
  res.json({ order: mapOrder(updated.rows[0]) });
}));

app.delete("/api/admin/orders/:id", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const deleted = await pool.query("DELETE FROM orders WHERE id = $1", [req.params.id]);
  if (!deleted.rowCount) fail(404, "Order not found.");
  res.status(204).end();
}));

app.use((req, res) => {
  res.status(404).json({ message: `No API route for ${req.method} ${req.path}.` });
});

app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE"
      ? "Each image must be 8 MB or smaller."
      : error.code === "LIMIT_FILE_COUNT"
        ? "A product can have up to 12 images."
        : "The image upload request is invalid.";
    return res.status(400).json({ message });
  }
  if (error.code === "23505") {
    return res.status(409).json({ message: "An account or product with that ID already exists." });
  }
  if (error.status) return res.status(error.status).json({ message: error.message });
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({ message: "Request body must be valid JSON." });
  }
  console.error("API request failed:", error);
  return res.status(500).json({ message: "The server could not complete this request." });
});

initializeDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`Store API listening on http://localhost:${port}`);
    });
  })
  .catch(async (error) => {
    console.error("Could not initialize the PostgreSQL store:", error);
    await pool.end();
    process.exitCode = 1;
  });
