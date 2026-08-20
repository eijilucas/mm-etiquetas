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

  tbody.innerHTML = "";
  selectedPending.clear();
  updateBulkButtons();

  empty.style.display = visible.length === 0 ? "block" : "none";

  for (const order of visible) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" data-id="${order.id}" /></td>
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

// Melhor Envio now bundles the content declaration into the label PDF
// itself, so this only ever needs to open one document per order. Still
// opened via window.open in the same synchronous click gesture so the
// popup blocker treats the whole batch as user-initiated.
function openAllLabels(orders) {
  for (const order of orders) {
    if (order.labelPdfUrl) window.open(order.labelPdfUrl, "_blank");
  }
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
      <td>${isPrintable(order) ? `<input type="checkbox" data-select="${order.id}" />` : ""}</td>
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
  selectedProcessing.clear();
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
    await Promise.all([loadPending(), loadProcessing(), loadHeld(), refreshKpis()]);
  } catch (error) {
    console.error(error);
  }
}

setupTabs();
setupLogin();
setupHoldDialog();
setupBulkPrint();
setupCancelLabelDialog();
setupStockConfirmDialog();
setupToolbar();
setInterval(() => {
  if (document.getElementById("mainContent").style.display !== "none") loadAll();
}, 30000);
