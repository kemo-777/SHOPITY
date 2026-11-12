const EUR_RATE = 0.90;
let schemaInitialized = false;

const PROMO_CODES = {
  PETLOVE15: { type: "pet_percent", value: 0.15, label: "15% Off Pet Care" },
  TITAN10: { type: "all_percent", value: 0.10, label: "10% Off Storewide" },
  WELCOME5: { type: "fixed_usd", value: 5.00, minUsd: 25.00, label: "$5.00 Off ($25+)" }
};

function encodeUtf8B64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function decodeUtf8B64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function getSecret(env) {
  return env.JWT_SECRET || "SHOPITY_FALLBACK_DEV_SECRET_2026";
}

async function signToken(payload, env) {
  const data = encodeUtf8B64(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getSecret(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const sig = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
  return `${data}.${sig}`;
}

async function verifyToken(authHeader, env) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [data, sig] = parts;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getSecret(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expectedBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const expectedSig = Array.from(new Uint8Array(expectedBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
  if (sig !== expectedSig) return null;

  const payload = JSON.parse(decodeUtf8B64(data));
  if (payload.exp && Date.now() > payload.exp) return null;
  return payload;
}

async function hashWithSalt(password, email, salt) {
  const raw = new TextEncoder().encode(`${email.toLowerCase().trim()}:${password}:${salt}`);
  const buf = await crypto.subtle.digest("SHA-256", raw);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, email) {
  return hashWithSalt(password, email, "SHOPITY_APLUS_SALT_2026");
}

async function verifyPassword(password, email, storedHash) {
  const h1 = await hashWithSalt(password, email, "SHOPITY_APLUS_SALT_2026");
  if (h1 === storedHash) return true;
  const h2 = await hashWithSalt(password, email, "SHOPITY_D1_SALT_2026");
  return h2 === storedHash;
}

function isStrongPassword(pwd) {
  return (
    pwd.length >= 10 &&
    /[A-Z]/.test(pwd) &&
    /[a-z]/.test(pwd) &&
    /[0-9]/.test(pwd) &&
    /[^A-Za-z0-9]/.test(pwd)
  );
}

async function ensureSchema(db) {
  if (schemaInitialized) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      pass_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      wallet_usd REAL NOT NULL DEFAULT 25.0,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      lock_until INTEGER NOT NULL DEFAULT 0
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      usd REAL NOT NULL,
      stock INTEGER NOT NULL DEFAULT 10,
      rocket INTEGER NOT NULL DEFAULT 1,
      specs TEXT,
      img TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_code TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      total_usd REAL NOT NULL,
      total_eur REAL NOT NULL,
      items_summary TEXT NOT NULL,
      gateway TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS siem_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`)
  ]);

  for (const sql of [
    "ALTER TABLE users ADD COLUMN wallet_usd REAL NOT NULL DEFAULT 25.0",
    "ALTER TABLE users ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN lock_until INTEGER NOT NULL DEFAULT 0"
  ]) {
    try {
      await db.prepare(sql).run();
    } catch (_) {}
  }
  schemaInitialized = true;
}

async function logSiem(db, level, message) {
  try {
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    await db.prepare("INSERT INTO siem_logs (level, message, created_at) VALUES (?, ?, ?)").bind(level, message, ts).run();
  } catch (_) {}
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store"
    }
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (!env.DB) {
    return json({ error: "D1 database binding (DB) not configured in wrangler.toml" }, 500);
  }

  try {
    await ensureSchema(env.DB);

    // 1. PRODUCTS ENDPOINTS
    if (path === "/api/products" && method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM products ORDER BY id DESC").all();
      return json({ products: results || [], eurRate: EUR_RATE });
    }

    if (path === "/api/products" && method === "POST") {
      const user = await verifyToken(request.headers.get("Authorization"), env);
      if (!user || user.role !== "admin") {
        await logSiem(env.DB, "BLOCK", "Unauthorized product creation attempt");
        return json({ error: "Unauthorized: Verified Admin required" }, 403);
      }

      const body = await request.json();
      const name = String(body.name || "").trim();
      const category = String(body.category || "Feeding").trim();
      const usd = Number(body.usd);
      const stock = parseInt(body.stock, 10) || 10;
      const rocket = body.rocket ? 1 : 0;
      const specs = String(body.specs || "Official Global Edition").trim();
      const img = String(body.img || "").trim();
      const safeImg = img.startsWith("https://") ? img : "";

      if (!name || isNaN(usd) || usd <= 0 || stock < 0) {
        return json({ error: "Invalid product name, price, or stock" }, 400);
      }

      await env.DB.prepare(
        "INSERT INTO products (name, category, usd, stock, rocket, specs, img) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(name, category, Number(usd.toFixed(2)), stock, rocket, specs, safeImg).run();

      await logSiem(env.DB, "PASS", `Admin published: ${name} ($${usd.toFixed(2)})`);
      return json({ ok: true });
    }

    if (path === "/api/products" && method === "PATCH") {
      const user = await verifyToken(request.headers.get("Authorization"), env);
      if (!user || user.role !== "admin") return json({ error: "Unauthorized" }, 403);

      const body = await request.json();
      const id = parseInt(body.id, 10);
      const addStock = parseInt(body.addStock, 10) || 10;
      await env.DB.prepare("UPDATE products SET stock = stock + ? WHERE id = ?").bind(addStock, id).run();
      await logSiem(env.DB, "INFO", `Admin restocked product #${id} (+${addStock})`);
      return json({ ok: true });
    }

    if (path === "/api/products" && method === "DELETE") {
      const user = await verifyToken(request.headers.get("Authorization"), env);
      if (!user || user.role !== "admin") return json({ error: "Unauthorized" }, 403);

      const id = parseInt(url.searchParams.get("id"), 10);
      await env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id).run();
      await logSiem(env.DB, "WARN", `Admin deleted product #${id}`);
      return json({ ok: true });
    }

    // 2. AUTHENTICATION & BRUTE-FORCE SHIELD
    if (path === "/api/auth/signup" && method === "POST") {
      const body = await request.json();
      const name = String(body.name || "").trim();
      const email = String(body.email || "").toLowerCase().trim();
      const password = String(body.password || "");

      if (!name || !email.includes("@")) {
        return json({ error: "Valid full name and email required" }, 400);
      }
      if (!isStrongPassword(password)) {
        return json({ error: "A+ Policy: Password must be 10+ chars with Upper, Lower, Number & Symbol" }, 400);
      }

      const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
      if (existing) return json({ error: "Email already registered" }, 409);

      const countRow = await env.DB.prepare("SELECT COUNT(*) as cnt FROM users").first();
      const role = (countRow && Number(countRow.cnt) === 0) ? "admin" : "user";
      const passHash = await hashPassword(password, email);

      const res = await env.DB.prepare(
        "INSERT INTO users (name, email, pass_hash, role, wallet_usd, failed_attempts, lock_until) VALUES (?, ?, ?, ?, 25.0, 0, 0)"
      ).bind(name, email, passHash, role).run();

      const uid = res.meta?.last_row_id || Date.now();
      const userObj = { uid, name, email, role, walletUsd: 25.0 };
      const token = await signToken({ uid, name, email, role, exp: Date.now() + 24 * 3600 * 1000 }, env);

      await logSiem(env.DB, "PASS", `New ${role.toUpperCase()} registered: ${email}`);
      return json({ ok: true, token, user: userObj });
    }

    if (path === "/api/auth/login" && method === "POST") {
      const body = await request.json();
      const email = String(body.email || "").toLowerCase().trim();
      const password = String(body.password || "");

      const userRow = await env.DB.prepare(
        "SELECT id, name, email, role, pass_hash, wallet_usd, failed_attempts, lock_until FROM users WHERE email = ?"
      ).bind(email).first();

      if (!userRow) {
        await logSiem(env.DB, "WARN", `Unknown account login attempt: ${email}`);
        return json({ error: "Invalid email or password" }, 401);
      }

      const now = Date.now();
      if (Number(userRow.lock_until) > now) {
        const rem = Math.ceil((Number(userRow.lock_until) - now) / 1000);
        return json({ error: `Brute-Force Shield: Locked for ${rem}s` }, 429);
      }

      const valid = await verifyPassword(password, email, userRow.pass_hash);
      if (!valid) {
        const fails = Number(userRow.failed_attempts || 0) + 1;
        const lockUntil = fails >= 5 ? now + 60000 : 0;
        await env.DB.prepare("UPDATE users SET failed_attempts = ?, lock_until = ? WHERE id = ?")
          .bind(fails >= 5 ? 0 : fails, lockUntil, userRow.id).run();

        await logSiem(env.DB, fails >= 5 ? "BLOCK" : "WARN", `Failed login (${fails}/5) for ${email}`);
        return json({ error: fails >= 5 ? "5 failed attempts: Locked for 60s" : "Invalid email or password" }, 401);
      }

      await env.DB.prepare("UPDATE users SET failed_attempts = 0, lock_until = 0 WHERE id = ?").bind(userRow.id).run();
      const walletUsd = Number(userRow.wallet_usd ?? 25.0);
      const userObj = { uid: userRow.id, name: userRow.name, email: userRow.email, role: userRow.role, walletUsd };
      const token = await signToken({ uid: userRow.id, name: userRow.name, email: userRow.email, role: userRow.role, exp: now + 24 * 3600 * 1000 }, env);

      await logSiem(env.DB, "PASS", `Authenticated login: ${email}`);
      return json({ ok: true, token, user: userObj });
    }

    // 3. SERVER-VERIFIED CHECKOUT, PROMOS & ORDERS
    if (path === "/api/orders" && method === "GET") {
      const user = await verifyToken(request.headers.get("Authorization"), env);
      if (!user) return json({ error: "Authentication required" }, 401);

      const stmt = user.role === "admin"
        ? env.DB.prepare("SELECT * FROM orders ORDER BY id DESC")
        : env.DB.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC").bind(user.uid);

      const { results } = await stmt.all();
      return json({ orders: results || [] });
    }

    if (path === "/api/orders" && method === "POST") {
      const user = await verifyToken(request.headers.get("Authorization"), env);
      if (!user) return json({ error: "Please sign in before checkout" }, 401);

      const body = await request.json();
      const items = Array.isArray(body.items) ? body.items : [];
      const isPrime = Boolean(body.isPrime);
      const useWallet = Boolean(body.useWallet);
      const promoCode = String(body.promoCode || "").toUpperCase().trim();
      const gateway = String(body.gateway || "Stripe Global").trim();

      if (items.length === 0) return json({ error: "Cart is empty" }, 400);

      let subtotalUsd = 0;
      let petSubtotalUsd = 0;
      const petCats = new Set(["Feeding", "Grooming", "Toys", "Pet Care"]);
      const summaryList = [];
      const stockUpdates = [];

      for (const item of items) {
        const prodId = parseInt(item.id, 10);
        const qty = parseInt(item.qty, 10);
        if (!prodId || !qty || qty <= 0) return json({ error: "Invalid item quantity" }, 400);

        const dbProd = await env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(prodId).first();
        if (!dbProd || Number(dbProd.stock) < qty) {
          return json({ error: `Insufficient stock for ${dbProd ? dbProd.name : "item"}` }, 409);
        }

        const lineTotal = Number(dbProd.usd) * qty;
        subtotalUsd += lineTotal;
        if (petCats.has(dbProd.category)) petSubtotalUsd += lineTotal;
        summaryList.push(`${dbProd.name} (x${qty})`);
        stockUpdates.push({ id: prodId, qty });
      }

      let afterPrimeUsd = subtotalUsd * (isPrime ? 0.90 : 1.0);
      let promoDiscountUsd = 0;
      const promo = PROMO_CODES[promoCode];
      if (promo) {
        if (promo.type === "pet_percent") promoDiscountUsd = petSubtotalUsd * promo.value;
        else if (promo.type === "all_percent") promoDiscountUsd = afterPrimeUsd * promo.value;
        else if (promo.type === "fixed_usd" && afterPrimeUsd >= promo.minUsd) promoDiscountUsd = promo.value;
      }

      const afterPromoUsd = Math.max(0, afterPrimeUsd - promoDiscountUsd);
      const dbUser = await env.DB.prepare("SELECT wallet_usd FROM users WHERE id = ?").bind(user.uid).first();
      const currentWallet = Number(dbUser?.wallet_usd ?? 25.0);
      const walletUsed = useWallet ? Math.min(currentWallet, afterPromoUsd) : 0;

      const finalUsd = Number(Math.max(0, afterPromoUsd - walletUsed).toFixed(2));
      const finalEur = Number((finalUsd * EUR_RATE).toFixed(2));
      const cashbackEarned = Number((finalUsd * 0.05).toFixed(2));
      const newWallet = Number((currentWallet - walletUsed + cashbackEarned).toFixed(2));

      const orderCode = "SHP-" + Math.floor(10000 + Math.random() * 90000);
      const createdAt = new Date().toISOString().split("T")[0];

      for (const upd of stockUpdates) {
        await env.DB.prepare("UPDATE products SET stock = stock - ? WHERE id = ?").bind(upd.qty, upd.id).run();
      }

      await env.DB.prepare("UPDATE users SET wallet_usd = ? WHERE id = ?").bind(newWallet, user.uid).run();

      await env.DB.prepare(
        "INSERT INTO orders (order_code, user_id, customer_name, customer_email, total_usd, total_eur, items_summary, gateway, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        orderCode, user.uid, user.name, user.email, finalUsd, finalEur, summaryList.join(", "), gateway, "Verified & Dispatched", createdAt
      ).run();

      await logSiem(env.DB, "PASS", `Order ${orderCode} ($${finalUsd} / €${finalEur}) verified`);
      return json({ ok: true, orderCode, totalUsd: finalUsd, totalEur: finalEur, newWallet, cashbackEarned });
    }

    if (path === "/api/orders" && method === "PATCH") {
      const user = await verifyToken(request.headers.get("Authorization"), env);
      if (!user || user.role !== "admin") return json({ error: "Unauthorized" }, 403);

      const body = await request.json();
      const id = parseInt(body.id, 10);
      const status = String(body.status || "Delivered ✅").trim();
      await env.DB.prepare("UPDATE orders SET status = ? WHERE id = ?").bind(status, id).run();
      return json({ ok: true });
    }

    // 4. SIEM LOGS & ADMIN ANALYTICS
    if (path === "/api/siem" && method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM siem_logs ORDER BY id DESC LIMIT 40").all();
      return json({ logs: results || [] });
    }

    if (path === "/api/stats" && method === "GET") {
      const user = await verifyToken(request.headers.get("Authorization"), env);
      if (!user || user.role !== "admin") return json({ error: "Unauthorized" }, 403);

      const rev = await env.DB.prepare("SELECT COALESCE(SUM(total_usd), 0) as usd, COUNT(*) as orders FROM orders").first();
      const prod = await env.DB.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN stock <= 5 THEN 1 ELSE 0 END) as low FROM products").first();
      const usr = await env.DB.prepare("SELECT COUNT(*) as total FROM users").first();

      return json({
        revenueUsd: Number(rev?.usd || 0),
        revenueEur: Number((Number(rev?.usd || 0) * EUR_RATE).toFixed(2)),
        totalOrders: Number(rev?.orders || 0),
        totalProducts: Number(prod?.total || 0),
        lowStockCount: Number(prod?.low || 0),
        totalUsers: Number(usr?.total || 0)
      });
    }

    return json({ error: "Endpoint not found" }, 404);
  } catch (err) {
    return json({ error: err.message || "Internal server error" }, 500);
  }
}
