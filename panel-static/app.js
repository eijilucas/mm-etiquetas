const STATUS_LABELS = {
  pending_approval: "Pendente",
  approved: "Aprovado",
  cart_created: "Carrinho criado",
  purchased: "Frete comprado",
  label_generated: "Etiqueta gerada",
  tracking_synced: "Concluido",
  held: "Em espera",
  failed: "Falhou",
};

const STORE_LABELS = {
  basico: "Drop Básico",
  exclusivos: "Exclusivos",
};

function storeLabel(storeKey) {
  return STORE_LABELS[storeKey] || storeKey;
}

function orderRef(order) {
  return `#${order.shopifyOrderNumber ?? order.shopifyOrderId} · ${storeLabel(order.storeKey)}`;
}

// HTML version for table cells — bolds the order number so it's easy to spot
// for whoever's packing, since it's the field they match against the physical order.
function orderRefHtml(order) {
  return `<strong>#${order.shopifyOrderNumber ?? order.shopifyOrderId}</strong> · ${storeLabel(order.storeKey)}`;
}

function storeCell(order) {
  return `<span class="pill">${storeLabel(order.storeKey)}</span>`;
}

const STATUS_ORDER_LABEL = "Pedido";

// Real login (Supabase Auth) instead of a shared token pasted per machine —
// the session persists in this browser on its own (supabase-js handles that),
// so signing in once is enough until the person explicitly signs out.
const SUPABASE_URL = "https://sqwuceasvpavaoojkzxw.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNxd3VjZWFzdnBhdmFvb2prenh3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxMDAyNDYsImV4cCI6MjEwMjY3NjI0Nn0.GjcudkK40qoeCel_C3E_kL0p5AHye72YXfcsBABnQrA";
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function getAccessToken() {
  const { data } = await supabaseClient.auth.getSession();
  return data.session?.access_token ?? "";
}

const API_BASE = "https://sqwuceasvpavaoojkzxw.supabase.co/functions/v1/orders-api";

async function api(path, options = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function formatCurrency(value, currency) {
  const number = Number(value);
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: currency || "BRL" }).format(number);
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

// Size/color live in variantTitle and are what the packer needs to match
// against the physical item, so they're bolded to stand out from the rest.
function itemsSummary(items) {
  if (!Array.isArray(items)) return "-";
  return items
    .map((item) => `${item.quantity}x ${item.title}${item.variantTitle ? ` <strong>(${item.variantTitle})</strong>` : ""}`)
    .join(", ");
}

function pill(status) {
  return `<span class="pill status-${status}">${STATUS_LABELS[status] || status}</span>`;
}

const selectedPending = new Set();
let pendingOrders = [];
let pendingStoreFilter = "all";

function renderPendingStoreFilter() {
  const container = document.getElementById("pendingStoreFilter");
  const keys = Array.from(new Set(pendingOrders.map((order) => order.storeKey))).sort((a, b) =>
    storeLabel(a).localeCompare(storeLabel(b)),
  );

  if (keys.length === 0) {
    container.innerHTML = "";
    return;
  }

  const countFor = (storeKey) =>
    storeKey === "all" ? pendingOrders.length : pendingOrders.filter((order) => order.storeKey === storeKey).length;

  const buttons = [{ key: "all", label: "Todas" }, ...keys.map((key) => ({ key, label: storeLabel(key) }))];
  container.innerHTML = buttons
    .map(
      ({ key, label }) =>
        `<button class="store-filter-btn${pendingStoreFilter === key ? " active" : ""}" data-store="${key}">${label} (${countFor(key)})</button>`,
    )
    .join("");

  container.querySelectorAll(".store-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      pendingStoreFilter = btn.dataset.store;
      renderPendingRows();
    });
  });
}

function renderPendingRows() {
  const tbody = document.getElementById("pendingTableBody");
  const empty = document.getElementById("pendingEmpty");
  const visible = pendingStoreFilter === "all" ? pendingOrders : pendingOrders.filter((order) => order.storeKey === pendingStoreFilter);

  // Prune selections for orders that dropped off the list (approved/held
  // elsewhere) instead of wiping the whole selection — this table reloads
  // every 30s and on every webhook-driven refresh, which used to silently
  // unselect whatever the packer had checked mid-click.
  const visibleIds = new Set(visible.map((order) => order.id));
  for (const id of [...selectedPending]) {
    if (!visibleIds.has(id)) selectedPending.delete(id);
  }

  tbody.innerHTML = "";
  updateBulkButtons();

  empty.style.display = visible.length === 0 ? "block" : "none";

  for (const order of visible) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" data-id="${order.id}" ${selectedPending.has(order.id) ? "checked" : ""} /></td>
      <td>${orderRefHtml(order)}</td>
      <td>${storeCell(order)}</td>
      <td>${order.customerName ?? "-"}<br/><span class="items-list">${order.customerEmail ?? ""}</span></td>
      <td class="items-list">${itemsSummary(order.items)}</td>
      <td>${formatCurrency(order.totalPrice, order.currency)}</td>
      <td>${formatDate(order.paidAt)}</td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => {
      const id = event.target.dataset.id;
      if (event.target.checked) selectedPending.add(id);
      else selectedPending.delete(id);
      updateBulkButtons();
    });
  });
}

async function loadPending() {
  const { orders } = await api("/pending");
  pendingOrders = orders;
  if (pendingStoreFilter !== "all" && !orders.some((order) => order.storeKey === pendingStoreFilter)) {
    pendingStoreFilter = "all";
  }
  renderPendingStoreFilter();
  renderPendingRows();
  return orders;
}

function updateBulkButtons() {
  const has = selectedPending.size > 0;
  document.getElementById("approveBtn").disabled = !has;
  document.getElementById("holdBtn").disabled = !has;
}

// Printable = has a label already, so there's something to print at all.
function isPrintable(order) {
  return order.status === "label_generated" || order.status === "tracking_synced";
}

// Calling window.open() in a loop is unreliable across browsers — some
// popup blockers only exempt the FIRST call per click gesture and silently
// block the rest, so part of the batch would just never open with no
// indication anything was skipped. Instead this opens a single tab (which
// is always allowed, it's the one direct window.open in the click handler)
// listing every label as a real link — clicking a link is never treated as
// a popup, so every single one is guaranteed to open.
function openAllLabels(orders) {
  const withLabels = orders.filter((order) => order.labelPdfUrl);
  if (withLabels.length === 0) return;

  const win = window.open("", "_blank");
  if (!win) {
    alert("O navegador bloqueou a aba. Permita pop-ups para este site e tente de novo.");
    return;
  }

  const links = withLabels
    .map((order) => `<a href="${order.labelPdfUrl}" target="_blank" rel="noopener">${orderRef(order)}</a>`)
    .join("");
  win.document.write(`
    <!doctype html>
    <html lang="pt-BR">
    <head>
      <meta charset="utf-8" />
      <title>Etiquetas para imprimir</title>
      <style>
        body { background: #000; color: #f2f2f2; font-family: sans-serif; padding: 24px; }
        h1 { font-size: 16px; font-weight: 600; margin-bottom: 16px; }
        a { display: block; background: #0a0a0a; border: 1px solid #2a2a2a; color: #fff; padding: 14px 18px;
            margin-bottom: 10px; border-radius: 8px; text-decoration: none; font-size: 15px; }
        a:hover { border-color: #fff; }
      </style>
    </head>
    <body>
      <h1>Clique em cada pedido para abrir a etiqueta numa aba nova</h1>
      ${links}
    </body>
    </html>
  `);
  win.document.close();
}

let processingOrders = [];
const selectedProcessing = new Set();
let cancelTargetId = null;

function updateReleasedBulkButtons() {
  document.getElementById("bulkPrintBtn").disabled = selectedProcessing.size === 0;
}

// "Liberados" = approved through label-issued/failed, still not physically
// dropped off. "Postados" = same processing statuses, but posted_at is set —
// see loadProcessing below, which fetches the whole /processing set once and
// splits it by that flag rather than hitting the API twice.
function renderReleasedRows(orders) {
  const tbody = document.getElementById("releasedTableBody");
  const empty = document.getElementById("releasedEmpty");
  tbody.innerHTML = "";
  empty.style.display = orders.length === 0 ? "block" : "none";

  for (const order of orders) {
    const tr = document.createElement("tr");
    const canReprocess = order.status === "failed";
    tr.innerHTML = `
      <td>${isPrintable(order) ? `<input type="checkbox" data-select="${order.id}" ${selectedProcessing.has(order.id) ? "checked" : ""} />` : ""}</td>
      <td>${orderRefHtml(order)}</td>
      <td>${storeCell(order)}</td>
      <td>${order.customerName ?? "-"}</td>
      <td>${pill(order.status)}</td>
      <td>${order.trackingCode ?? "-"}</td>
      <td>${order.labelPdfUrl ? `<a class="btn" href="${order.labelPdfUrl}" target="_blank" rel="noopener">Etiqueta</a>` : "-"}</td>
      <td class="error-text">${order.lastError ?? ""}</td>
      <td>${formatDate(order.updatedAt)}</td>
      <td>
        ${canReprocess ? `<button class="btn" data-reprocess="${order.id}">Reprocessar</button>` : ""}
        <button class="btn danger" data-cancel="${order.id}">Cancelar</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll("[data-select]").forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => {
      const id = event.target.dataset.select;
      if (event.target.checked) selectedProcessing.add(id);
      else selectedProcessing.delete(id);
      updateReleasedBulkButtons();
    });
  });

  tbody.querySelectorAll("[data-reprocess]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api(`/${btn.dataset.reprocess}/reprocess`, { method: "POST" });
        await loadProcessing();
        await refreshKpis();
      } catch (error) {
        alert(`Erro ao reprocessar: ${error.message}`);
        btn.disabled = false;
      }
    });
  });

  tbody.querySelectorAll("[data-cancel]").forEach((btn) => {
    btn.addEventListener("click", () => {
      cancelTargetId = btn.dataset.cancel;
      document.getElementById("cancelLabelReasonInput").value = "";
      document.getElementById("cancelLabelDialog").showModal();
    });
  });
}

function renderPostedRows(orders) {
  const tbody = document.getElementById("postedTableBody");
  const empty = document.getElementById("postedEmpty");
  tbody.innerHTML = "";
  empty.style.display = orders.length === 0 ? "block" : "none";

  for (const order of orders) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${orderRefHtml(order)}</td>
      <td>${storeCell(order)}</td>
      <td>${order.customerName ?? "-"}</td>
      <td>${order.trackingCode ?? "-"}</td>
      <td>${order.labelPdfUrl ? `<a class="btn" href="${order.labelPdfUrl}" target="_blank" rel="noopener">Etiqueta</a>` : "-"}</td>
      <td>${formatDate(order.postedAt)}</td>
      <td>${order.postedBy ?? "Automático (Melhor Envio)"}</td>
    `;
    tbody.appendChild(tr);
  }
}

async function loadProcessing() {
  const { orders } = await api("/processing");
  processingOrders = orders;

  // Same reasoning as renderPendingRows: prune what's no longer selectable
  // instead of clearing the whole selection on every refresh.
  const selectableIds = new Set(orders.filter((order) => !order.postedAt && isPrintable(order)).map((order) => order.id));
  for (const id of [...selectedProcessing]) {
    if (!selectableIds.has(id)) selectedProcessing.delete(id);
  }
  updateReleasedBulkButtons();

  renderReleasedRows(orders.filter((order) => !order.postedAt));
  renderPostedRows(orders.filter((order) => order.postedAt));

  return orders;
}

async function loadHeld() {
  const { orders } = await api("/held");
  const tbody = document.getElementById("heldTableBody");
  const empty = document.getElementById("heldEmpty");
  tbody.innerHTML = "";
  empty.style.display = orders.length === 0 ? "block" : "none";

  for (const order of orders) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${orderRefHtml(order)}</td>
      <td>${storeCell(order)}</td>
      <td>${order.customerName ?? "-"}</td>
      <td>${order.heldReason ?? "-"}</td>
      <td>${formatDate(order.heldAt)}</td>
      <td><button class="btn" data-revert="${order.id}">Reverter para pendente</button></td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll("[data-revert]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api("/revert", { method: "POST", body: JSON.stringify({ ids: [btn.dataset.revert] }) });
        await loadHeld();
        await refreshKpis();
      } catch (error) {
        alert(`Erro ao reverter: ${error.message}`);
        btn.disabled = false;
      }
    });
  });

  return orders;
}

// Candidates for manual tracking entry: any order that hasn't already
// reached tracking_synced, regardless of which status it fell into — these
// are orders someone bought a label for by hand outside the pipeline, so
// they could be stuck anywhere (pending_approval, held, or failed).
let manualTrackingOrders = [];

async function loadManualTracking() {
  const [pending, held, processing] = await Promise.all([api("/pending"), api("/held"), api("/processing")]);
  manualTrackingOrders = [...pending.orders, ...held.orders, ...processing.orders.filter((o) => o.status !== "tracking_synced")];
  renderManualTrackingRows();
  return manualTrackingOrders;
}

function renderManualTrackingRows() {
  const tbody = document.getElementById("manualTrackingTableBody");
  const empty = document.getElementById("manualTrackingEmpty");
  const query = document.getElementById("manualTrackingSearch").value.trim().toLowerCase();
  const visible = manualTrackingOrders.filter((order) => {
    if (!query) return true;
    const haystack = `${order.shopifyOrderNumber ?? order.shopifyOrderId} ${order.customerName ?? ""}`.toLowerCase();
    return haystack.includes(query);
  });

  tbody.innerHTML = "";
  empty.style.display = visible.length === 0 ? "block" : "none";

  for (const order of visible) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${orderRefHtml(order)}</td>
      <td>${storeCell(order)}</td>
      <td>${order.customerName ?? "-"}</td>
      <td>${pill(order.status)}</td>
      <td><input type="text" class="text-input" data-tracking-input="${order.id}" placeholder="Codigo de rastreio" /></td>
      <td><button class="btn" data-send-tracking="${order.id}">Enviar</button></td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll("[data-send-tracking]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.sendTracking;
      const input = tbody.querySelector(`[data-tracking-input="${id}"]`);
      const trackingCode = input.value.trim();
      if (!trackingCode) {
        alert("Informe o codigo de rastreio.");
        return;
      }
      btn.disabled = true;
      try {
        await api(`/${id}/tracking`, { method: "POST", body: JSON.stringify({ trackingCode }) });
        await loadManualTracking();
        await refreshKpis();
      } catch (error) {
        alert(`Erro ao enviar rastreio: ${error.message}`);
        btn.disabled = false;
      }
    });
  });
}

function setupManualTracking() {
  document.getElementById("manualTrackingSearch").addEventListener("input", renderManualTrackingRows);
  document.getElementById("refreshManualTrackingBtn").addEventListener("click", loadManualTracking);
}

async function refreshKpis() {
  const [pending, processing, held] = await Promise.all([
    api("/pending"),
    api("/processing"),
    api("/held"),
  ]);
  document.getElementById("kpiPending").textContent = pending.orders.length;
  document.getElementById("kpiProcessing").textContent = processing.orders.filter((o) => o.status !== "tracking_synced" && o.status !== "failed").length;
  document.getElementById("kpiCompleted").textContent = processing.orders.filter((o) => o.status === "tracking_synced").length;
  document.getElementById("kpiFailed").textContent = processing.orders.filter((o) => o.status === "failed").length;
}

// Best-effort — the backend returns balance: null when it can't read the
// wallet (e.g. missing API permission), so the banner just stays hidden
// instead of showing a false alarm.
async function refreshBalance() {
  const banner = document.getElementById("balanceBanner");
  try {
    const { balance, lowBalanceThreshold } = await api("/balance");
    if (balance == null || balance >= lowBalanceThreshold) {
      banner.style.display = "none";
      return;
    }
    banner.textContent = `⚠️ Saldo baixo na Melhor Envio: ${formatCurrency(balance, "BRL")}. Adicione crédito para não travar a emissão de etiquetas.`;
    banner.style.display = "block";
  } catch (error) {
    console.error(error);
    banner.style.display = "none";
  }
}

function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });
}

function showLoggedIn(session) {
  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("mainContent").style.display = "";
  document.getElementById("userStatus").style.display = "";
  document.getElementById("userEmail").textContent = session.user.email;
  loadAll();
}

function showLoggedOut() {
  document.getElementById("loginScreen").style.display = "flex";
  document.getElementById("mainContent").style.display = "none";
  document.getElementById("userStatus").style.display = "none";
}

function setupLogin() {
  document.getElementById("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;
    const errorEl = document.getElementById("loginError");
    const submitBtn = document.getElementById("loginSubmitBtn");
    errorEl.style.display = "none";
    submitBtn.disabled = true;
    try {
      const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } catch (error) {
      errorEl.textContent = error.message === "Invalid login credentials" ? "E-mail ou senha incorretos." : error.message;
      errorEl.style.display = "block";
    } finally {
      submitBtn.disabled = false;
    }
  });

  document.getElementById("logoutBtn").addEventListener("click", () => supabaseClient.auth.signOut());

  supabaseClient.auth.onAuthStateChange((_event, session) => {
    if (session) showLoggedIn(session);
    else showLoggedOut();
  });
}

function setupHoldDialog() {
  const dialog = document.getElementById("holdDialog");
  const reasonInput = document.getElementById("holdReasonInput");
  document.getElementById("holdBtn").addEventListener("click", () => {
    reasonInput.value = "";
    dialog.showModal();
  });
  document.getElementById("holdCancelBtn").addEventListener("click", () => dialog.close());
  document.getElementById("holdConfirmBtn").addEventListener("click", async () => {
    const reason = reasonInput.value.trim();
    if (!reason) {
      alert("Informe o motivo.");
      return;
    }
    try {
      await api("/hold", {
        method: "POST",
        body: JSON.stringify({ ids: Array.from(selectedPending), reason }),
      });
      dialog.close();
      await loadPending();
      await refreshKpis();
    } catch (error) {
      alert(`Erro ao segurar pedidos: ${error.message}`);
    }
  });
}

// Undoes an already-purchased label (Melhor Envio refunds the wallet) and
// parks the order in "held" — see cancelOrderLabel in the backend.
function setupCancelLabelDialog() {
  const dialog = document.getElementById("cancelLabelDialog");
  document.getElementById("cancelLabelCloseBtn").addEventListener("click", () => dialog.close());
  document.getElementById("cancelLabelConfirmBtn").addEventListener("click", async () => {
    const reason = document.getElementById("cancelLabelReasonInput").value.trim();
    if (!reason) {
      alert("Informe o motivo.");
      return;
    }
    try {
      await api(`/${cancelTargetId}/cancel`, { method: "POST", body: JSON.stringify({ reason }) });
      dialog.close();
      await loadProcessing();
      await refreshKpis();
    } catch (error) {
      alert(`Erro ao cancelar etiqueta: ${error.message}`);
    }
  });
}

function setupBulkPrint() {
  const btn = document.getElementById("bulkPrintBtn");
  btn.addEventListener("click", () => {
    const orders = processingOrders.filter((o) => selectedProcessing.has(o.id));
    if (orders.length === 0) return;
    openAllLabels(orders);
  });
}

function setupToolbar() {
  document.getElementById("selectAllReleasedBtn").addEventListener("click", () => {
    const checkboxes = document.querySelectorAll('#releasedTableBody input[type="checkbox"]');
    const allSelected = checkboxes.length > 0 && Array.from(checkboxes).every((c) => c.checked);
    checkboxes.forEach((checkbox) => {
      checkbox.checked = !allSelected;
      const id = checkbox.dataset.select;
      if (!allSelected) selectedProcessing.add(id);
      else selectedProcessing.delete(id);
    });
    updateReleasedBulkButtons();
  });

  document.getElementById("selectAllBtn").addEventListener("click", () => {
    const checkboxes = document.querySelectorAll('#pendingTableBody input[type="checkbox"]');
    const allSelected = checkboxes.length > 0 && Array.from(checkboxes).every((c) => c.checked);
    checkboxes.forEach((checkbox) => {
      checkbox.checked = !allSelected;
      const id = checkbox.dataset.id;
      if (!allSelected) selectedPending.add(id);
      else selectedPending.delete(id);
    });
    updateBulkButtons();
  });

  document.getElementById("approveBtn").addEventListener("click", () => {
    if (selectedPending.size === 0) return;
    document.getElementById("stockConfirmDialog").showModal();
  });

  document.getElementById("refreshPendingBtn").addEventListener("click", loadPending);
  document.getElementById("refreshReleasedBtn").addEventListener("click", loadProcessing);
  document.getElementById("refreshPostedBtn").addEventListener("click", loadProcessing);
  document.getElementById("refreshHeldBtn").addEventListener("click", loadHeld);
}

// Extra "does the packer actually have stock" gate before etiquetas are
// issued — added because mis-picks only surface after the label (and the
// customer notification) already went out, which is much costlier to undo.
function setupStockConfirmDialog() {
  const dialog = document.getElementById("stockConfirmDialog");
  document.getElementById("stockConfirmNoBtn").addEventListener("click", () => dialog.close());
  document.getElementById("stockConfirmYesBtn").addEventListener("click", async () => {
    dialog.close();
    try {
      await api("/approve", { method: "POST", body: JSON.stringify({ ids: Array.from(selectedPending) }) });
      await loadPending();
      await refreshKpis();
    } catch (error) {
      alert(`Erro ao aprovar: ${error.message}`);
    }
  });
}

async function loadAll() {
  try {
    await Promise.all([loadPending(), loadProcessing(), loadHeld(), loadManualTracking(), refreshKpis(), refreshBalance()]);
  } catch (error) {
    console.error(error);
  }
}

setupTabs();
setupLogin();
setupHoldDialog();
setupBulkPrint();
setupManualTracking();
setupCancelLabelDialog();
setupStockConfirmDialog();
setupToolbar();
setInterval(() => {
  if (document.getElementById("mainContent").style.display !== "none") loadAll();
}, 30000);
