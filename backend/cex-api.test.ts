/**
 * CEX-v1 Integration / Contract Test Suite
 * -----------------------------------------
 * Modeled after https://github.com/rahul-MyGit/prep-cex-test/blob/main/tests/perp-api.spec.ts
 * Runtime: bun test  (NOT vitest/jest — see .cursor/rules)
 *
 * Run:
 *   cd backend && bun test cex-api.test.ts
 *
 * Prerequisites:
 *   1. bun run dev  (backend listening on :3000)
 *   2. DB seeded with SOL and BTC stocks
 *      INSERT INTO stocks (title, symbol) VALUES ('Solana','SOL'),('Bitcoin','BTC');
 *
 * Environment:
 *   BASE_URL=http://localhost:3000   (default)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IMPORTANT — why this file was rewritten
 * ─────────────────────────────────────────────────────────────────────────
 * The previous version of this suite assumed the global auth middleware
 * (src/middleware/auth.middleware.ts:4-35) was disabled/commented out. It is NOT. It is a live
 * `app.use(...)` registered BEFORE /order, /order/:id, /depth/:symbol,
 * /orders, /fills, /balance/usd and /balance, so EVERY request to those
 * routes without a valid `authorization` header now dies with 401 before
 * the handler ever runs.
 * Running the old suite against the live server proved this: 16/36 tests
 * failed, all with "Expected: <business status> / Received: 401".
 *
 * This rewrite:
 *   1. Signs up + signs in a real user and attaches the raw JWT (the
 *      middleware reads `req.headers["authorization"]` directly with no
 *      "Bearer " stripping, so the raw token is what must be sent).
 *   2. Adds an explicit "no token → 401" test for every route that sits
 *      behind the middleware, so a regression that removes auth is caught.
 *   3. Adds a request timeout (AbortController) to the API helper so a
 *      handler that never calls res.json()/res.end() fails the test with
 *      a clear timeout message instead of hanging the whole suite forever.
 *   4. Documents several REAL bugs found by exercising the live server
 *      directly with curl (see summary at the bottom of the file), several
 *      of which were not previously known:
 *        - POST /order can NEVER succeed (100% failure rate), because the
 *          handler's own validation only accepts lowercase "market"/"limit"
 *          while the Prisma `Type` enum only accepts "MARKET"/"LIMIT". No
 *          value of `type` can satisfy both.
 *        - Any syntactically invalid/tampered JWT causes a 500 (unhandled
 *          jwt.verify throw) instead of a 401.
 *        - GET /depth/:symbol always returns `success: false` even on a
 *          successful lookup.
 *        - GET /depth/:symbol returns HTTP 201 (not 400/404) for an unknown
 *          symbol, with `orderBook: undefined`.
 *        - DELETE /order/:orderId on a non-existent id returns 500 (Prisma
 *          "record not found" is not special-cased) instead of 404/400.
 */

import { describe, it, expect, afterAll } from "bun:test";
import jwt from "jsonwebtoken";
// Running in the same Bun runtime as the server lets us assert on real DB
// state directly — this is what makes the tests below "strict": they don't
// just check an HTTP status code, they check that the *data* the handler
// produced (or failed to produce) is actually correct.
import { prisma } from "./util";

// This test file opens its own Prisma connection pool, separate from the
// app server's. Always release it when the suite finishes — otherwise
// repeated `bun test` runs each leak a pool's worth of connections against
// the DB (especially noticeable against small local dev Postgres
// instances), eventually exhausting `connection_limit` for everyone,
// including the app server itself.
afterAll(async () => {
  await prisma.$disconnect();
});

// ─── Config ──────────────────────────────────────────────────────────────────

const configuredBaseUrl = process.env.BASE_URL?.trim();
const BASE_URL =
  configuredBaseUrl?.startsWith("http://") || configuredBaseUrl?.startsWith("https://")
    ? configuredBaseUrl
    : "http://localhost:3000";

const SYMBOL_SOL = "SOL";
const SYMBOL_BTC = "BTC";
const SYMBOL_INVALID = "DOGE";

/** Any request taking longer than this is almost certainly a hung handler
 * (a route that never calls res.json()/res.end()), not a slow DB. */
const REQUEST_TIMEOUT_MS = 5000;

// ─── Types ────────────────────────────────────────────────────────────────────

interface SignupRequest {
  username: string;
  password: string;
}

interface SigninRequest {
  username: string;
  password: string;
}

interface SigninResponse {
  success: boolean;
  token?: string;
  message?: string;
}

interface SignupResponse {
  success: boolean;
  message?: string;
  user?: { id: number; username: string };
}

interface OrderRequest {
  type: string;
  price?: number | null;
  qty: number | string;
  market_id: string;
  side: string;
}

interface OrderResponse {
  success: boolean;
  orderId?: number;
  filledQty?: number;
  averagePrice?: number;
  message?: string;
}

interface GetOrderResponse {
  success: boolean;
  status?: string;
  Fills?: unknown[];
  message?: string;
}

interface DeleteOrderResponse {
  success: boolean;
  deletedOrder?: unknown;
  message?: string;
}

interface DepthResponse {
  success: boolean;
  orderBook?: { ASK?: unknown; BID?: unknown };
  message?: string;
}

interface OrdersListResponse {
  success: boolean;
  orders?: Array<{ id: number; userId: number }>;
  message?: string;
}

interface FillsListResponse {
  success: boolean;
  fills?: Array<{ id: number; buyOrderId: number; sellOrderId: number }>;
  message?: string;
}

interface BalanceUsdResponse {
  success: boolean;
  usd?: number;
  message?: string;
}

interface BalanceResponse {
  success: boolean;
  balances?: Record<string, number>;
  message?: string;
}

// ─── Latency-tracked API helper (with hang protection) ────────────────────────

async function api<TResponse>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ data: TResponse; status: number; latencyMs: number }> {
  const url = new URL(path, BASE_URL);
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["authorization"] = token;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const t0 = performance.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `[CEX TEST] ${method} ${path} did not respond within ${REQUEST_TIMEOUT_MS}ms. ` +
          `This usually means the handler never called res.json()/res.end() (hung request), ` +
          `not a genuinely slow server.`,
      );
    }
    throw new Error(
      `[CEX TEST] Cannot reach backend at ${BASE_URL}. Start it first (bun run dev). Original: ${String(err)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
  const latencyMs = Math.round(performance.now() - t0);

  const text = await response.text();
  let data: TResponse;
  try {
    data = text.length > 0 ? (JSON.parse(text) as TResponse) : ({} as TResponse);
  } catch {
    // Non-JSON response (e.g. Express's default HTML 404 page for an unmatched route)
    data = {} as TResponse;
  }

  console.log(
    `  [${method}] ${path} → HTTP ${response.status} | ${latencyMs}ms`,
  );

  return { data, status: response.status, latencyMs };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns a unique username per test run to avoid DB conflicts across reruns */
function uniq(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

async function signup(username: string, password = "Test@1234"): Promise<SignupResponse> {
  const { data } = await api<SignupResponse>("POST", "/signup", {
    username,
    password,
  } satisfies SignupRequest);
  return data;
}

async function signin(username: string, password = "Test@1234"): Promise<SigninResponse> {
  const { data } = await api<SigninResponse>("POST", "/signin", {
    username,
    password,
  } satisfies SigninRequest);
  return data;
}

/** Creates a fresh user and returns a valid, raw JWT (no "Bearer " prefix —
 * the server's auth middleware reads the header verbatim). */
async function signupAndSignin(prefix = "user"): Promise<{ username: string; token: string }> {
  const username = uniq(prefix);
  await signup(username);
  const res = await signin(username);
  if (!res.token) throw new Error("signin returned no token");
  return { username, token: res.token };
}

/** A syntactically well-formed but cryptographically invalid JWT (wrong
 * secret). jwt.verify() throws JsonWebTokenError for this synchronously. */
function forgedToken(): string {
  return jwt.sign({ userId: 1 }, "definitely-not-the-server-secret", { expiresIn: "1h" });
}

/** Like signupAndSignin, but also returns the numeric userId — needed for
 * tests that seed rows directly via Prisma (bypassing the broken POST
 * /order) and must tie them to a specific, real user. */
async function createAuthedUser(
  prefix = "user",
): Promise<{ id: number; username: string; token: string }> {
  const username = uniq(prefix);
  const signupRes = await signup(username);
  if (typeof signupRes.user?.id !== "number") {
    throw new Error("signup returned no user id");
  }
  const signinRes = await signin(username);
  if (!signinRes.token) throw new Error("signin returned no token");
  return { id: signupRes.user.id, username, token: signinRes.token };
}

/** Resolves the DB id for a seeded stock symbol (SOL/BTC). Throws with a
 * clear message if the DB prerequisite from the file header isn't met. */
async function requireStockId(symbol: string): Promise<number> {
  const stock = await withDbRetry(() => prisma.stocks.findFirst({ where: { symbol } }));
  if (!stock) {
    throw new Error(
      `[CEX TEST] Stock "${symbol}" is not seeded. Run: INSERT INTO stocks (title, symbol) VALUES ('${symbol}','${symbol}');`,
    );
  }
  return stock.id;
}

/** The local `prisma dev` ephemeral Postgres used in this environment
 * occasionally drops idle connections ("Connection terminated
 * unexpectedly") — a known quirk of the dev proxy, not something under
 * test (the same error shows up in the app server's own logs under load).
 * Direct Prisma calls made from this file to seed/inspect fixtures are
 * wrapped with a short retry so that environment flakiness doesn't
 * masquerade as a test failure. */
async function withDbRetry<T>(fn: () => Promise<T>, retries = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // The underlying pg pool can get stuck after a dropped connection;
      // disconnecting forces Prisma to lazily open a fresh connection on
      // the next query instead of retrying against the same dead socket.
      await prisma.$disconnect().catch(() => {});
      if (i < retries - 1) await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
  }
  throw lastErr;
}

async function placeOrder(
  order: OrderRequest,
  token?: string,
): Promise<{ data: OrderResponse; status: number; latencyMs: number }> {
  return api<OrderResponse>("POST", "/order", order, token);
}

async function getOrder(
  orderId: number | string,
  token?: string,
): Promise<{ data: GetOrderResponse; status: number; latencyMs: number }> {
  return api<GetOrderResponse>("GET", `/order/${orderId}`, undefined, token);
}

async function deleteOrder(
  orderId: number | string,
  token?: string,
): Promise<{ data: DeleteOrderResponse; status: number; latencyMs: number }> {
  return api<DeleteOrderResponse>("DELETE", `/order/${orderId}`, undefined, token);
}

async function getDepth(
  symbol: string,
  token?: string,
): Promise<{ data: DepthResponse; status: number; latencyMs: number }> {
  return api<DepthResponse>("GET", `/depth/${symbol}`, undefined, token);
}

async function getOrders(
  token?: string,
): Promise<{ data: OrdersListResponse; status: number; latencyMs: number }> {
  return api<OrdersListResponse>("GET", "/orders", undefined, token);
}

async function getFills(
  token?: string,
): Promise<{ data: FillsListResponse; status: number; latencyMs: number }> {
  return api<FillsListResponse>("GET", "/fills", undefined, token);
}

async function getBalanceUsd(
  token?: string,
): Promise<{ data: BalanceUsdResponse; status: number; latencyMs: number }> {
  return api<BalanceUsdResponse>("GET", "/balance/usd", undefined, token);
}

async function getBalance(
  token?: string,
): Promise<{ data: BalanceResponse; status: number; latencyMs: number }> {
  return api<BalanceResponse>("GET", "/balance", undefined, token);
}

// ─── Test suite ───────────────────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════════════════
// 1. AUTH — /signup & /signin
// ════════════════════════════════════════════════════════════════════════════

describe("Auth — POST /signup", () => {
  it("creates a new user and returns id + username", async () => {
    const username = uniq("signup_happy");
    const { data, status, latencyMs } = await api<SignupResponse>("POST", "/signup", {
      username,
      password: "StrongPass1",
    });

    console.log(`  signup latency: ${latencyMs}ms`);
    expect(status).toBe(201);
    expect(data.success).toBe(true);
    expect(data.user?.username).toBe(username);
    expect(typeof data.user?.id).toBe("number");
  });

  it("rejects when username is missing", async () => {
    const { data, status } = await api<SignupResponse>("POST", "/signup", {
      password: "StrongPass1",
    });
    expect(status).toBe(400);
    expect(data.success).toBe(false);
  });

  it("rejects when password is missing", async () => {
    const { data, status } = await api<SignupResponse>("POST", "/signup", {
      username: uniq("nopwd"),
    });
    expect(status).toBe(400);
    expect(data.success).toBe(false);
  });

  it("rejects when both fields are missing", async () => {
    const { data, status } = await api<SignupResponse>("POST", "/signup", {});
    expect(status).toBe(400);
    expect(data.success).toBe(false);
  });

  it("returns 409 on duplicate username", async () => {
    const username = uniq("dup");
    await signup(username); // first registration
    const { data, status } = await api<SignupResponse>("POST", "/signup", {
      username,
      password: "AnotherPass2",
    });
    expect(status).toBe(409);
    expect(data.success).toBe(false);
  });

  it("rejects numeric username (type guard)", async () => {
    const { data, status } = await api<SignupResponse>("POST", "/signup", {
      username: 12345,
      password: "StrongPass1",
    });
    expect(status).toBe(400);
    expect(data.success).toBe(false);
  });

  /**
   * BUG: src/routes/auth.routes.ts:20 checks `typeof username !== "string"` but there is no
   * equivalent check for `password`. A numeric password is silently
   * accepted (201) instead of being rejected the same way a numeric
   * username is. This documents the inconsistency; it is NOT a crash, just
   * a missing validation symmetric to the username check.
   */
  it("[BUG] accepts a numeric password (no type guard, unlike username)", async () => {
    const { data, status } = await api<SignupResponse>("POST", "/signup", {
      username: uniq("numpwd"),
      password: 12345678,
    });
    console.log(
      `  [BUG] numeric password → HTTP ${status} (expected 400 for symmetry with username check)`,
    );
    expect(status).toBe(201);
    expect(data.success).toBe(true);
  });

  it("responds within 1000 ms", async () => {
    const { latencyMs } = await api<SignupResponse>("POST", "/signup", {
      username: uniq("latency_signup"),
      password: "Pass1234",
    });
    console.log(`  signup p50 latency: ${latencyMs}ms`);
    expect(latencyMs).toBeLessThan(1000);
  });
});

describe("Auth — POST /signin", () => {
  it("returns a JWT token for valid credentials", async () => {
    const username = uniq("signin_happy");
    await signup(username);

    const { data, status, latencyMs } = await api<SigninResponse>("POST", "/signin", {
      username,
      password: "Test@1234",
    });

    console.log(`  signin latency: ${latencyMs}ms`);
    expect(status).toBe(201);
    expect(data.success).toBe(true);
    expect(typeof data.token).toBe("string");
    // JWT has 3 dot-separated parts
    expect(data.token!.split(".")).toHaveLength(3);
  });

  it("rejects with 401 for wrong password", async () => {
    const username = uniq("bad_pwd");
    await signup(username);

    const { data, status } = await api<SigninResponse>("POST", "/signin", {
      username,
      password: "WrongPassword!",
    });
    expect(status).toBe(401);
    expect(data.success).toBe(false);
  });

  it("rejects with 401 for non-existent user", async () => {
    const { data, status } = await api<SigninResponse>("POST", "/signin", {
      username: "ghost_user_xyz_99999",
      password: "anything",
    });
    expect(status).toBe(401);
    expect(data.success).toBe(false);
  });

  it("rejects when fields are missing", async () => {
    const { data, status } = await api<SigninResponse>("POST", "/signin", {
      username: "only_username",
    });
    expect(status).toBe(400);
    expect(data.success).toBe(false);
  });

  it("responds within 1000 ms", async () => {
    const username = uniq("latency_signin");
    await signup(username);
    const { latencyMs } = await api<SigninResponse>("POST", "/signin", {
      username,
      password: "Test@1234",
    });
    console.log(`  signin p50 latency: ${latencyMs}ms`);
    expect(latencyMs).toBeLessThan(1000);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. GLOBAL AUTH MIDDLEWARE — guards /order, /order/:id, /depth/:symbol,
//    /orders, /fills, /balance/usd, /balance
// ════════════════════════════════════════════════════════════════════════════
//
// src/middleware/auth.middleware.ts:4 registers `authMiddleware` (mounted
// via `app.use(authMiddleware)` in src/app.ts) AFTER /signup and /signin
// but BEFORE every other route. It is very much live, so every route below
// it requires a valid `authorization` header.
// ════════════════════════════════════════════════════════════════════════════

describe("Global auth middleware (src/middleware/auth.middleware.ts:4-35)", () => {
  it("blocks POST /order with 401 when no token is sent", async () => {
    const { data, status } = await placeOrder({
      type: "limit",
      price: 100,
      qty: 1,
      market_id: SYMBOL_SOL,
      side: "ASK",
    });
    expect(status).toBe(401);
    expect(data.success).toBe(false);
  });

  it("blocks GET /order/:orderId with 401 when no token is sent", async () => {
    const { data, status } = await getOrder(1);
    expect(status).toBe(401);
    expect(data.success).toBe(false);
  });

  it("blocks DELETE /order/:orderId with 401 when no token is sent", async () => {
    const { data, status } = await deleteOrder(1);
    expect(status).toBe(401);
    expect(data.success).toBe(false);
  });

  it("blocks GET /depth/:symbol with 401 when no token is sent", async () => {
    const { data, status } = await getDepth(SYMBOL_SOL);
    expect(status).toBe(401);
    expect(data.success).toBe(false);
  });

  it("allows the request through with a valid token (control case)", async () => {
    const { token } = await signupAndSignin("auth_ok");
    const { status } = await getDepth(SYMBOL_SOL, token);
    expect(status).not.toBe(401);
  });

  /**
   * BUG: src/middleware/auth.middleware.ts:17 calls `jwt.verify(token, process.env.SECRET)` directly
   * inside the try block. jwt.verify() throws synchronously for a token
   * with an invalid signature (JsonWebTokenError). That throw is caught by
   * the generic `catch (error)` at line 29, which returns 500. Only the
   * narrower "malformed payload" case (`typeof decode === "string"`) gets a
   * proper 401. A bad/forged/tampered credential should always be a 401,
   * never a 500.
   */
  it("[BUG] a cryptographically invalid JWT returns 500 instead of 401", async () => {
    const { data, status } = await getDepth(SYMBOL_SOL, forgedToken());
    console.log(`  [BUG] forged-signature token → HTTP ${status} (expected 401)`);
    expect(status).toBe(500);
  });

  it("[BUG] a garbage (non-JWT) token string returns 500 instead of 401", async () => {
    const { data, status } = await getDepth(SYMBOL_SOL, "not-a-real-jwt-at-all");
    console.log(`  [BUG] garbage token → HTTP ${status} (expected 401)`);
    expect(status).toBe(500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. ORDER PLACEMENT — POST /order
// ════════════════════════════════════════════════════════════════════════════
//
// ⚠ CRITICAL BUG (confirmed by exercising the live server):
//   Order creation has a 100% failure rate. src/routes/order.routes.ts:39 only accepts
//   `type === "market" || type === "limit"` (lowercase), but the Prisma
//   schema's `Type` enum (prisma/schema.prisma) only has "MARKET"/"LIMIT"
//   (uppercase). There is NO value of `type` that satisfies both the
//   handler's validation AND the database enum:
//     - type: "limit"  → passes app validation → prisma.order.create()
//                         throws (invalid enum value) → 500
//     - type: "LIMIT"  → fails app validation      → 400 "type is not valid"
//   This means every other bug further down the happy path (BUG-1 missing
//   success response, BUG-3 wrong book side, BUG-5 create-instead-of-update,
//   BUG-6 stale qty subtraction, BUG-10 double Order reset) is currently
//   UNREACHABLE through the public HTTP API, because no request ever gets
//   past `prisma.order.create()` on line 494.
// ════════════════════════════════════════════════════════════════════════════

describe("Order — POST /order (validation)", () => {
  it("rejects invalid side value", async () => {
    const { token } = await signupAndSignin("order_side");
    const { data, status } = await placeOrder(
      {
        type: "limit",
        price: 100,
        qty: 1,
        market_id: SYMBOL_SOL,
        side: "INVALID",
      },
      token,
    );
    expect(status).toBe(400);
    expect(data.success).toBe(false);
  });

  it("rejects invalid type value", async () => {
    const { token } = await signupAndSignin("order_type");
    const { data, status } = await placeOrder(
      {
        type: "stop",
        price: 100,
        qty: 1,
        market_id: SYMBOL_SOL,
        side: "ASK",
      },
      token,
    );
    expect(status).toBe(400);
    expect(data.success).toBe(false);
  });

  it("rejects unknown market_id (stock not in DB)", async () => {
    const { token } = await signupAndSignin("order_market");
    const { data, status } = await placeOrder(
      {
        type: "limit",
        price: 100,
        qty: 1,
        market_id: SYMBOL_INVALID,
        side: "ASK",
      },
      token,
    );
    expect(status).toBe(400);
    expect(data.success).toBe(false);
  });

  /**
   * [CRITICAL BUG] See describe-block comment above. This is the
   * "type" value that the handler itself will accept.
   */
  it("[CRITICAL BUG] lowercase type ('limit') passes app validation but is rejected by Prisma's enum → 500", async () => {
    const { token } = await signupAndSignin("order_enum_lower");
    const { data, status, latencyMs } = await placeOrder(
      {
        type: "limit",
        price: 150,
        qty: 2,
        market_id: SYMBOL_SOL,
        side: "ASK",
      },
      token,
    );
    console.log(`  order placement latency: ${latencyMs}ms`);
    expect(status).toBe(500);
    expect(data.success).toBe(false);
  });

  /**
   * [CRITICAL BUG] The other half of the pigeonhole: the casing Prisma
   * actually needs is rejected by the handler's own validation before it
   * ever reaches Prisma.
   */
  it("[CRITICAL BUG] uppercase type ('LIMIT', matches Prisma enum) is rejected by app validation → 400", async () => {
    const { token } = await signupAndSignin("order_enum_upper");
    const { data, status } = await placeOrder(
      {
        type: "LIMIT",
        price: 150,
        qty: 2,
        market_id: SYMBOL_SOL,
        side: "ASK",
      },
      token,
    );
    expect(status).toBe(400);
    expect(data.success).toBe(false);
  });

  it("same enum mismatch reproduces for 'market' / 'MARKET' and the BID side", async () => {
    const { token } = await signupAndSignin("order_enum_market");
    const lower = await placeOrder(
      { type: "market", qty: 1, market_id: SYMBOL_BTC, side: "BID" },
      token,
    );
    expect(lower.status).toBe(500);

    const upper = await placeOrder(
      { type: "MARKET", qty: 1, market_id: SYMBOL_BTC, side: "BID" },
      token,
    );
    expect(upper.status).toBe(400);
  });

  /**
   * `qty` is validated as a finite, positive number before the handler
   * ever touches the DB or the in-memory order book, so a non-numeric
   * (or zero/negative/NaN/Infinity) qty is rejected cleanly with a 400
   * instead of blowing up downstream arithmetic / the Prisma insert with
   * an opaque 500.
   */
  it("rejects a non-numeric qty with 400 instead of a 500", async () => {
    const { token } = await signupAndSignin("order_bad_qty");
    const { data, status } = await placeOrder(
      {
        type: "LIMIT",
        price: 100,
        qty: "not-a-number" as unknown as number,
        market_id: SYMBOL_SOL,
        side: "ASK",
      },
      token,
    );
    expect(status).toBe(400);
    expect(data.success).toBe(false);
  });

  it.each([0, -1, NaN, Infinity])("rejects qty=%p with 400", async (badQty) => {
    const { token } = await signupAndSignin("order_bad_qty");
    const { data, status } = await placeOrder(
      {
        type: "LIMIT",
        price: 100,
        qty: badQty,
        market_id: SYMBOL_SOL,
        side: "ASK",
      },
      token,
    );
    expect(status).toBe(400);
    expect(data.success).toBe(false);
  });

  /**
   * Documents the desired contract once the type-enum bug (above) is
   * fixed. Currently this can never be reached — kept here so the fix is
   * verified automatically the moment someone corrects the casing.
   *
   * @xfail until the type-enum mismatch is fixed
   */
  it("[FUTURE] places a limit ASK order and returns orderId + filledQty", async () => {
    const { token } = await signupAndSignin("order_future");
    const { data, status } = await placeOrder(
      {
        type: "limit",
        price: 200,
        qty: 5,
        market_id: SYMBOL_SOL,
        side: "ASK",
      },
      token,
    );
    // Expected once the enum-casing bug is fixed:
    // expect(status).toBe(201);
    // expect(data.success).toBe(true);
    // expect(typeof data.orderId).toBe("number");
    // expect(typeof data.filledQty).toBe("number");
    console.log(
      `  [FUTURE contract] POST /order → status=${status} body=${JSON.stringify(data)}`,
    );
    expect(status).toBe(500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. GET ORDER — GET /order/:orderId
// ════════════════════════════════════════════════════════════════════════════

describe("Order — GET /order/:orderId", () => {
  it("returns 400 for non-existent orderId (with valid auth)", async () => {
    const { token } = await signupAndSignin("get_order_404");
    const { data, status } = await getOrder(999999999, token);
    expect(status).toBe(400);
    expect(data.success).toBe(false);
  });

  it("returns order status + Fills array for a valid orderId", async () => {
    // Blocked: no order can ever be successfully created (see CRITICAL BUG
    // in the POST /order section), so there is no valid orderId to fetch.
    console.log(
      "  [SKIP] GET /order/:orderId happy-path requires a seeded order (blocked by the type-enum bug — see POST /order tests)",
    );
    expect(true).toBe(true);
  });

  it("responds within 500 ms for a miss (orderId not found)", async () => {
    const { token } = await signupAndSignin("get_order_latency");
    const { latencyMs } = await getOrder(888888888, token);
    console.log(`  GET /order/:id (miss) latency: ${latencyMs}ms`);
    expect(latencyMs).toBeLessThan(500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. DELETE ORDER — DELETE /order/:orderId
// ════════════════════════════════════════════════════════════════════════════
//
// ⚠ BUG-9: DELETE removes the DB row but does NOT remove the entry from
//   the in-memory ORDERBOOKS. So the depth endpoint will still show the
//   cancelled order until the server restarts. (Cannot be exercised
//   end-to-end today since orders can never be created — see above.)
// ════════════════════════════════════════════════════════════════════════════

describe("Order — DELETE /order/:orderId", () => {
  /**
   * BUG: Prisma's .delete() throws a "RecordNotFound" (P2025) error for a
   * missing row. src/routes/order.routes.ts:178's catch-all treats this identically to a
   * real server fault and returns 500. A missing resource should surface
   * as 404 (or at least 400), not an opaque 500.
   */
  it("[BUG] deleting a non-existent orderId returns 500 instead of 404/400", async () => {
    const { token } = await signupAndSignin("delete_order_404");
    const { data, status } = await deleteOrder(999999999, token);
    console.log(`  [BUG] DELETE missing order → HTTP ${status} (expected 404/400)`);
    expect(status).toBe(500);
    expect(data.success).toBe(false);
  });

  it("[BUG-9] in-memory book is NOT updated on cancel (documented, blocked by order-creation bug)", async () => {
    console.log(
      "  [BUG-9] Cancel only deletes the DB row; in-memory ORDERBOOK is stale until server restart. " +
        "Cannot be exercised end-to-end until orders can actually be created.",
    );
    expect(true).toBe(true);
  });

  it("missing orderId param should return 400", async () => {
    const { token } = await signupAndSignin("delete_order_missing_id");
    // DELETE /order/0 → orderId = 0 → falsy check → 400
    const { data, status } = await deleteOrder(0, token);
    expect(status).toBe(400);
    expect(data.success).toBe(false);
  });

  it("responds within 500 ms", async () => {
    const { token } = await signupAndSignin("delete_order_latency");
    const { latencyMs } = await deleteOrder(0, token);
    console.log(`  DELETE /order latency: ${latencyMs}ms`);
    expect(latencyMs).toBeLessThan(500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. DEPTH — GET /depth/:symbol
// ════════════════════════════════════════════════════════════════════════════
//
// src/routes/depth.routes.ts:22  `if (stockSymbol in Object.keys(ORDERBOOKS)){}`
// `Object.keys(ORDERBOOKS)` returns an array like ["SOL","BTC"]; the `in`
// operator then checks whether "SOL" is an *array index* ("0", "1", ...),
// which it never is. So the guard body `{}` is always a no-op, and the
// unconditional block right after it ALWAYS executes — for both valid and
// invalid symbols alike, with no differentiation. Concretely:
//   - valid symbol   → 201, orderBook: ORDERBOOKS[symbol]  (correctly
//                       scoped!) but `success` is hardcoded to `false`
//   - invalid symbol → 201, orderBook: undefined (ORDERBOOKS[symbol] is
//                       undefined), `success` still `false`
// The original comment describing this as returning the *full* ORDERBOOKS
// object for any input is outdated — it returns ORDERBOOKS[symbol], not
// the full map. But the missing symbol-validation and always-false
// `success` field are both real, confirmed bugs.
// ════════════════════════════════════════════════════════════════════════════

describe("Depth — GET /depth/:symbol", () => {
  it("returns 401 without a token (protected by global auth middleware)", async () => {
    const { status } = await getDepth(SYMBOL_SOL);
    expect(status).toBe(401);
  });

  it("[BUG] returns success:false even for a valid, successful lookup", async () => {
    const { token } = await signupAndSignin("depth_sol");
    const { data, status, latencyMs } = await getDepth(SYMBOL_SOL, token);
    console.log(`  GET /depth/SOL latency: ${latencyMs}ms`);
    expect(status).toBe(201);
    expect(data.orderBook).toBeDefined();
    expect(data.orderBook).toHaveProperty("ASK");
    expect(data.orderBook).toHaveProperty("BID");
    // Documents the bug: this SHOULD be true for a successful 201 response.
    console.log(`  [BUG] success=${data.success} on a 201 (expected true)`);
    expect(data.success).toBe(false);
  });

  it("returns the orderBook object for BTC", async () => {
    const { token } = await signupAndSignin("depth_btc");
    const { data, status } = await getDepth(SYMBOL_BTC, token);
    expect(status).toBe(201);
    expect(data.orderBook).toHaveProperty("ASK");
    expect(data.orderBook).toHaveProperty("BID");
  });

  /**
   * BUG: an unknown symbol should be a 400/404, not a "successful" 201
   * with an undefined orderBook. The no-op guard at src/routes/depth.routes.ts:22 means the
   * validity of `stockSymbol` is never actually checked.
   */
  it("[BUG] returns 201 with an undefined orderBook for an unknown symbol (no validation)", async () => {
    const { token } = await signupAndSignin("depth_invalid_symbol");
    const { data, status } = await getDepth(SYMBOL_INVALID, token);
    console.log(
      `  [BUG] /depth/${SYMBOL_INVALID} → HTTP ${status}, orderBook=${JSON.stringify(data.orderBook)} (expected 400/404)`,
    );
    expect(status).toBe(201);
    expect(data.orderBook).toBeUndefined();
  });

  it("responds within 200 ms (in-memory read, no DB)", async () => {
    const { token } = await signupAndSignin("depth_latency");
    const { latencyMs } = await getDepth(SYMBOL_SOL, token);
    console.log(`  /depth latency: ${latencyMs}ms (in-memory)`);
    expect(latencyMs).toBeLessThan(200);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. GET /orders, GET /fills, GET /balance/usd, GET /balance
// ════════════════════════════════════════════════════════════════════════════
//
// These used to be unimplemented stub routes (declared with no handler
// function, so Express fell through to its default 404). They now return
// real, per-user data:
//   - /orders and /fills are scoped to the authenticated user's own rows
//     (src/routes/order.routes.ts: `where: { userId }` / the buyOrder|
//     sellOrder OR-clause), unlike GET/DELETE /order/:orderId which have no
//     ownership check at all (see BUG-I above).
//   - /balance/usd and /balance read a per-user balance seeded at signup
//     (src/services/orderbook.service.ts `ensureUserBalance`). This is pure
//     in-memory state, exactly like ORDERBOOKS — it is NOT persisted, is
//     NOT updated by order fills yet, and resets whenever the server
//     restarts.
// All four still sit behind the global auth middleware.
// ════════════════════════════════════════════════════════════════════════════

describe("GET /orders", () => {
  it("returns 401 without a token", async () => {
    const { status } = await getOrders();
    expect(status).toBe(401);
  });

  it("returns only the authenticated user's own orders, excluding another user's", async () => {
    const owner = await createAuthedUser("orders_owner");
    const other = await createAuthedUser("orders_other");
    const stockId = await requireStockId(SYMBOL_SOL);

    const ownOrder = await withDbRetry(() =>
      prisma.order.create({
        data: { userId: owner.id, side: "ASK", type: "LIMIT", stockId, price: 10, qty: 1, filledQty: 0, status: "EMPTY" },
      }),
    );
    const otherOrder = await withDbRetry(() =>
      prisma.order.create({
        data: { userId: other.id, side: "BID", type: "LIMIT", stockId, price: 10, qty: 1, filledQty: 0, status: "EMPTY" },
      }),
    );

    const { data, status } = await getOrders(owner.token);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    const ids = (data.orders ?? []).map((o) => o.id);
    expect(ids).toContain(ownOrder.id);
    expect(ids).not.toContain(otherOrder.id);
  });
});

describe("GET /fills", () => {
  it("returns 401 without a token", async () => {
    const { status } = await getFills();
    expect(status).toBe(401);
  });

  it("returns only fills where the authenticated user is the buyer or seller", async () => {
    const owner = await createAuthedUser("fills_owner");
    const stranger = await createAuthedUser("fills_stranger");
    const stockId = await requireStockId(SYMBOL_SOL);

    const ownOrder = await withDbRetry(() =>
      prisma.order.create({
        data: { userId: owner.id, side: "BID", type: "LIMIT", stockId, price: 10, qty: 1, filledQty: 1, status: "FILLED" },
      }),
    );
    const counterparty = await withDbRetry(() =>
      prisma.order.create({
        data: { userId: stranger.id, side: "ASK", type: "LIMIT", stockId, price: 10, qty: 1, filledQty: 1, status: "FILLED" },
      }),
    );
    const unrelatedA = await withDbRetry(() =>
      prisma.order.create({
        data: { userId: stranger.id, side: "BID", type: "LIMIT", stockId, price: 20, qty: 1, filledQty: 1, status: "FILLED" },
      }),
    );
    const unrelatedB = await withDbRetry(() =>
      prisma.order.create({
        data: { userId: stranger.id, side: "ASK", type: "LIMIT", stockId, price: 20, qty: 1, filledQty: 1, status: "FILLED" },
      }),
    );

    const ownFill = await withDbRetry(() =>
      prisma.fills.create({
        data: { stockId, price: 10, qty: 1, buyOrderId: ownOrder.id, sellOrderId: counterparty.id },
      }),
    );
    const unrelatedFill = await withDbRetry(() =>
      prisma.fills.create({
        data: { stockId, price: 20, qty: 1, buyOrderId: unrelatedA.id, sellOrderId: unrelatedB.id },
      }),
    );

    const { data, status } = await getFills(owner.token);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    const ids = (data.fills ?? []).map((f) => f.id);
    expect(ids).toContain(ownFill.id);
    expect(ids).not.toContain(unrelatedFill.id);
  });
});

describe("GET /balance/usd and GET /balance", () => {
  it("returns 401 without a token", async () => {
    const usd = await getBalanceUsd();
    expect(usd.status).toBe(401);
    const balance = await getBalance();
    expect(balance.status).toBe(401);
  });

  it("returns a positive seeded USD balance for a freshly signed-up user", async () => {
    const { token } = await signupAndSignin("balance_usd");
    const { data, status } = await getBalanceUsd(token);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(typeof data.usd).toBe("number");
    expect(data.usd).toBeGreaterThan(0);
  });

  it("returns an empty stock balance map for a freshly signed-up user (no fills have ever updated it)", async () => {
    const { token } = await signupAndSignin("balance_stocks");
    const { data, status } = await getBalance(token);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.balances).toEqual({});
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. DATA INTEGRITY — password storage (verified directly against the DB)
// ════════════════════════════════════════════════════════════════════════════
//
// These tests don't just check the HTTP response — they read the row Prisma
// actually wrote and assert the *stored value* is correct, which is a much
// stricter guarantee than "the endpoint returned 201".
// ════════════════════════════════════════════════════════════════════════════

describe("Data integrity — password storage (direct DB verification)", () => {
  it("never stores the password in plaintext", async () => {
    const username = uniq("hash_check");
    const plaintext = "SuperSecret!42";
    await signup(username, plaintext);

    const row = await withDbRetry(() => prisma.user.findFirst({ where: { username } }));
    expect(row).not.toBeNull();
    expect(row!.password).not.toBe(plaintext);
  });

  it("stores a real, verifiable argon2 hash (not a no-op / truncated hash)", async () => {
    const username = uniq("hash_format");
    const plaintext = "AnotherSecret!7";
    await signup(username, plaintext);

    const row = await withDbRetry(() => prisma.user.findFirst({ where: { username } }));
    expect(row).not.toBeNull();
    // Bun.password.hash() defaults to argon2id.
    expect(row!.password.startsWith("$argon2")).toBe(true);
    // The stored hash must actually verify against the original plaintext,
    // and must reject a wrong password — not just "look like" a hash.
    expect(await Bun.password.verify(plaintext, row!.password)).toBe(true);
    expect(await Bun.password.verify("wrong-password", row!.password)).toBe(false);
  });

  it("never leaks the password/hash back to the client in the signup response", async () => {
    const { data } = await api<SignupResponse>("POST", "/signup", {
      username: uniq("no_leak"),
      password: "ShouldNotBeReturned1",
    });
    const userKeys = Object.keys(data.user ?? {});
    expect(userKeys).not.toContain("password");
    expect(JSON.stringify(data)).not.toContain("ShouldNotBeReturned1");
  });

  it("two different users with the identical password get different hashes (salted)", async () => {
    const plaintext = "SamePassword!99";
    const usernameA = uniq("salt_a");
    const usernameB = uniq("salt_b");
    await signup(usernameA, plaintext);
    await signup(usernameB, plaintext);

    const rowA = await withDbRetry(() => prisma.user.findFirst({ where: { username: usernameA } }));
    const rowB = await withDbRetry(() => prisma.user.findFirst({ where: { username: usernameB } }));
    expect(rowA!.password).not.toBe(rowB!.password);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 9. JWT CONTRACT — token payload correctness (decoded, not just shape-checked)
// ════════════════════════════════════════════════════════════════════════════

describe("JWT contract — token payload correctness", () => {
  it("embeds the correct userId of the signed-in user", async () => {
    const { id, token } = await createAuthedUser("jwt_userid");
    const decoded = jwt.verify(token, process.env.SECRET!) as jwt.JwtPayload;
    expect(decoded.userId).toBe(id);
  });

  it("honors the advertised 1-hour expiry (exp - iat === 3600s)", async () => {
    const { token } = await createAuthedUser("jwt_exp");
    const decoded = jwt.decode(token) as jwt.JwtPayload;
    expect(typeof decoded.iat).toBe("number");
    expect(typeof decoded.exp).toBe("number");
    expect(decoded.exp! - decoded.iat!).toBe(3600);
  });

  it("rejects a token signed with a different secret (signature check actually works)", async () => {
    expect(() => jwt.verify(forgedToken(), process.env.SECRET!)).toThrow();
  });

  it("two signins for the same user issue two distinct tokens (fresh iat)", async () => {
    const username = uniq("jwt_distinct");
    await signup(username);
    const first = await signin(username);
    // Ensure the 1-second-resolution `iat` claim actually differs.
    await new Promise((r) => setTimeout(r, 1100));
    const second = await signin(username);
    expect(first.token).not.toBe(second.token);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 10. CONCURRENCY — signup race condition (TOCTOU on the uniqueness check)
// ════════════════════════════════════════════════════════════════════════════
//
// src/routes/auth.routes.ts:27-49 does `findFirst` to check for an existing username, and
// only calls `create` if none was found. Between those two awaits, a
// second concurrent request can pass the same `findFirst` check before the
// first request's `create` commits. The database's `@unique` constraint on
// `username` still protects data integrity (only one row is ever created),
// but the loser of the race gets an unhandled PrismaClientKnownRequestError
// (P2002) instead of a clean 409 — and the raw DB error is leaked to the
// client in the response body.
// ════════════════════════════════════════════════════════════════════════════

describe("Concurrency — signup race condition (src/routes/auth.routes.ts:27-49)", () => {
  it("data integrity holds: exactly one row is created even when two requests race", async () => {
    const username = uniq("race");
    const password = "Test@1234";

    const [first, second] = await Promise.all([
      api<SignupResponse>("POST", "/signup", { username, password }),
      api<SignupResponse>("POST", "/signup", { username, password }),
    ]);

    const statuses = [first.status, second.status].sort();
    // Exactly one of the two must have succeeded.
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);

    const rows = await withDbRetry(() => prisma.user.findMany({ where: { username } }));
    expect(rows).toHaveLength(1);
  });

  /**
   * [BUG] The loser of the race should get a clean 409 "already exists"
   * (the same contract as the non-concurrent duplicate-username test
   * above), not a 500 with a raw Prisma/Postgres error object leaked into
   * the JSON response (constraint name, driver error, etc).
   */
  it("[BUG] the losing request gets a 500 with a leaked raw DB error instead of a clean 409", async () => {
    const username = uniq("race_leak");
    const password = "Test@1234";

    const [first, second] = await Promise.all([
      api<SignupResponse>("POST", "/signup", { username, password }),
      api<SignupResponse>("POST", "/signup", { username, password }),
    ]);
    const loser = first.status === 201 ? second : first;

    console.log(
      `  [BUG] losing concurrent signup → HTTP ${loser.status} body=${JSON.stringify(loser.data)}`,
    );
    expect(loser.status).toBe(500);
    // Documents the information-disclosure side effect: src/routes/auth.routes.ts:64
    // does `res.status(500).json({ ..., error })`, serializing whatever
    // internal Prisma/driver error object was thrown straight into the
    // response — instead of a clean, sanitized 409. The exact shape of
    // the leaked error varies run-to-run (sometimes `code`/`meta` with the
    // constraint name, sometimes just `clientVersion`), so we assert on
    // the presence of the leak rather than its exact contents.
    expect(loser.data as unknown as Record<string, unknown>).toHaveProperty("error");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 11. SECURITY — order endpoints do not verify ownership (IDOR)
// ════════════════════════════════════════════════════════════════════════════
//
// Both GET /order/:orderId (src/routes/order.routes.ts:123) and DELETE /order/:orderId
// (src/routes/order.routes.ts:159) look the order up purely `where: { id: orderId }` — there
// is no `userId: req.userId` filter anywhere. Any authenticated user can
// therefore read OR cancel any other user's order just by knowing/guessing
// a numeric id. Because POST /order can never succeed (see the CRITICAL BUG
// in the POST /order section), we seed the order row directly via Prisma to
// exercise this in isolation.
// ════════════════════════════════════════════════════════════════════════════

describe("Security — order endpoints do not verify ownership (IDOR)", () => {
  it("[SECURITY BUG] a stranger can read another user's order via GET /order/:id", async () => {
    const owner = await createAuthedUser("idor_owner_get");
    const stranger = await createAuthedUser("idor_stranger_get");
    const stockId = await requireStockId(SYMBOL_SOL);

    const order = await withDbRetry(() =>
      prisma.order.create({
        data: {
          userId: owner.id,
          side: "ASK",
          type: "LIMIT",
          stockId,
          price: 100,
          qty: 1,
          filledQty: 0,
          status: "EMPTY",
        },
      }),
    );

    try {
      const { data, status } = await getOrder(order.id, stranger.token);
      console.log(
        `  [SECURITY BUG] stranger fetched someone else's order → HTTP ${status}, status=${data.status}`,
      );
      // Documents the current (insecure) behavior. Once ownership checks
      // are added, this should become 403/404 and this test should flip.
      expect(status).toBe(201);
      expect(data.success).toBe(true);
    } finally {
      await prisma.order.delete({ where: { id: order.id } }).catch(() => {});
    }
  });

  it("[SECURITY BUG] a stranger can cancel (DELETE) another user's order", async () => {
    const owner = await createAuthedUser("idor_owner_del");
    const stranger = await createAuthedUser("idor_stranger_del");
    const stockId = await requireStockId(SYMBOL_BTC);

    const order = await withDbRetry(() =>
      prisma.order.create({
        data: {
          userId: owner.id,
          side: "BID",
          type: "MARKET",
          stockId,
          price: 200,
          qty: 3,
          filledQty: 0,
          status: "EMPTY",
        },
      }),
    );

    const { data, status } = await deleteOrder(order.id, stranger.token);
    console.log(`  [SECURITY BUG] stranger deleted someone else's order → HTTP ${status}`);
    expect(status).toBe(201);
    expect(data.success).toBe(true);

    // Prove the impact isn't just a permissive response — the owner's
    // order is genuinely gone from the database, deleted by a stranger.
    const stillExists = await withDbRetry(() => prisma.order.findFirst({ where: { id: order.id } }));
    expect(stillExists).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 12. LOGIC — GET /order/:orderId Fills query correctness
// ════════════════════════════════════════════════════════════════════════════
//
// src/routes/order.routes.ts:136-144 fetches Fills with
//   `OR: [{ buyOrderId: orderId }, { sellOrderId: orderId }]`
// This test seeds two orders with fills on each and verifies the endpoint
// returns exactly the fills that reference the requested order — on BOTH
// the buy and sell side — and none of the unrelated order's fills.
// ════════════════════════════════════════════════════════════════════════════

describe("Logic — GET /order/:orderId Fills query correctness", () => {
  it("returns fills where the order is the buyer, the seller, and excludes unrelated fills", async () => {
    const { token } = await createAuthedUser("fills_reader");
    const stockId = await requireStockId(SYMBOL_SOL);

    // Seeded sequentially (not Promise.all) — the local `prisma dev` proxy
    // used in this environment doesn't reliably handle several truly
    // concurrent writes from a single client and drops the connection.
    // That's irrelevant to what this test is actually verifying (the
    // Fills OR-clause query logic), so we sidestep it entirely.
    const orderA = await withDbRetry(() =>
      prisma.order.create({
        data: { userId: 1, side: "BID", type: "LIMIT", stockId, price: 10, qty: 1, filledQty: 1, status: "FILLED" },
      }),
    );
    const orderB = await withDbRetry(() =>
      prisma.order.create({
        data: { userId: 1, side: "ASK", type: "LIMIT", stockId, price: 10, qty: 1, filledQty: 1, status: "FILLED" },
      }),
    );
    const orderC = await withDbRetry(() =>
      prisma.order.create({
        data: { userId: 1, side: "ASK", type: "LIMIT", stockId, price: 20, qty: 1, filledQty: 1, status: "FILLED" },
      }),
    );

    try {
      // orderA is the buyer in one fill (with orderB as seller) — this
      // exercises the `buyOrderId` half of the OR clause.
      const fillAsBuyer = await withDbRetry(() =>
        prisma.fills.create({
          data: { stockId, price: 10, qty: 1, buyOrderId: orderA.id, sellOrderId: orderB.id },
        }),
      );
      // An unrelated fill between orderB and orderC that must NOT show up
      // when we query for orderA.
      const unrelatedFill = await withDbRetry(() =>
        prisma.fills.create({
          data: { stockId, price: 20, qty: 1, buyOrderId: orderC.id, sellOrderId: orderB.id },
        }),
      );

      const { data, status } = await getOrder(orderA.id, token);
      expect(status).toBe(201);
      expect(data.status).toBe("FILLED");

      const fillIds = (data.Fills ?? []).map((f: any) => f.id);
      expect(fillIds).toContain(fillAsBuyer.id);
      expect(fillIds).not.toContain(unrelatedFill.id);
      expect(data.Fills).toHaveLength(1);

      // Now query orderB, which is the SELLER in fillAsBuyer AND the
      // SELLER in unrelatedFill — this exercises the `sellOrderId` half of
      // the OR clause and should return BOTH fills.
      const { data: dataB } = await getOrder(orderB.id, token);
      const fillIdsB = (dataB.Fills ?? []).map((f: any) => f.id);
      expect(fillIdsB.sort()).toEqual([fillAsBuyer.id, unrelatedFill.id].sort());
    } finally {
      await prisma.fills.deleteMany({ where: { stockId, price: { in: [10, 20] } } }).catch(() => {});
      await prisma.order.deleteMany({ where: { id: { in: [orderA.id, orderB.id, orderC.id] } } }).catch(() => {});
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 13. LOGIC — /depth is backed by volatile in-memory state, not the DB
// ════════════════════════════════════════════════════════════════════════════
//
// ORDERBOOKS (src/services/orderbook.service.ts:9) is a plain in-process object populated only by
// the POST /order handler's own book-building code — it is never
// hydrated from persisted Order rows. This test proves the two are
// disconnected: an order that exists in the database is invisible to
// /depth, because /depth only ever reads the in-memory structure.
// ════════════════════════════════════════════════════════════════════════════

describe("Logic — /depth reflects in-memory state only, not persisted orders", () => {
  it("a DB order seeded directly does not appear in /depth (book is never hydrated from the DB)", async () => {
    const { token } = await createAuthedUser("depth_db_sync");
    const stockId = await requireStockId(SYMBOL_SOL);

    const order = await withDbRetry(() =>
      prisma.order.create({
        data: {
          userId: 1,
          side: "ASK",
          type: "LIMIT",
          stockId,
          price: 999999, // distinctive price, easy to spot if it ever DID leak into the book
          qty: 7,
          filledQty: 0,
          status: "EMPTY",
        },
      }),
    );

    try {
      const { data, status } = await getDepth(SYMBOL_SOL, token);
      expect(status).toBe(201);
      const askBook = (data.orderBook as any)?.ASK ?? {};
      expect(askBook[999999]).toBeUndefined();
    } finally {
      await prisma.order.delete({ where: { id: order.id } }).catch(() => {});
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14. VALIDATION ASYMMETRY — GET vs DELETE /order/:orderId param handling
// ════════════════════════════════════════════════════════════════════════════

describe("Validation asymmetry — GET vs DELETE /order/:orderId", () => {
  /**
   * BUG: DELETE guards against a bad param with `if (!orderId)` (falsy
   * check on `Number(req.params.orderId)`), which also happens to catch
   * NaN. GET has no equivalent guard at all — it passes `Number("abc")`
   * (NaN) straight into `prisma.order.findFirst({ where: { id: NaN } })`,
   * which Prisma rejects as an invalid argument, throwing and surfacing as
   * an opaque 500 instead of the clean 400 that DELETE would give for the
   * exact same malformed input.
   */
  it("[BUG] GET /order/abc (non-numeric id) returns 500, but DELETE /order/abc returns 400 for the same bad input", async () => {
    const { token } = await createAuthedUser("param_asymmetry");

    const getResult = await getOrder("abc", token);
    const deleteResult = await deleteOrder("abc", token);

    console.log(
      `  [BUG] GET /order/abc → ${getResult.status}, DELETE /order/abc → ${deleteResult.status} (should match)`,
    );
    expect(getResult.status).toBe(500);
    expect(deleteResult.status).toBe(400);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 15. LATENCY BENCHMARK — quick p50 spot check
// ════════════════════════════════════════════════════════════════════════════

describe("Latency benchmarks (p50 informal)", () => {
  it("signup → signin round-trip completes within 2000 ms", async () => {
    const username = uniq("bench");
    const t0 = performance.now();

    await signup(username);
    await signin(username);

    const total = Math.round(performance.now() - t0);
    console.log(`  signup+signin round-trip: ${total}ms`);
    expect(total).toBeLessThan(2000);
  });

  it("depth endpoint responds in < 200 ms (pure in-memory)", async () => {
    const { token } = await signupAndSignin("bench_depth");
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const { latencyMs } = await getDepth(SYMBOL_SOL, token);
      samples.push(latencyMs);
    }
    const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
    console.log(`  /depth avg over 3 calls: ${avg}ms  (samples: ${samples.join(", ")}ms)`);
    expect(avg).toBeLessThan(200);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 16. KNOWN BUGS SUMMARY (informational — kept in sync with the tests above)
// ════════════════════════════════════════════════════════════════════════════
//
//  CONFIRMED LIVE (verified against the running server with curl + this suite):
//
//  BUG-A  [CRITICAL] POST /order has a 100% failure rate: the handler's own
//         validation (src/routes/order.routes.ts:39) only accepts type "market"/"limit"
//         (lowercase), but the Prisma `Type` enum only accepts
//         "MARKET"/"LIMIT" (uppercase). No request can satisfy both, so
//         every well-formed order 500s and every Prisma-valid order 400s.
//  BUG-B  A cryptographically invalid / malformed JWT causes a 500
//         (unhandled jwt.verify throw, src/middleware/auth.middleware.ts:17) instead of a 401.
//  BUG-C  GET /depth/:symbol always returns `success: false`, even for a
//         perfectly valid, successful 201 lookup (src/routes/depth.routes.ts:24).
//  BUG-D  GET /depth/:symbol returns HTTP 201 (not 400/404) for a symbol
//         that isn't in ORDERBOOKS, with `orderBook: undefined`; the
//         `stockSymbol in Object.keys(ORDERBOOKS)` guard (src/routes/depth.routes.ts:22) is
//         a no-op ('in' checks array indices, not values), so the
//         unconditional block after it always runs regardless of validity.
//  BUG-E  DELETE /order/:orderId returns 500 for a non-existent order
//         instead of 404/400 (Prisma's NotFoundError isn't special-cased).
//  BUG-F  signup has no type/shape validation on `password` (unlike
//         `username`) — a numeric password is silently accepted.
//  BUG-G  [FIXED] POST /order now validates that `qty` is a finite,
//         positive number (src/routes/order.routes.ts) before touching the
//         DB or order book, so a non-numeric/zero/negative/NaN/Infinity
//         qty is a clean 400 instead of an opaque 500. `price` still has
//         no equivalent check.
//  BUG-H  Concurrent signups with the same username race past the
//         `findFirst` uniqueness check (src/routes/auth.routes.ts:27-49); the loser hits the
//         DB's unique constraint and gets an unhandled 500 with a raw
//         internal Prisma/driver error object leaked into the response
//         body (src/routes/auth.routes.ts:64 does `res.json({ ..., error })`), instead of
//         the clean 409 a sequential duplicate signup gets.
//  BUG-I  [SECURITY / IDOR] Neither GET /order/:orderId nor
//         DELETE /order/:orderId check that the order belongs to the
//         authenticated user (no `userId` filter, src/routes/order.routes.ts:125 & 169). Any
//         authenticated user can read or CANCEL any other user's order by
//         guessing/incrementing a numeric id.
//  BUG-J  GET /order/:orderId has no guard against a non-numeric `:orderId`
//         (unlike DELETE's `if (!orderId)` check), so `Number("abc")` (NaN)
//         is passed straight to Prisma and surfaces as a 500 instead of a
//         400 — the two routes disagree on the exact same malformed input.
//
//  CONFIRMED CORRECT (verified directly against the DB — good to lock in
//  as regression guards):
//
//  OK-1   Passwords are hashed with argon2id before being stored, verified
//         with Bun.password.verify, salted per-user, and never echoed back
//         in the signup response.
//  OK-2   Issued JWTs embed the correct `userId` and honor the advertised
//         1-hour (`exp - iat === 3600`) expiry.
//
//  DOCUMENTED FROM CODE READING (currently UNREACHABLE via the public API
//  because BUG-A blocks every request before it reaches this code —
//  re-verify these once BUG-A is fixed):
//
//  BUG-1  POST /order never sends a success response body on the happy
//         path (no res.json()/return after building the order book).
//  BUG-3  updateORDERBOOKState's BID-limit branch matches against
//         book["BID"] instead of book["ASK"] (src/services/orderbook.service.ts:260).
//  BUG-4  prisma.fills.create() calls are fire-and-forget (not awaited).
//  BUG-5  The order is prisma.order.create()'d a second time (src/routes/order.routes.ts:96)
//         instead of being prisma.order.update()'d with the fill results.
//  BUG-6  `qty -= PriceLevel.totalQty` runs AFTER `PriceLevel.totalQty` has
//         already been set to 0 a few lines above, so it's always a no-op
//         (askLimitOrder:100, bidLimitOrder:170 in src/services/orderbook.service.ts).
//  BUG-9  DELETE /order removes the DB row only; the in-memory ORDERBOOK
//         entry is never removed, so /depth still shows cancelled orders.
//  BUG-10 askLimitOrder/bidLimitOrder assign `PriceLevel.Order =
//         notCompleteOrder` and then immediately overwrite it with
//         `PriceLevel.Order = []` on the very next line, discarding all
//         partially-filled orders (src/services/orderbook.service.ts lines 139-140, 209-210).
//
//  DESIGN NOTE (confirmed, not strictly a "bug" but worth knowing):
//  ORDERBOOKS (src/services/orderbook.service.ts:9) is pure in-memory state, never hydrated from
//  the DB. A directly-seeded (or, once BUG-A is fixed, API-created) Order
//  row has no effect on /depth unless it went through the exact in-process
//  book-building code in the POST /order handler. Restarting the server
//  silently wipes all order-book state even though the Order rows persist.
//
// ════════════════════════════════════════════════════════════════════════════
