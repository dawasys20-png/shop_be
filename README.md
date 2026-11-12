# Form & Function Store API

Express 5 API for customer accounts, the product catalog, guest/customer orders, and the admin dashboard. PostgreSQL is the source of truth; versioned migrations manage the schema. Products and orders are created and managed through the API and administrator dashboard; the API does not load a built-in sample catalog.

## Setup

1. Create a PostgreSQL database named `form_function` (or choose another name).
2. Copy `.env.example` to `.env` and set `DATABASE_URL`, a random `SESSION_SECRET` of at least 32 characters, a unique administrator email/password, and the Cloudinary cloud name, API key, and API secret. Generate a session secret with `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`. The admin password must be at least 12 characters. Cloudinary credentials are server-only and must not use `NEXT_PUBLIC_` variables.
3. Install and start the API from this directory:

   ```powershell
   yarn install
   yarn dev
   ```

   `yarn start` runs without file watching.
4. Start the website from `C:\Users\2026\Documents\shop` with `yarn dev`. The client uses `http://<website-host>:4000/api` by default. Set `NEXT_PUBLIC_API_URL` if the API is hosted elsewhere.

The API listens on port `4000` by default. `GET /health` checks both the server and its PostgreSQL connection. Customer signup is public; administrator accounts are created from `ADMIN_EMAIL` and `ADMIN_PASSWORD` the first time the API starts. To provision a delivery account, set `DELIVERY_NAME`, `DELIVERY_EMAIL`, and a unique `DELIVERY_PASSWORD` of at least 12 characters in `.env`; the account is created on API startup and can sign in at `/delivery/login`. Admin and delivery permissions are never selectable during public signup. Delivery accounts can view order and delivery details and update order status, but cannot access admin tools, edit orders, place orders, or submit reviews.

## Database migrations

The API uses `node-pg-migrate` to version the PostgreSQL schema while keeping the existing `pg` queries. Migrations run automatically before administrator bootstrap when the API starts. They can also be applied manually with `yarn migrate`.

Create future migrations with `yarn migrate:create <migration-name>`. Commit the generated file so every environment applies the same schema changes. The initial migration uses `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`, so databases created by earlier API versions can adopt migration tracking without replacing existing tables or data.

## Main endpoints

| Method | Path | Access | Purpose |
|---|---|---|---|
| `POST` | `/api/auth/signup` | Public | Create a customer account |
| `POST` | `/api/auth/login` | Public | Sign in and set an HttpOnly session cookie |
| `POST` | `/api/auth/admin/login` | Public | Sign in only when the credentials belong to an administrator |
| `POST` | `/api/auth/refresh` | Public | Rotate a valid refresh token and renew the session |
| `POST` | `/api/auth/logout` | Public | Clear the session cookie |
| `GET` | `/api/auth/me` | Public | Return the current user, if signed in |
| `GET` | `/api/products` | Public | List the catalog |
| `GET` | `/api/products/:productId/variants/:variantId/reviews` | Public | List reviews and ratings for one product option |
| `POST` | `/api/products/:productId/variants/:variantId/reviews` | Public | Submit a 1–5 star rating and review for one option (maximum 8 per IP per hour) |
| `POST` | `/api/products` | Admin | Create a product |
| `PUT`, `DELETE` | `/api/products/:id` | Admin | Update or remove a product |
| `POST` | `/api/uploads/images` | Admin | Upload 1–12 JPEG, PNG, WebP, or AVIF images (max 8 MB each) to Cloudinary |
| `POST` | `/api/orders` | Signed in | Place an order owned by the current user; prices are recalculated from the catalog |
| `GET` | `/api/orders` | Signed in | List the current user's orders, or all orders for an admin or delivery account |
| `POST` | `/api/orders/lookup` | Public | Find guest orders using their private access tokens |
| `GET` | `/api/orders/:id` | Owner, token, admin, or delivery | View an order |
| `POST` | `/api/admin/orders` | Admin | Create an order |
| `PUT`, `DELETE` | `/api/admin/orders/:id` | Admin | Update or remove an order |
| `PATCH` | `/api/admin/orders/:id/status` | Admin or delivery | Update an order's fulfillment status |

Sessions use a 15-minute HttpOnly access cookie and a rotating 7-day HttpOnly refresh cookie. If a refresh fails, the frontend redirects to sign-in and preserves the requested page. Configure `WEB_ORIGIN` as a comma-separated allowlist when the frontend is not running on localhost. Put secrets only in `.env`; `.gitignore` excludes it. The checkout records orders but does not collect payment.

Products share only their `id`, `name`, `brand`, and `category`. All other content belongs to a purchase option (`variants`), including price, form, potency, package quantity, images, description, benefits, ingredients, usage instructions, warnings, supplement information, product type, badge, rating, expiry date, and an optional `specifications` array of `{ "key": "...", "value": "..." }` entries. Specification names must be unique within an option; each option supports up to 30 entries. Each option accepts an `images` array containing Cloudinary `url` and `publicId` values; the first image is its primary image, and its own gallery is shown when that option is selected.

The variant-content migration backfills existing product-level content into each existing option before removing those fields from the product record. Products without options receive a default option using their existing product details and price. Requests that include legacy product-level content alongside variants are normalized into variant-owned fields; new product requests must include at least one complete variant.

Each purchase option stores its own form, potency, package quantity, and optional portion size and total servings. Portion size and total servings can be entered directly in the admin editor; existing options without those values keep the storefront's package-based fallback. Each option can also store an optional best-before/expiry date in `YYYY-MM-DD` format.

Ratings and reviews are stored in PostgreSQL for everyone to see and are scoped by both product ID and variant ID. Reviews are submitted publicly; the API validates the selected option and limits submissions to 8 per IP per hour. The product catalog includes each option's average submitted-review rating when reviews exist, so product cards and product details show a consistent rating.
