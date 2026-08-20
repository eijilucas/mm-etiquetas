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

function storeCell(order) {
  return `<span class="pill">${storeLabel(order.storeKey)}</span>`;
}

const STATUS_ORDER_LABEL = "Pedido";

function getToken() {
  return localStorage.getItem("mm_etiquetas_token") || "";
}

function setToken(token) {
  localStorage.setItem("mm_etiquetas_token", token);
  renderTokenStatus();
}

function renderTokenStatus() {
  const el = document.getElementById("tokenStatus");
  el.textContent = getToken() ? "token configurado" : "token nao configurado";
}

const API_BASE = "/functions/v1/orders-api";

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
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

function itemsSummary(items) {
  if (!Array.isArray(items)) return "-";
  return items.map((item) => `${item.quantity}x ${item.title}`).join(", ");
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
      <td>${orderRef(order)}</td>
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

async function loadProcessing() {
  const { orders } = await api("/processing");
  const tbody = document.getElementById("processingTableBody");
  const empty = document.getElementById("processingEmpty");
  tbody.innerHTML = "";
  empty.style.display = orders.length === 0 ? "block" : "none";

  for (const order of orders) {
    const tr = document.createElement("tr");
    const canReprocess = order.status === "failed";
    tr.innerHTML = `
      <td>${orderRef(order)}</td>
      <td>${storeCell(order)}</td>
      <td>${order.customerName ?? "-"}</td>
      <td>${pill(order.status)}</td>
      <td>${order.trackingCode ?? "-"}</td>
      <td class="error-text">${order.lastError ?? ""}</td>
      <td>${formatDate(order.updatedAt)}</td>
      <td>${canReprocess ? `<button class="btn" data-reprocess="${order.id}">Reprocessar</button>` : ""}</td>
    `;
    tbody.appendChild(tr);
  }

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
      <td>${orderRef(order)}</td>
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

function setupTokenDialog() {
  const dialog = document.getElementById("tokenDialog");
  const input = document.getElementById("tokenInput");
  document.getElementById("setTokenBtn").addEventListener("click", () => {
    input.value = getToken();
    dialog.showModal();
  });
  document.getElementById("tokenCancelBtn").addEventListener("click", () => dialog.close());
  document.getElementById("tokenConfirmBtn").addEventListener("click", () => {
    setToken(input.value.trim());
    dialog.close();
    loadAll();
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

function setupToolbar() {
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

  document.getElementById("approveBtn").addEventListener("click", async () => {
    if (selectedPending.size === 0) return;
    if (!confirm(`Emitir etiquetas para ${selectedPending.size} pedido(s)?`)) return;
    try {
      await api("/approve", { method: "POST", body: JSON.stringify({ ids: Array.from(selectedPending) }) });
      await loadPending();
      await refreshKpis();
    } catch (error) {
      alert(`Erro ao aprovar: ${error.message}`);
    }
  });

  document.getElementById("refreshPendingBtn").addEventListener("click", loadPending);
  document.getElementById("refreshProcessingBtn").addEventListener("click", loadProcessing);
  document.getElementById("refreshHeldBtn").addEventListener("click", loadHeld);
}

async function loadAll() {
  try {
    await Promise.all([loadPending(), loadProcessing(), loadHeld(), refreshKpis()]);
  } catch (error) {
    console.error(error);
  }
}

renderTokenStatus();
setupTabs();
setupTokenDialog();
setupHoldDialog();
setupToolbar();
loadAll();
setInterval(loadAll, 30000);
