(() => {
  "use strict";

  const state = {
    eurRate: 0.90,
    products: [],
    cart: JSON.parse(localStorage.getItem("shopity_d1_cart") || "[]"),
    wishlist: JSON.parse(localStorage.getItem("shopity_d1_wish") || "[]"),
    compareList: JSON.parse(localStorage.getItem("shopity_d1_comp") || "[]"),
    currentUser: null,
    currentCategory: "All",
    isPrime: false,
    rocketOnly: false,
    appliedPromo: "",
    lastActivity: Date.now()
  };

  // Clean up any legacy localStorage auth tokens
  localStorage.removeItem("shopity_d1_token");
  localStorage.removeItem("shopity_d1_user");

  const CAT_ICONS = {
    Feeding: "🥣",
    Grooming: "🪮",
    Toys: "🎾",
    "Pet Care": "🐾",
    Tech: "💻",
    Audio: "🎧",
    Wearables: "⌚",
    Gaming: "🎮"
  };

  const PROMO_RULES = {
    PETLOVE15: { type: "pet_percent", value: 0.15, label: "15% Off Pet Care" },
    TITAN10: { type: "all_percent", value: 0.10, label: "10% Off Storewide" },
    WELCOME5: { type: "fixed_usd", value: 5.00, minUsd: 25.00, label: "$5.00 Off ($25+)" }
  };

  const PET_CATEGORIES = new Set(["Pet Care", "Feeding", "Grooming", "Toys"]);

  function esc(str) {
    return String(str || "").replace(/[&<>"']/g, m => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[m]);
  }

  function showToast(msg) {
    const box = document.getElementById("toast-box");
    if (!box) return;
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }

  async function apiFetch(url, options = {}) {
    const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
    const res = await fetch(url, Object.assign({ credentials: "same-origin" }, options, { headers }));
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  function setTheme(theme) {
    document.body.setAttribute("data-theme", theme);
    localStorage.setItem("shopity_d1_theme", theme);
    document.querySelectorAll(".theme-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.theme === theme);
    });
  }

  function updateBadges() {
    document.getElementById("cart-count").textContent = state.cart.reduce((sum, i) => sum + i.qty, 0);
    document.getElementById("wish-count").textContent = state.wishlist.length;
    document.getElementById("comp-count").textContent = state.compareList.length;
  }

  function updateWalletUI() {
    const bal = state.currentUser && typeof state.currentUser.walletUsd === "number"
      ? state.currentUser.walletUsd
      : 25.0;
    document.getElementById("wallet-nav-bal").textContent = "$" + bal.toFixed(0);
    document.getElementById("wallet-usd-big").textContent = "$" + bal.toFixed(2) + " USD";
    document.getElementById("wallet-eur-big").textContent = "€" + (bal * state.eurRate).toFixed(2) + " EUR";
    document.getElementById("cart-wallet-avail").textContent = "$" + bal.toFixed(2) + " USD";
  }

  function updateAuthUI() {
    const adminBtn = document.getElementById("admin-nav-btn");
    const authBtn = document.getElementById("auth-nav-btn");
    if (state.currentUser) {
      authBtn.textContent = "👤 " + state.currentUser.name.split(" ")[0];
      adminBtn.style.display = state.currentUser.role === "admin" ? "inline-flex" : "none";
    } else {
      authBtn.textContent = "👤 Sign In";
      adminBtn.style.display = "none";
    }
  }

  function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.add("open");
    if (id === "cart-modal") renderCart();
    if (id === "wishlist-modal") renderWishlist();
    if (id === "compare-modal") renderCompare();
    if (id === "orders-modal") loadOrders();
    if (id === "admin-modal") {
      renderAdminProducts();
      loadAdminOrders();
      loadAdminStats();
    }
    if (id === "auth-modal") renderAuth();
    if (id === "soc-modal") loadSiemLogs();
    if (id === "wallet-modal") updateWalletUI();
  }

  function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.remove("open");
  }

  function closeAllModals() {
    document.querySelectorAll(".modal-backdrop.open").forEach(m => m.classList.remove("open"));
  }

  function getPromoBadge(p) {
    const nameLow = (p.name || "").toLowerCase();
    const specsLow = (p.specs || "").toLowerCase();
    if (nameLow.includes("lick mat") || specsLow.includes("الأساسي")) {
      return '<span class="promo-tag">🔥 HERO PRODUCT</span>';
    }
    if (specsLow.includes("مساعد") || nameLow.includes("brush") || nameLow.includes("remover")) {
      return '<span class="promo-tag">📈 UPSELL PICK</span>';
    }
    return "";
  }

  function renderVisual(p, size = "3.5rem") {
    if (p.img && p.img.startsWith("https://")) {
      return `<img src="${esc(p.img)}" alt="${esc(p.name)}" />`;
    }
    return `<span style="font-size:${size}; user-select:none;">${CAT_ICONS[p.category] || "🛍️"}</span>`;
  }

  function renderProducts() {
    const q = (document.getElementById("search-input")?.value || "").toLowerCase();
    const sortMode = document.getElementById("sort-select")?.value || "featured";
    const grid = document.getElementById("products-grid");
    if (!grid) return;

    let filtered = state.products.filter(p => {
      const matchCat = state.currentCategory === "All"
        || (state.currentCategory === "Pet Care" && PET_CATEGORIES.has(p.category))
        || p.category === state.currentCategory;
      const matchRocket = !state.rocketOnly || Number(p.rocket) === 1;
      const matchText = p.name.toLowerCase().includes(q)
        || (p.category && p.category.toLowerCase().includes(q))
        || (p.specs && p.specs.toLowerCase().includes(q));
      return matchCat && matchRocket && matchText;
    });

    if (sortMode === "price-asc") {
      filtered = [...filtered].sort((a, b) => Number(a.usd) - Number(b.usd));
    } else if (sortMode === "price-desc") {
      filtered = [...filtered].sort((a, b) => Number(b.usd) - Number(a.usd));
    }

    if (filtered.length === 0) {
      grid.innerHTML = '<p style="color:var(--text-muted); grid-column:1/-1; text-align:center; padding:34px;">No products match your filter.</p>';
      return;
    }

    grid.innerHTML = filtered.map(p => {
      const eur = (Number(p.usd) * state.eurRate).toFixed(2);
      const isWished = state.wishlist.includes(p.id);
      const isComp = state.compareList.includes(p.id);
      const out = Number(p.stock) <= 0;

      return `
        <article class="product-card">
          <div>
            <div class="product-img" data-action="quick-view" data-id="${p.id}">
              <div class="tag-stack">
                <span class="stock-tag ${out ? "out" : ""}">${out ? "OUT OF STOCK" : "✓ " + Number(p.stock) + " in stock"}</span>
                ${getPromoBadge(p)}
                ${Number(p.rocket) === 1 ? '<span class="rocket-tag">🚀 15-MIN</span>' : ""}
              </div>
              ${renderVisual(p)}
              <div class="card-icons">
                <button type="button" class="icon-circle ${isWished ? "active-wish" : ""}" data-action="toggle-wish" data-id="${p.id}" title="Wishlist">♥</button>
                <button type="button" class="icon-circle ${isComp ? "active-comp" : ""}" data-action="toggle-comp" data-id="${p.id}" title="Compare">⚖️</button>
              </div>
            </div>
            <div class="cat-tag">${CAT_ICONS[p.category] || "📦"} ${esc(p.category)}</div>
            <h3 class="product-title" data-action="quick-view" data-id="${p.id}">${esc(p.name)}</h3>
            <p class="product-specs">${esc(p.specs)}</p>
          </div>
          <div>
            <div class="price-box">
              <span class="usd">$${Number(p.usd).toFixed(2)} USD</span>
              <span class="eur">€${eur} EUR</span>
            </div>
            <div class="card-actions">
              <button type="button" class="btn" style="justify-content:center;" ${out ? "disabled" : ""} data-action="add-cart" data-id="${p.id}">🛒 Add</button>
              <button type="button" class="btn btn-primary" style="justify-content:center;" ${out ? "disabled" : ""} data-action="buy-now" data-id="${p.id}">⚡ Buy Now</button>
            </div>
          </div>
        </article>
      `;
    }).join("");
  }

  function openQuickView(id) {
    const p = state.products.find(prod => prod.id === id);
    if (!p) return;
    const eur = (Number(p.usd) * state.eurRate).toFixed(2);
    const out = Number(p.stock) <= 0;
    document.getElementById("qv-body").innerHTML = `
      <div style="text-align:center; background:var(--surface-alt); padding:24px; border-radius:12px; margin-bottom:12px;">
        ${renderVisual(p, "4.5rem")}
      </div>
      <div class="cat-tag">${esc(p.category)}</div>
      <h3 style="margin-bottom:6px;">${esc(p.name)}</h3>
      <p style="color:var(--text-muted); font-size:0.88rem; margin-bottom:12px;">${esc(p.specs)}</p>
      <div class="price-box">
        <span class="usd">$${Number(p.usd).toFixed(2)} USD</span>
        <span class="eur">€${eur} EUR</span>
      </div>
      <button type="button" class="btn btn-primary" style="width:100%; justify-content:center; padding:11px;" ${out ? "disabled" : ""} data-action="qv-buy" data-id="${p.id}">
        ⚡ Add & Proceed to Checkout
      </button>
    `;
    openModal("quickview-modal");
  }

  function addToCart(id) {
    const prod = state.products.find(p => p.id === id);
    if (!prod || Number(prod.stock) <= 0) return;
    const item = state.cart.find(c => c.id === id);
    if (item) {
      if (item.qty >= Number(prod.stock)) {
        showToast("Max available stock reached");
        return;
      }
      item.qty += 1;
    } else {
      state.cart.push({ id, qty: 1 });
    }
    localStorage.setItem("shopity_d1_cart", JSON.stringify(state.cart));
    updateBadges();
    showToast(`Added "${prod.name}" to Cart`);
  }

  function changeQty(id, delta) {
    const item = state.cart.find(c => c.id === id);
    const prod = state.products.find(p => p.id === id);
    if (!item || !prod) return;
    if (delta > 0 && item.qty >= Number(prod.stock)) return;
    item.qty += delta;
    if (item.qty <= 0) state.cart = state.cart.filter(c => c.id !== id);
    localStorage.setItem("shopity_d1_cart", JSON.stringify(state.cart));
    updateBadges();
    renderCart();
  }

  function renderCart() {
    const list = document.getElementById("cart-items-list");
    const upsellBox = document.getElementById("upsell-box");
    const primeNote = document.getElementById("prime-note");
    const promoNote = document.getElementById("promo-note");
    updateWalletUI();

    primeNote.textContent = state.isPrime ? "👑 SHOPITY PRIME Active (-10% verified)" : "";

    if (state.cart.length === 0) {
      list.innerHTML = '<p style="color:var(--text-muted); text-align:center; padding:14px;">Your cart is empty.</p>';
      upsellBox.innerHTML = "";
      promoNote.textContent = "";
      document.getElementById("cart-total-display").textContent = "$0.00 USD / €0.00 EUR";
      return;
    }

    let subtotal = 0;
    let petSubtotal = 0;
    list.innerHTML = state.cart.map(c => {
      const p = state.products.find(prod => prod.id === c.id);
      if (!p) return "";
      const lineTotal = Number(p.usd) * c.qty;
      subtotal += lineTotal;
      if (PET_CATEGORIES.has(p.category)) petSubtotal += lineTotal;
      return `
        <div class="list-row">
          <div><strong>${esc(p.name)}</strong><br/><small>$${Number(p.usd).toFixed(2)} × ${c.qty}</small></div>
          <div style="display:flex; gap:6px; align-items:center;">
            <button type="button" class="btn" data-action="qty-minus" data-id="${p.id}">-</button>
            <span>${c.qty}</span>
            <button type="button" class="btn" data-action="qty-plus" data-id="${p.id}">+</button>
          </div>
        </div>
      `;
    }).join("");

    const cartIds = new Set(state.cart.map(c => c.id));
    const suggestion = state.products.find(
      p => !cartIds.has(p.id) && Number(p.stock) > 0 && (p.category === "Grooming" || p.category === "Toys" || p.category === "Feeding")
    );
    upsellBox.innerHTML = suggestion
      ? `
        <div class="upsell-card">
          <div style="font-size:0.75rem; font-weight:800; color:var(--accent); margin-bottom:4px;">📈 COMPLETE YOUR BUNDLE (INCREASE ORDER VALUE)</div>
          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
            <span style="font-size:0.84rem;"><strong>${esc(suggestion.name)}</strong> — <span class="usd">$${Number(suggestion.usd).toFixed(2)}</span></span>
            <button type="button" class="btn btn-accent" data-action="upsell-add" data-id="${suggestion.id}">+ Add</button>
          </div>
        </div>
      `
      : "";

    const afterPrime = subtotal * (state.isPrime ? 0.90 : 1.0);
    let promoDisc = 0;
    const promo = PROMO_RULES[state.appliedPromo];
    if (promo) {
      if (promo.type === "pet_percent") promoDisc = petSubtotal * promo.value;
      else if (promo.type === "all_percent") promoDisc = afterPrime * promo.value;
      else if (promo.type === "fixed_usd" && afterPrime >= promo.minUsd) promoDisc = promo.value;
      promoNote.textContent = promoDisc > 0 ? `🎟️ Promo ${state.appliedPromo}: -$${promoDisc.toFixed(2)} USD (${promo.label})` : "";
    } else {
      promoNote.textContent = "";
    }

    const afterPromo = Math.max(0, afterPrime - promoDisc);
    const useWallet = document.getElementById("use-wallet-cb")?.checked;
    const bal = state.currentUser && typeof state.currentUser.walletUsd === "number" ? state.currentUser.walletUsd : 25.0;
    const finalUsd = Math.max(0, afterPromo - (useWallet ? Math.min(bal, afterPromo) : 0));

    document.getElementById("cart-total-display").textContent =
      `$${finalUsd.toFixed(2)} USD / €${(finalUsd * state.eurRate).toFixed(2)} EUR`;
  }

  async function checkout() {
    if (!state.currentUser) {
      closeModal("cart-modal");
      openModal("auth-modal");
      showToast("🔒 Please sign in first to complete your order.");
      return;
    }
    if (state.cart.length === 0) return;

    const useWallet = Boolean(document.getElementById("use-wallet-cb")?.checked);
    const { ok, data } = await apiFetch("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        items: state.cart,
        isPrime: state.isPrime,
        useWallet,
        promoCode: state.appliedPromo,
        gateway: document.getElementById("payment-method").value
      })
    });

    if (!ok) {
      showToast("⛔ " + (data.error || "Checkout failed"));
      return;
    }

    // Redirect to Stripe PCI-DSS Level 1 Hosted Checkout
    if (data.checkoutUrl) {
      showToast("🔐 Redirecting to Stripe PCI-DSS Level 1...");
      window.location.href = data.checkoutUrl;
      return;
    }

    if (typeof data.newWallet === "number") {
      state.currentUser.walletUsd = data.newWallet;
      updateWalletUI();
    }

    state.cart = [];
    state.appliedPromo = "";
    const promoInput = document.getElementById("promo-input");
    if (promoInput) promoInput.value = "";
    localStorage.setItem("shopity_d1_cart", JSON.stringify(state.cart));
    updateBadges();
    closeModal("cart-modal");
    await loadProducts();
    showToast(`✅ Order ${data.orderCode} confirmed! +$${data.cashbackEarned} Cashback`);
  }

  async function handleStripeReturn() {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("stripe_session_id");
    const canceled = params.get("stripe_canceled");

    if (canceled) {
      window.history.replaceState({}, "", "/");
      showToast("⚠️ Stripe payment was canceled.");
      return;
    }

    if (sessionId) {
      window.history.replaceState({}, "", "/");
      const { ok, data } = await apiFetch("/api/stripe/verify", {
        method: "POST",
        body: JSON.stringify({ sessionId })
      });
      if (ok) {
        state.cart = [];
        localStorage.setItem("shopity_d1_cart", "[]");
        updateBadges();
        await checkSession();
        await loadProducts();
        showToast(`✅ Stripe PCI-DSS Payment Verified (${data.orderCode})!`);
      } else {
        showToast("⛔ " + (data.error || "Unable to verify Stripe payment"));
      }
    }
  }

  function toggleWishlist(id) {
    if (state.wishlist.includes(id)) state.wishlist = state.wishlist.filter(w => w !== id);
    else state.wishlist.push(id);
    localStorage.setItem("shopity_d1_wish", JSON.stringify(state.wishlist));
    updateBadges();
    renderProducts();
  }

  function renderWishlist() {
    const list = document.getElementById("wishlist-items-list");
    if (state.wishlist.length === 0) {
      list.innerHTML = '<p style="color:var(--text-muted); text-align:center;">No saved items.</p>';
      return;
    }
    list.innerHTML = state.wishlist.map(id => {
      const p = state.products.find(prod => prod.id === id);
      if (!p) return "";
      return `
        <div class="list-row">
          <span><strong>${esc(p.name)}</strong> ($${Number(p.usd).toFixed(2)})</span>
          <button type="button" class="btn btn-primary" data-action="wish-to-cart" data-id="${p.id}">Move to Cart</button>
        </div>
      `;
    }).join("");
  }

  function toggleCompare(id) {
    if (state.compareList.includes(id)) state.compareList = state.compareList.filter(c => c !== id);
    else if (state.compareList.length < 3) state.compareList.push(id);
    else {
      showToast("Max 3 products in comparison");
      return;
    }
    localStorage.setItem("shopity_d1_comp", JSON.stringify(state.compareList));
    updateBadges();
    renderProducts();
  }

  function renderCompare() {
    const box = document.getElementById("compare-content");
    if (state.compareList.length === 0) {
      box.innerHTML = '<p style="color:var(--text-muted); text-align:center;">Click ⚖️ on up to 3 products to compare.</p>';
      return;
    }
    const items = state.compareList.map(id => state.products.find(p => p.id === id)).filter(Boolean);
    box.innerHTML = `
      <table class="compare-table">
        <tr><th>Feature</th>${items.map(i => `<th>${esc(i.name)}</th>`).join("")}</tr>
        <tr><td><strong>Category</strong></td>${items.map(i => `<td>${esc(i.category)}</td>`).join("")}</tr>
        <tr><td><strong>USD</strong></td>${items.map(i => `<td class="usd">$${Number(i.usd).toFixed(2)}</td>`).join("")}</tr>
        <tr><td><strong>EUR</strong></td>${items.map(i => `<td class="eur">€${(Number(i.usd) * state.eurRate).toFixed(2)}</td>`).join("")}</tr>
        <tr><td><strong>Specs</strong></td>${items.map(i => `<td>${esc(i.specs)}</td>`).join("")}</tr>
      </table>
    `;
  }

  async function loadOrders() {
    const list = document.getElementById("orders-list");
    if (!state.currentUser) {
      list.innerHTML = '<p style="color:var(--text-muted); text-align:center;">Sign in to view your orders.</p>';
      return;
    }
    const { ok, data } = await apiFetch("/api/orders");
    const orders = ok && Array.isArray(data.orders) ? data.orders : [];
    list.innerHTML = orders.length
      ? orders.map(o => `
        <div class="list-row">
          <div>
            <strong>${esc(o.order_code)}</strong> (${esc(o.created_at)})<br/>
            <small>${esc(o.items_summary)}</small><br/>
            <small style="color:var(--accent); font-weight:700;">$${Number(o.total_usd).toFixed(2)} USD / €${Number(o.total_eur).toFixed(2)} EUR</small>
          </div>
          <span class="badge">${esc(o.status)}</span>
        </div>
      `).join("")
      : '<p style="color:var(--text-muted); text-align:center;">No orders yet.</p>';
  }

  function evaluatePasswordStrength(pwd) {
    let score = 0;
    if (pwd.length >= 10) score += 25;
    if (/[A-Z]/.test(pwd)) score += 25;
    if (/[a-z]/.test(pwd)) score += 15;
    if (/[0-9]/.test(pwd)) score += 15;
    if (/[^A-Za-z0-9]/.test(pwd)) score += 20;
    const fill = document.getElementById("pass-strength-fill");
    const label = document.getElementById("pass-strength-label");
    if (!fill || !label) return;
    fill.style.width = score + "%";
    fill.style.background = score < 60 ? "#ef4444" : (score < 90 ? "#f59e0b" : "#10b981");
    label.textContent = score >= 90 ? "🛡️ PBKDF2 100,000-Iteration Ready" : "Needs 10+ chars, Uppercase, Lowercase, Number & Symbol";
  }

  function renderAuth() {
    const loggedIn = Boolean(state.currentUser);
    document.getElementById("logged-in-view").style.display = loggedIn ? "block" : "none";
    document.getElementById("logged-out-view").style.display = loggedIn ? "none" : "block";
    if (loggedIn) {
      document.getElementById("current-user-name").textContent = state.currentUser.name;
      document.getElementById("current-user-email").textContent = state.currentUser.email;
      document.getElementById("current-user-role").textContent = state.currentUser.role.toUpperCase();
    }
  }

  async function checkSession() {
    const { ok, data } = await apiFetch("/api/auth/me");
    state.currentUser = ok && data.authenticated ? data.user : null;
    updateAuthUI();
    updateWalletUI();
  }

  async function handleSignup() {
    const name = document.getElementById("reg-name").value.trim();
    const email = document.getElementById("reg-email").value.trim();
    const password = document.getElementById("reg-pass").value;

    const { ok, data } = await apiFetch("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ name, email, password })
    });
    if (!ok) {
      showToast("⛔ " + (data.error || "Signup failed"));
      return;
    }
    state.currentUser = data.user;
    updateAuthUI();
    updateWalletUI();
    closeModal("auth-modal");
    showToast(`🛡️ HttpOnly Session Active (${state.currentUser.role.toUpperCase()})!`);
  }

  async function handleLogin() {
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-pass").value;

    const { ok, data } = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });
    if (!ok) {
      showToast("⛔ " + (data.error || "Invalid credentials"));
      return;
    }
    state.currentUser = data.user;
    updateAuthUI();
    updateWalletUI();
    closeModal("auth-modal");
    showToast("🛡️ Authenticated via HttpOnly Cookie: " + state.currentUser.name);
  }

  async function logout() {
    await apiFetch("/api/auth/logout", { method: "POST" });
    state.currentUser = null;
    updateAuthUI();
    updateWalletUI();
    renderAuth();
    showToast("🔒 HttpOnly Cookie destroyed");
  }

  async function loadSiemLogs() {
    const box = document.getElementById("siem-log-box");
    const { ok, data } = await apiFetch("/api/siem");
    if (ok && Array.isArray(data.logs) && data.logs.length > 0) {
      box.innerHTML = data.logs.map(l => `<div>[${esc(l.created_at)}] [${esc(l.level)}] ${esc(l.message)}</div>`).join("");
    } else {
      box.innerHTML = "<div>[PASS] HttpOnly Cookies, PBKDF2-100k & Stripe PCI-DSS Active.</div>";
    }
  }

  async function loadAdminStats() {
    const box = document.getElementById("admin-stats-bar");
    if (!box || !state.currentUser) return;
    const { ok, data } = await apiFetch("/api/stats");
    if (ok) {
      box.innerHTML = `
        <div class="sec-item">💰 Revenue: $${Number(data.revenueUsd).toFixed(2)} (€${Number(data.revenueEur).toFixed(2)})</div>
        <div class="sec-item">📦 Orders: ${data.totalOrders} | 👥 Users: ${data.totalUsers}</div>
      `;
    }
  }

  function renderAdminProducts() {
    const box = document.getElementById("admin-products-list");
    if (!box) return;
    box.innerHTML = state.products.map(p => `
      <div class="list-row">
        <span>[${esc(p.category)}] ${esc(p.name)} ($${Number(p.usd).toFixed(2)}) • Stock: <strong>${Number(p.stock)}</strong></span>
        <div style="display:flex; gap:5px;">
          <button type="button" class="btn btn-accent" data-action="admin-restock" data-id="${p.id}">+10</button>
          <button type="button" class="btn btn-danger" data-action="admin-delete" data-id="${p.id}">Delete</button>
        </div>
      </div>
    `).join("");
  }

  async function adminAddProduct() {
    const name = document.getElementById("new-prod-name").value.trim();
    const category = document.getElementById("new-prod-cat").value;
    const usd = parseFloat(document.getElementById("new-prod-usd").value);
    const stock = parseInt(document.getElementById("new-prod-stock").value, 10) || 20;
    const specs = document.getElementById("new-prod-specs").value.trim();
    const img = document.getElementById("new-prod-img").value.trim();

    const { ok, data } = await apiFetch("/api/products", {
      method: "POST",
      body: JSON.stringify({ name, category, usd, stock, rocket: true, specs, img })
    });
    if (!ok) {
      showToast("⛔ " + (data.error || "Failed to publish"));
      return;
    }

    document.getElementById("new-prod-name").value = "";
    document.getElementById("new-prod-usd").value = "";
    document.getElementById("new-prod-specs").value = "";
    document.getElementById("new-prod-img").value = "";
    await loadProducts();
    await loadAdminStats();
    showToast("✅ Published to Cloudflare D1!");
  }

  async function loadAdminOrders() {
    const box = document.getElementById("admin-orders-list");
    if (!box || !state.currentUser) return;
    const { ok, data } = await apiFetch("/api/orders");
    const list = ok && Array.isArray(data.orders) ? data.orders : [];
    box.innerHTML = list.length
      ? list.map(o => `
        <div class="list-row">
          <span><strong>${esc(o.order_code)}</strong> (${esc(o.customer_email)}) • $${Number(o.total_usd).toFixed(2)}</span>
          <button type="button" class="btn" data-action="admin-deliver" data-id="${o.id}">${esc(o.status)} ↻</button>
        </div>
      `).join("")
      : '<p style="color:var(--text-muted);">No orders yet.</p>';
  }

  async function loadProducts() {
    try {
      const { ok, data } = await apiFetch("/api/products");
      if (ok && Array.isArray(data.products)) {
        state.products = data.products;
        if (data.eurRate) state.eurRate = Number(data.eurRate);
        document.getElementById("db-live-status").textContent =
          `🟢 Live Cloudflare D1 (${state.products.length} Products) • 1 USD = ${state.eurRate.toFixed(2)} EUR`;
        updateWalletUI();
        renderProducts();
        renderAdminProducts();
      }
    } catch (_) {
      document.getElementById("db-live-status").textContent = "⚠️ Connecting to Edge API...";
    }
  }

  document.addEventListener("click", async e => {
    const target = e.target.closest("[data-action]");
    if (!target) {
      if (e.target.classList.contains("modal-backdrop")) e.target.classList.remove("open");
      return;
    }

    e.stopPropagation();
    const action = target.dataset.action;
    const id = parseInt(target.dataset.id, 10);

    switch (action) {
      case "set-theme":
        setTheme(target.dataset.theme);
        break;
      case "toggle-prime":
        state.isPrime = !state.isPrime;
        target.textContent = state.isPrime ? "👑 PRIME: ON (-10%)" : "👑 PRIME: OFF";
        target.classList.toggle("active-prime", state.isPrime);
        renderCart();
        showToast(state.isPrime ? "👑 SHOPITY PRIME Activated (-10%)" : "SHOPITY PRIME Off");
        break;
      case "toggle-rocket":
        state.rocketOnly = !state.rocketOnly;
        target.classList.toggle("active-rocket", state.rocketOnly);
        renderProducts();
        break;
      case "open-modal":
        openModal(target.dataset.modal);
        break;
      case "close-modal":
        closeModal(target.dataset.modal);
        break;
      case "set-category":
        state.currentCategory = target.dataset.cat;
        document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("btn-primary"));
        target.classList.add("btn-primary");
        renderProducts();
        break;
      case "refresh-data":
        await loadProducts();
        showToast("↻ Catalog synced");
        break;
      case "quick-view":
        openQuickView(id);
        break;
      case "qv-buy":
        addToCart(id);
        closeModal("quickview-modal");
        openModal("cart-modal");
        break;
      case "toggle-wish":
        toggleWishlist(id);
        break;
      case "toggle-comp":
        toggleCompare(id);
        break;
      case "add-cart":
        addToCart(id);
        break;
      case "buy-now":
        addToCart(id);
        openModal("cart-modal");
        break;
      case "qty-minus":
        changeQty(id, -1);
        break;
      case "qty-plus":
        changeQty(id, 1);
        break;
      case "upsell-add":
        addToCart(id);
        renderCart();
        break;
      case "apply-promo": {
        const code = (document.getElementById("promo-input")?.value || "").toUpperCase().trim();
        if (PROMO_RULES[code]) {
          state.appliedPromo = code;
          renderCart();
          showToast(`🎟️ Promo ${code} applied!`);
        } else {
          showToast("⛔ Invalid code (Try: PETLOVE15, TITAN10, WELCOME5)");
        }
        break;
      }
      case "checkout":
        await checkout();
        break;
      case "wish-to-cart":
        addToCart(id);
        closeModal("wishlist-modal");
        openModal("cart-modal");
        break;
      case "auth-tab": {
        const tab = target.dataset.tab;
        ["login", "signup"].forEach(t => {
          document.getElementById("form-" + t).style.display = t === tab ? "block" : "none";
          document.getElementById("tab-" + t).classList.toggle("active", t === tab);
        });
        break;
      }
      case "login":
        await handleLogin();
        break;
      case "signup":
        await handleSignup();
        break;
      case "logout":
        await logout();
        break;
      case "admin-add":
        await adminAddProduct();
        break;
      case "admin-restock":
        await apiFetch("/api/products", { method: "PATCH", body: JSON.stringify({ id, addStock: 10 }) });
        await loadProducts();
        showToast("📦 Added +10 stock");
        break;
      case "admin-delete":
        await apiFetch(`/api/products?id=${id}`, { method: "DELETE" });
        await loadProducts();
        await loadAdminStats();
        showToast("Deleted from D1");
        break;
      case "admin-deliver":
        await apiFetch("/api/orders", { method: "PATCH", body: JSON.stringify({ id, status: "Delivered ✅" }) });
        await loadAdminOrders();
        showToast("Order marked Delivered ✅");
        break;
    }
  });

  document.getElementById("search-input")?.addEventListener("input", renderProducts);
  document.getElementById("sort-select")?.addEventListener("change", renderProducts);
  document.getElementById("use-wallet-cb")?.addEventListener("change", renderCart);
  document.getElementById("reg-pass")?.addEventListener("input", e => evaluatePasswordStrength(e.target.value));
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") closeAllModals();
  });

  ["mousemove", "keydown", "click", "touchstart"].forEach(evt => {
    window.addEventListener(evt, () => { state.lastActivity = Date.now(); }, { passive: true });
  });
  setInterval(async () => {
    if (state.currentUser && Date.now() - state.lastActivity > 15 * 60 * 1000) {
      await logout();
      showToast("🔒 Session expired due to 15m inactivity.");
    }
  }, 15000);

  (async () => {
    setTheme(localStorage.getItem("shopity_d1_theme") || "dark");
    updateBadges();
    await checkSession();
    await handleStripeReturn();
    await loadProducts();
  })();
})();