var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// api/[[route]].js
var EUR_RATE = 0.9;
var schemaInitialized = false;
var PROMO_CODES = {
  PETLOVE15: { type: "pet_percent", value: 0.15, label: "15% Off Pet Care" },
  TITAN10: { type: "all_percent", value: 0.1, label: "10% Off Storewide" },
  WELCOME5: { type: "fixed_usd", value: 5, minUsd: 25, label: "$5.00 Off ($25+)" }
};
function encodeUtf8B64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
__name(encodeUtf8B64, "encodeUtf8B64");
function decodeUtf8B64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
__name(decodeUtf8B64, "decodeUtf8B64");
function getSecret(env) {
  return env.JWT_SECRET || "SHOPITY_FALLBACK_DEV_SECRET_2026";
}
__name(getSecret, "getSecret");
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
  const sig = Array.from(new Uint8Array(sigBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${data}.${sig}`;
}
__name(signToken, "signToken");
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
  const expectedSig = Array.from(new Uint8Array(expectedBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (sig !== expectedSig) return null;
  const payload = JSON.parse(decodeUtf8B64(data));
  if (payload.exp && Date.now() > payload.exp) return null;
  return payload;
}
__name(verifyToken, "verifyToken");
async function hashWithSalt(password, email, salt) {
  const raw = new TextEncoder().encode(`${email.toLowerCase().trim()}:${password}:${salt}`);
  const buf = await crypto.subtle.digest("SHA-256", raw);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hashWithSalt, "hashWithSalt");
async function hashPassword(password, email) {
  return hashWithSalt(password, email, "SHOPITY_APLUS_SALT_2026");
}
__name(hashPassword, "hashPassword");
async function verifyPassword(password, email, storedHash) {
  const h1 = await hashWithSalt(password, email, "SHOPITY_APLUS_SALT_2026");
  if (h1 === storedHash) return true;
  const h2 = await hashWithSalt(password, email, "SHOPITY_D1_SALT_2026");
  return h2 === storedHash;
}
__name(verifyPassword, "verifyPassword");
function isStrongPassword(pwd) {
  return pwd.length >= 10 && /[A-Z]/.test(pwd) && /[a-z]/.test(pwd) && /[0-9]/.test(pwd) && /[^A-Za-z0-9]/.test(pwd);
}
__name(isStrongPassword, "isStrongPassword");
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
    } catch (_) {
    }
  }
  schemaInitialized = true;
}
__name(ensureSchema, "ensureSchema");
async function logSiem(db, level, message) {
  try {
    const ts = (/* @__PURE__ */ new Date()).toISOString().replace("T", " ").slice(0, 19);
    await db.prepare("INSERT INTO siem_logs (level, message, created_at) VALUES (?, ?, ?)").bind(level, message, ts).run();
  } catch (_) {
  }
}
__name(logSiem, "logSiem");
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
__name(json, "json");
async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (!env.DB) {
    return json({ error: "D1 database binding (DB) not configured in wrangler.toml" }, 500);
  }
  try {
    await ensureSchema(env.DB);
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
      const role = countRow && Number(countRow.cnt) === 0 ? "admin" : "user";
      const passHash = await hashPassword(password, email);
      const res = await env.DB.prepare(
        "INSERT INTO users (name, email, pass_hash, role, wallet_usd, failed_attempts, lock_until) VALUES (?, ?, ?, ?, 25.0, 0, 0)"
      ).bind(name, email, passHash, role).run();
      const uid = res.meta?.last_row_id || Date.now();
      const userObj = { uid, name, email, role, walletUsd: 25 };
      const token = await signToken({ uid, name, email, role, exp: Date.now() + 24 * 3600 * 1e3 }, env);
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
        const rem = Math.ceil((Number(userRow.lock_until) - now) / 1e3);
        return json({ error: `Brute-Force Shield: Locked for ${rem}s` }, 429);
      }
      const valid = await verifyPassword(password, email, userRow.pass_hash);
      if (!valid) {
        const fails = Number(userRow.failed_attempts || 0) + 1;
        const lockUntil = fails >= 5 ? now + 6e4 : 0;
        await env.DB.prepare("UPDATE users SET failed_attempts = ?, lock_until = ? WHERE id = ?").bind(fails >= 5 ? 0 : fails, lockUntil, userRow.id).run();
        await logSiem(env.DB, fails >= 5 ? "BLOCK" : "WARN", `Failed login (${fails}/5) for ${email}`);
        return json({ error: fails >= 5 ? "5 failed attempts: Locked for 60s" : "Invalid email or password" }, 401);
      }
      await env.DB.prepare("UPDATE users SET failed_attempts = 0, lock_until = 0 WHERE id = ?").bind(userRow.id).run();
      const walletUsd = Number(userRow.wallet_usd ?? 25);
      const userObj = { uid: userRow.id, name: userRow.name, email: userRow.email, role: userRow.role, walletUsd };
      const token = await signToken({ uid: userRow.id, name: userRow.name, email: userRow.email, role: userRow.role, exp: now + 24 * 3600 * 1e3 }, env);
      await logSiem(env.DB, "PASS", `Authenticated login: ${email}`);
      return json({ ok: true, token, user: userObj });
    }
    if (path === "/api/orders" && method === "GET") {
      const user = await verifyToken(request.headers.get("Authorization"), env);
      if (!user) return json({ error: "Authentication required" }, 401);
      const stmt = user.role === "admin" ? env.DB.prepare("SELECT * FROM orders ORDER BY id DESC") : env.DB.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC").bind(user.uid);
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
      const petCats = /* @__PURE__ */ new Set(["Feeding", "Grooming", "Toys", "Pet Care"]);
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
      let afterPrimeUsd = subtotalUsd * (isPrime ? 0.9 : 1);
      let promoDiscountUsd = 0;
      const promo = PROMO_CODES[promoCode];
      if (promo) {
        if (promo.type === "pet_percent") promoDiscountUsd = petSubtotalUsd * promo.value;
        else if (promo.type === "all_percent") promoDiscountUsd = afterPrimeUsd * promo.value;
        else if (promo.type === "fixed_usd" && afterPrimeUsd >= promo.minUsd) promoDiscountUsd = promo.value;
      }
      const afterPromoUsd = Math.max(0, afterPrimeUsd - promoDiscountUsd);
      const dbUser = await env.DB.prepare("SELECT wallet_usd FROM users WHERE id = ?").bind(user.uid).first();
      const currentWallet = Number(dbUser?.wallet_usd ?? 25);
      const walletUsed = useWallet ? Math.min(currentWallet, afterPromoUsd) : 0;
      const finalUsd = Number(Math.max(0, afterPromoUsd - walletUsed).toFixed(2));
      const finalEur = Number((finalUsd * EUR_RATE).toFixed(2));
      const cashbackEarned = Number((finalUsd * 0.05).toFixed(2));
      const newWallet = Number((currentWallet - walletUsed + cashbackEarned).toFixed(2));
      const orderCode = "SHP-" + Math.floor(1e4 + Math.random() * 9e4);
      const createdAt = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
      for (const upd of stockUpdates) {
        await env.DB.prepare("UPDATE products SET stock = stock - ? WHERE id = ?").bind(upd.qty, upd.id).run();
      }
      await env.DB.prepare("UPDATE users SET wallet_usd = ? WHERE id = ?").bind(newWallet, user.uid).run();
      await env.DB.prepare(
        "INSERT INTO orders (order_code, user_id, customer_name, customer_email, total_usd, total_eur, items_summary, gateway, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        orderCode,
        user.uid,
        user.name,
        user.email,
        finalUsd,
        finalEur,
        summaryList.join(", "),
        gateway,
        "Verified & Dispatched",
        createdAt
      ).run();
      await logSiem(env.DB, "PASS", `Order ${orderCode} ($${finalUsd} / \u20AC${finalEur}) verified`);
      return json({ ok: true, orderCode, totalUsd: finalUsd, totalEur: finalEur, newWallet, cashbackEarned });
    }
    if (path === "/api/orders" && method === "PATCH") {
      const user = await verifyToken(request.headers.get("Authorization"), env);
      if (!user || user.role !== "admin") return json({ error: "Unauthorized" }, 403);
      const body = await request.json();
      const id = parseInt(body.id, 10);
      const status = String(body.status || "Delivered \u2705").trim();
      await env.DB.prepare("UPDATE orders SET status = ? WHERE id = ?").bind(status, id).run();
      return json({ ok: true });
    }
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
__name(onRequest, "onRequest");

// ../.wrangler/tmp/pages-sJKo63/functionsRoutes-0.2808567172721751.mjs
var routes = [
  {
    routePath: "/api/:route*",
    mountPath: "/api",
    method: "",
    middlewares: [],
    modules: [onRequest]
  }
];

// ../../../AppData/Roaming/npm-cache/_npx/32026684e21afda6/node_modules/path-to-regexp/dist.es2015/index.js
function lexer(str) {
  var tokens = [];
  var i = 0;
  while (i < str.length) {
    var char = str[i];
    if (char === "*" || char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }
    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }
    if (char === ":") {
      var name = "";
      var j = i + 1;
      while (j < str.length) {
        var code = str.charCodeAt(j);
        if (
          // `0-9`
          code >= 48 && code <= 57 || // `A-Z`
          code >= 65 && code <= 90 || // `a-z`
          code >= 97 && code <= 122 || // `_`
          code === 95
        ) {
          name += str[j++];
          continue;
        }
        break;
      }
      if (!name)
        throw new TypeError("Missing parameter name at ".concat(i));
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (char === "(") {
      var count = 1;
      var pattern = "";
      var j = i + 1;
      if (str[j] === "?") {
        throw new TypeError('Pattern cannot start with "?" at '.concat(j));
      }
      while (j < str.length) {
        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }
        if (str[j] === ")") {
          count--;
          if (count === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count++;
          if (str[j + 1] !== "?") {
            throw new TypeError("Capturing groups are not allowed at ".concat(j));
          }
        }
        pattern += str[j++];
      }
      if (count)
        throw new TypeError("Unbalanced pattern at ".concat(i));
      if (!pattern)
        throw new TypeError("Missing pattern at ".concat(i));
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}
__name(lexer, "lexer");
function parse(str, options) {
  if (options === void 0) {
    options = {};
  }
  var tokens = lexer(str);
  var _a = options.prefixes, prefixes = _a === void 0 ? "./" : _a, _b = options.delimiter, delimiter = _b === void 0 ? "/#?" : _b;
  var result = [];
  var key = 0;
  var i = 0;
  var path = "";
  var tryConsume = /* @__PURE__ */ __name(function(type) {
    if (i < tokens.length && tokens[i].type === type)
      return tokens[i++].value;
  }, "tryConsume");
  var mustConsume = /* @__PURE__ */ __name(function(type) {
    var value2 = tryConsume(type);
    if (value2 !== void 0)
      return value2;
    var _a2 = tokens[i], nextType = _a2.type, index = _a2.index;
    throw new TypeError("Unexpected ".concat(nextType, " at ").concat(index, ", expected ").concat(type));
  }, "mustConsume");
  var consumeText = /* @__PURE__ */ __name(function() {
    var result2 = "";
    var value2;
    while (value2 = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR")) {
      result2 += value2;
    }
    return result2;
  }, "consumeText");
  var isSafe = /* @__PURE__ */ __name(function(value2) {
    for (var _i = 0, delimiter_1 = delimiter; _i < delimiter_1.length; _i++) {
      var char2 = delimiter_1[_i];
      if (value2.indexOf(char2) > -1)
        return true;
    }
    return false;
  }, "isSafe");
  var safePattern = /* @__PURE__ */ __name(function(prefix2) {
    var prev = result[result.length - 1];
    var prevText = prefix2 || (prev && typeof prev === "string" ? prev : "");
    if (prev && !prevText) {
      throw new TypeError('Must have text between two parameters, missing text after "'.concat(prev.name, '"'));
    }
    if (!prevText || isSafe(prevText))
      return "[^".concat(escapeString(delimiter), "]+?");
    return "(?:(?!".concat(escapeString(prevText), ")[^").concat(escapeString(delimiter), "])+?");
  }, "safePattern");
  while (i < tokens.length) {
    var char = tryConsume("CHAR");
    var name = tryConsume("NAME");
    var pattern = tryConsume("PATTERN");
    if (name || pattern) {
      var prefix = char || "";
      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name || key++,
        prefix,
        suffix: "",
        pattern: pattern || safePattern(prefix),
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    var value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    var open = tryConsume("OPEN");
    if (open) {
      var prefix = consumeText();
      var name_1 = tryConsume("NAME") || "";
      var pattern_1 = tryConsume("PATTERN") || "";
      var suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: name_1 || (pattern_1 ? key++ : ""),
        pattern: name_1 && !pattern_1 ? safePattern(prefix) : pattern_1,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    mustConsume("END");
  }
  return result;
}
__name(parse, "parse");
function match(str, options) {
  var keys = [];
  var re = pathToRegexp(str, keys, options);
  return regexpToFunction(re, keys, options);
}
__name(match, "match");
function regexpToFunction(re, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.decode, decode = _a === void 0 ? function(x) {
    return x;
  } : _a;
  return function(pathname) {
    var m = re.exec(pathname);
    if (!m)
      return false;
    var path = m[0], index = m.index;
    var params = /* @__PURE__ */ Object.create(null);
    var _loop_1 = /* @__PURE__ */ __name(function(i2) {
      if (m[i2] === void 0)
        return "continue";
      var key = keys[i2 - 1];
      if (key.modifier === "*" || key.modifier === "+") {
        params[key.name] = m[i2].split(key.prefix + key.suffix).map(function(value) {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i2], key);
      }
    }, "_loop_1");
    for (var i = 1; i < m.length; i++) {
      _loop_1(i);
    }
    return { path, index, params };
  };
}
__name(regexpToFunction, "regexpToFunction");
function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}
__name(escapeString, "escapeString");
function flags(options) {
  return options && options.sensitive ? "" : "i";
}
__name(flags, "flags");
function regexpToRegexp(path, keys) {
  if (!keys)
    return path;
  var groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;
  var index = 0;
  var execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: ""
    });
    execResult = groupsRegex.exec(path.source);
  }
  return path;
}
__name(regexpToRegexp, "regexpToRegexp");
function arrayToRegexp(paths, keys, options) {
  var parts = paths.map(function(path) {
    return pathToRegexp(path, keys, options).source;
  });
  return new RegExp("(?:".concat(parts.join("|"), ")"), flags(options));
}
__name(arrayToRegexp, "arrayToRegexp");
function stringToRegexp(path, keys, options) {
  return tokensToRegexp(parse(path, options), keys, options);
}
__name(stringToRegexp, "stringToRegexp");
function tokensToRegexp(tokens, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.strict, strict = _a === void 0 ? false : _a, _b = options.start, start = _b === void 0 ? true : _b, _c = options.end, end = _c === void 0 ? true : _c, _d = options.encode, encode = _d === void 0 ? function(x) {
    return x;
  } : _d, _e = options.delimiter, delimiter = _e === void 0 ? "/#?" : _e, _f = options.endsWith, endsWith = _f === void 0 ? "" : _f;
  var endsWithRe = "[".concat(escapeString(endsWith), "]|$");
  var delimiterRe = "[".concat(escapeString(delimiter), "]");
  var route = start ? "^" : "";
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    if (typeof token === "string") {
      route += escapeString(encode(token));
    } else {
      var prefix = escapeString(encode(token.prefix));
      var suffix = escapeString(encode(token.suffix));
      if (token.pattern) {
        if (keys)
          keys.push(token);
        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            var mod = token.modifier === "*" ? "?" : "";
            route += "(?:".concat(prefix, "((?:").concat(token.pattern, ")(?:").concat(suffix).concat(prefix, "(?:").concat(token.pattern, "))*)").concat(suffix, ")").concat(mod);
          } else {
            route += "(?:".concat(prefix, "(").concat(token.pattern, ")").concat(suffix, ")").concat(token.modifier);
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            throw new TypeError('Can not repeat "'.concat(token.name, '" without a prefix and suffix'));
          }
          route += "(".concat(token.pattern, ")").concat(token.modifier);
        }
      } else {
        route += "(?:".concat(prefix).concat(suffix, ")").concat(token.modifier);
      }
    }
  }
  if (end) {
    if (!strict)
      route += "".concat(delimiterRe, "?");
    route += !options.endsWith ? "$" : "(?=".concat(endsWithRe, ")");
  } else {
    var endToken = tokens[tokens.length - 1];
    var isEndDelimited = typeof endToken === "string" ? delimiterRe.indexOf(endToken[endToken.length - 1]) > -1 : endToken === void 0;
    if (!strict) {
      route += "(?:".concat(delimiterRe, "(?=").concat(endsWithRe, "))?");
    }
    if (!isEndDelimited) {
      route += "(?=".concat(delimiterRe, "|").concat(endsWithRe, ")");
    }
  }
  return new RegExp(route, flags(options));
}
__name(tokensToRegexp, "tokensToRegexp");
function pathToRegexp(path, keys, options) {
  if (path instanceof RegExp)
    return regexpToRegexp(path, keys);
  if (Array.isArray(path))
    return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
__name(pathToRegexp, "pathToRegexp");

// ../../../AppData/Roaming/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/pages-template-worker.ts
var escapeRegex = /[.+?^${}()|[\]\\]/g;
function getOriginalPathPrefix(requestPath, normalizedPrefix) {
  let end = 0;
  for (let index = 0; index < normalizedPrefix.length; index++) {
    end++;
    if (normalizedPrefix[index] === "/") {
      while (requestPath[end] === "/") {
        end++;
      }
    }
  }
  return requestPath.slice(0, end);
}
__name(getOriginalPathPrefix, "getOriginalPathPrefix");
function* executeRequest(request) {
  const requestPath = new URL(request.url).pathname;
  const normalizedRequestPath = requestPath.replace(/\/+/g, "/");
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath) || routeMatcher(normalizedRequestPath);
    const originalMountMatch = mountMatcher(requestPath);
    const mountMatchResult = originalMountMatch || mountMatcher(normalizedRequestPath);
    if (matchResult && mountMatchResult) {
      const path = originalMountMatch ? originalMountMatch.path : getOriginalPathPrefix(requestPath, mountMatchResult.path);
      for (const handler of route.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path
        };
      }
    }
  }
  for (const route of routes) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: true
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult && route.modules.length) {
      for (const handler of route.modules.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: matchResult.path
        };
      }
      break;
    }
  }
}
__name(executeRequest, "executeRequest");
var pages_template_worker_default = {
  async fetch(originalRequest, env, workerContext) {
    let request = originalRequest;
    const handlerIterator = executeRequest(request);
    let data = {};
    let isFailOpen = false;
    const next = /* @__PURE__ */ __name(async (input, init) => {
      if (input !== void 0) {
        let url = input;
        if (typeof input === "string") {
          url = new URL(input, request.url).toString();
        }
        request = new Request(url, init);
      }
      const result = handlerIterator.next();
      if (result.done === false) {
        const { handler, params, path } = result.value;
        const context = {
          request: new Request(request.clone()),
          functionPath: path,
          next,
          params,
          get data() {
            return data;
          },
          set data(value) {
            if (typeof value !== "object" || value === null) {
              throw new Error("context.data must be an object");
            }
            data = value;
          },
          env,
          waitUntil: workerContext.waitUntil.bind(workerContext),
          passThroughOnException: /* @__PURE__ */ __name(() => {
            isFailOpen = true;
          }, "passThroughOnException")
        };
        const response = await handler(context);
        if (!(response instanceof Response)) {
          throw new Error("Your Pages function should return a Response");
        }
        return cloneResponse(response);
      } else if ("ASSETS") {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      } else {
        const response = await fetch(request);
        return cloneResponse(response);
      }
    }, "next");
    try {
      return await next();
    } catch (error) {
      if (isFailOpen) {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      }
      throw error;
    }
  }
};
var cloneResponse = /* @__PURE__ */ __name((response) => (
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response(
    [101, 204, 205, 304].includes(response.status) ? null : response.body,
    response
  )
), "cloneResponse");
export {
  pages_template_worker_default as default
};
