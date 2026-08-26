const STATUS_LABELS = {
  pending_approval: "Pendente",
  approved: "Aprovado",
  cart_created: "Carrinho criado",
  purchased: "Frete comprado",
  label_generated: "Etiqueta gerada",
  tracking_ready: "Aguardando envio",
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

// Themed replacements for the browser's native alert()/confirm() — those
// render as an unstyled OS dialog that clashes hard with the site's dark
// theme (screenshot from Vitor). Both reuse the same <dialog> pattern
// already used for holdDialog/cancelLabelDialog and resolve a Promise on
// button click, so every call site just becomes `await showAlert(...)` /
// `await showConfirm(...)`.
function showAlert(message) {
  return new Promise((resolve) => {
    const dialog = document.getElementById("alertDialog");
    document.getElementById("alertDialogMessage").textContent = message;
    const okBtn = document.getElementById("alertDialogOkBtn");
    const onOk = () => {
      okBtn.removeEventListener("click", onOk);
      dialog.close();
      resolve();
    };
    okBtn.addEventListener("click", onOk);
    dialog.showModal();
  });
}

function showConfirm(message) {
  return new Promise((resolve) => {
    const dialog = document.getElementById("confirmDialog");
    document.getElementById("confirmDialogMessage").textContent = message;
    const yesBtn = document.getElementById("confirmDialogYesBtn");
    const noBtn = document.getElementById("confirmDialogNoBtn");
    const cleanup = () => {
      yesBtn.removeEventListener("click", onYes);
      noBtn.removeEventListener("click", onNo);
    };
    const onYes = () => {
      cleanup();
      dialog.close();
      resolve(true);
    };
    const onNo = () => {
      cleanup();
      dialog.close();
      resolve(false);
    };
    yesBtn.addEventListener("click", onYes);
    noBtn.addEventListener("click", onNo);
    dialog.showModal();
  });
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

// Standard search box for every tab: filters by order number/id or customer
// name. Add a new tab by giving it a <input id="XSearch"> in the toolbar
// (last child, style="margin-left: auto;") and wiring "input" -> its render
// function in setupToolbar, same as the others below.
function filterBySearch(orders, inputId) {
  const query = document.getElementById(inputId).value.trim().toLowerCase();
  if (!query) return orders;
  return orders.filter((order) => `${order.shopifyOrderNumber ?? order.shopifyOrderId} ${order.customerName ?? ""}`.toLowerCase().includes(query));
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
  const storeFiltered = pendingStoreFilter === "all" ? pendingOrders : pendingOrders.filter((order) => order.storeKey === pendingStoreFilter);

  // Prune selections for orders that dropped off the list (approved/held
  // elsewhere) instead of wiping the whole selection — this table reloads
  // every 30s and on every webhook-driven refresh, which used to silently
  // unselect whatever the packer had checked mid-click. Pruned against the
  // store filter only, not the search box below — typing a search query
  // must never silently unselect an order that's just temporarily hidden.
  const storeFilteredIds = new Set(storeFiltered.map((order) => order.id));
  for (const id of [...selectedPending]) {
    if (!storeFilteredIds.has(id)) selectedPending.delete(id);
  }

  const visible = filterBySearch(storeFiltered, "pendingSearch");

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
  return order.status === "label_generated" || order.status === "tracking_ready" || order.status === "tracking_synced";
}

// Calling window.open() in a loop is unreliable across browsers — some
// popup blockers only exempt the FIRST call per click gesture and silently
// block the rest, so part of the batch would just never open with no
// indication anything was skipped. Instead this opens a single tab (which
// is always allowed, it's the one direct window.open in the click handler)
// listing every label as a real link — clicking a link is never treated as
// a popup, so every single one is guaranteed to open.
async function openAllLabels(orders) {
  const withLabels = orders.filter((order) => order.labelPdfUrl);
  if (withLabels.length === 0) return;

  const win = window.open("", "_blank");
  if (!win) {
    await showAlert("O navegador bloqueou a aba. Permita pop-ups para este site e tente de novo.");
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
function renderReleasedRows() {
  const tbody = document.getElementById("releasedTableBody");
  const empty = document.getElementById("releasedEmpty");
  const orders = filterBySearch(
    processingOrders.filter((order) => !order.postedAt),
    "releasedSearch",
  );
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
      <td>${order.shippingPrice != null ? formatCurrency(order.shippingPrice, order.currency) : "-"}</td>
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
        await showAlert(`Erro ao reprocessar: ${error.message}`);
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

function renderPostedRows() {
  const tbody = document.getElementById("postedTableBody");
  const empty = document.getElementById("postedEmpty");
  const orders = filterBySearch(
    processingOrders.filter((order) => order.postedAt),
    "postedSearch",
  );
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

  renderReleasedRows();
  renderPostedRows();

  return orders;
}

let heldOrders = [];

async function loadHeld() {
  const { orders } = await api("/held");
  heldOrders = orders;
  renderHeldRows();
  return orders;
}

function renderHeldRows() {
  const tbody = document.getElementById("heldTableBody");
  const empty = document.getElementById("heldEmpty");
  const orders = filterBySearch(heldOrders, "heldSearch");
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
      <td>
        <button class="btn" data-revert="${order.id}">Reverter para pendente</button>
        <button class="btn danger" data-archive="${order.id}">Remover</button>
      </td>
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
        await showAlert(`Erro ao reverter: ${error.message}`);
        btn.disabled = false;
      }
    });
  });

  // Doesn't delete the row (history stays in the DB), just moves it to a
  // status no tab queries for — see the /archive route.
  tbody.querySelectorAll("[data-archive]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.archive;
      if (!(await showConfirm("Remover esse pedido do painel? Ele para de aparecer em qualquer aba (o historico continua salvo no banco)."))) return;
      btn.disabled = true;
      try {
        await api(`/${id}/archive`, { method: "POST" });
        await loadHeld();
        await refreshKpis();
      } catch (error) {
        await showAlert(`Erro ao remover: ${error.message}`);
        btn.disabled = false;
      }
    });
  });
}

// Candidates for the Rastreio manual tab, three flavors:
//  - status "tracking_ready": syncTrackingStep already fetched and stored
//    the code (this is now the normal path for every order — sending it to
//    Shopify/the customer is a deliberate separate click, never automatic).
//  - status "failed" with melhorEnvioOrderId: purchased, but still waiting
//    on Melhor Envio to assign a code (e.g. carrier hasn't scanned it in
//    yet) — auto-fetched live so Vitor can check right now instead of
//    waiting for the next 15min cron cycle.
//  - status "failed" with no melhorEnvioOrderId: never purchased through
//    this system at all, e.g. bought by hand on Melhor Envio's site after a
//    balance/CEP failure here — nothing to auto-fetch, needs a typed code.
// Pending/held orders are excluded either way: pending never attempted a
// purchase, held is an explicit "wait for a human decision" state.
let manualTrackingOrders = [];
let trackingPreviews = {};
const selectedManualTracking = new Set();

function updateManualTrackingBulkButtons() {
  document.getElementById("bulkSendTrackingBtn").disabled = selectedManualTracking.size === 0;
  document.getElementById("bulkArchiveManualBtn").disabled = selectedManualTracking.size === 0;
}

// processingList lets a caller that already fetched /processing this tick
// (loadAll, tab-switch) reuse it instead of fetching it again; omit it after
// an action (send/archive) to force a fresh read of what actually changed.
async function loadManualTracking(processingList) {
  const orders = processingList ?? (await api("/processing")).orders;
  manualTrackingOrders = orders.filter((o) => o.status === "tracking_ready" || o.status === "failed");

  // Same prune-not-clear reasoning as the other tabs: this reloads every
  // 30s, and a hard .clear() would silently unselect whatever was checked
  // mid-click.
  const visibleIds = new Set(manualTrackingOrders.map((o) => o.id));
  for (const id of [...selectedManualTracking]) {
    if (!visibleIds.has(id)) selectedManualTracking.delete(id);
  }

  // tracking_ready orders already carry their code (order.trackingCode) —
  // only the still-stuck "failed" ones need a live lookup.
  trackingPreviews = {};
  const autoFetchable = manualTrackingOrders.filter((o) => o.status === "failed" && o.melhorEnvioOrderId);
  if (autoFetchable.length > 0) {
    const { previews } = await api("/tracking-preview", {
      method: "POST",
      body: JSON.stringify({ ids: autoFetchable.map((o) => o.id) }),
    });
    trackingPreviews = previews;
  }

  renderManualTrackingRows();
  return manualTrackingOrders;
}

// Single source of truth for "what code would Enviar send right now" —
// used by both the per-row button and the bulk action.
function resolveManualTrackingCode(order) {
  if (order.status === "tracking_ready") return order.trackingCode;
  if (order.melhorEnvioOrderId) return trackingPreviews[order.id] ?? null;
  const input = document.querySelector(`[data-tracking-input="${order.id}"]`);
  return input ? input.value.trim() : null;
}

function renderManualTrackingRows() {
  const tbody = document.getElementById("manualTrackingTableBody");
  const empty = document.getElementById("manualTrackingEmpty");
  const visible = filterBySearch(manualTrackingOrders, "manualTrackingSearch");

  tbody.innerHTML = "";
  empty.style.display = visible.length === 0 ? "block" : "none";
  updateManualTrackingBulkButtons();

  for (const order of visible) {
    const tr = document.createElement("tr");
    const ready = order.status === "tracking_ready";
    const auto = !ready && !!order.melhorEnvioOrderId;
    const preview = trackingPreviews[order.id];
    const codeCell = ready
      ? `<span class="mono-text">${order.trackingCode}</span>`
      : auto
        ? preview
          ? `<span class="mono-text">${preview}</span>`
          : `<span class="text-label">Ainda sem codigo</span>`
        : `<input type="text" class="text-input" data-tracking-input="${order.id}" placeholder="Codigo de rastreio (comprado por fora)" />`;
    tr.innerHTML = `
      <td><input type="checkbox" data-select-manual="${order.id}" ${selectedManualTracking.has(order.id) ? "checked" : ""} /></td>
      <td>${orderRefHtml(order)}</td>
      <td>${storeCell(order)}</td>
      <td>${order.customerName ?? "-"}</td>
      <td>${pill(order.status)}</td>
      <td>${codeCell}</td>
      <td>
        <button class="btn" data-send-tracking="${order.id}" ${auto && !preview ? "disabled" : ""}>Enviar</button>
        ${order.status === "failed" ? `<button class="btn danger" data-archive-manual="${order.id}">Remover</button>` : ""}
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll("[data-select-manual]").forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => {
      const id = event.target.dataset.selectManual;
      if (event.target.checked) selectedManualTracking.add(id);
      else selectedManualTracking.delete(id);
      updateManualTrackingBulkButtons();
    });
  });

  // Covers orders that got resolved entirely by hand outside this system —
  // label bought AND tracking already sent to Shopify directly — so there's
  // nothing left to send here, just needs to drop out of the queue. Only
  // offered for "failed" (the /archive route doesn't allow other statuses).
  tbody.querySelectorAll("[data-archive-manual]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.archiveManual;
      if (!(await showConfirm("Remover esse pedido do painel? Use quando ele ja foi resolvido inteiramente por fora (etiqueta e rastreio ja enviados na mao)."))) return;
      btn.disabled = true;
      try {
        await api(`/${id}/archive`, { method: "POST" });
        await loadManualTracking();
        await refreshKpis();
      } catch (error) {
        await showAlert(`Erro ao remover: ${error.message}`);
        btn.disabled = false;
      }
    });
  });

  tbody.querySelectorAll("[data-send-tracking]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.sendTracking;
      const order = manualTrackingOrders.find((o) => o.id === id);
      const trackingCode = resolveManualTrackingCode(order);
      if (!trackingCode) {
        if (!order.melhorEnvioOrderId) await showAlert("Informe o codigo de rastreio.");
        return;
      }
      btn.disabled = true;
      try {
        await api(`/${id}/tracking`, { method: "POST", body: JSON.stringify({ trackingCode }) });
        await loadManualTracking();
        await refreshKpis();
      } catch (error) {
        await showAlert(`Erro ao enviar rastreio: ${error.message}`);
        btn.disabled = false;
      }
    });
  });
}

function setupManualTracking() {
  document.getElementById("manualTrackingSearch").addEventListener("input", renderManualTrackingRows);
  document.getElementById("refreshManualTrackingBtn").addEventListener("click", loadManualTracking);

  document.getElementById("selectAllManualTrackingBtn").addEventListener("click", () => {
    const checkboxes = document.querySelectorAll('#manualTrackingTableBody input[type="checkbox"]');
    const allSelected = checkboxes.length > 0 && Array.from(checkboxes).every((c) => c.checked);
    checkboxes.forEach((checkbox) => {
      checkbox.checked = !allSelected;
      const id = checkbox.dataset.selectManual;
      if (!allSelected) selectedManualTracking.add(id);
      else selectedManualTracking.delete(id);
    });
    updateManualTrackingBulkButtons();
  });

  document.getElementById("bulkSendTrackingBtn").addEventListener("click", async () => {
    const ids = Array.from(selectedManualTracking);
    const errors = [];
    for (const id of ids) {
      const order = manualTrackingOrders.find((o) => o.id === id);
      const trackingCode = order ? resolveManualTrackingCode(order) : null;
      if (!trackingCode) continue; // no code yet for this one — skip, not an error
      try {
        await api(`/${id}/tracking`, { method: "POST", body: JSON.stringify({ trackingCode }) });
      } catch (error) {
        errors.push(`${id}: ${error.message}`);
      }
    }
    selectedManualTracking.clear();
    await loadManualTracking();
    await refreshKpis();
    if (errors.length > 0) await showAlert(`Alguns pedidos falharam ao enviar:\n${errors.join("\n")}`);
  });

  document.getElementById("bulkArchiveManualBtn").addEventListener("click", async () => {
    const ids = Array.from(selectedManualTracking).filter(
      (id) => manualTrackingOrders.find((o) => o.id === id)?.status === "failed",
    );
    if (ids.length === 0) return;
    if (!(await showConfirm(`Remover ${ids.length} pedido(s) do painel? Use quando ja foram resolvidos inteiramente por fora.`))) return;
    const errors = [];
    for (const id of ids) {
      try {
        await api(`/${id}/archive`, { method: "POST" });
      } catch (error) {
        errors.push(`${id}: ${error.message}`);
      }
    }
    selectedManualTracking.clear();
    await loadManualTracking();
    await refreshKpis();
    if (errors.length > 0) await showAlert(`Alguns pedidos falharam ao remover:\n${errors.join("\n")}`);
  });
}

function renderKpis(pendingList, processingList) {
  document.getElementById("kpiPending").textContent = pendingList.length;
  document.getElementById("kpiProcessing").textContent = processingList.filter((o) => o.status !== "tracking_synced" && o.status !== "failed").length;
  document.getElementById("kpiCompleted").textContent = processingList.filter((o) => o.status === "tracking_synced").length;
  document.getElementById("kpiFailed").textContent = processingList.filter((o) => o.status === "failed").length;
}

// Used after actions that only touch one tab (approve, hold, archive, ...) —
// loadAll has its own cheaper path that reuses data it already fetched.
async function refreshKpis() {
  const [pending, processing] = await Promise.all([api("/pending"), api("/processing")]);
  renderKpis(pending.orders, processing.orders);
}

function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
      // Held is only kept fresh by the background poll while its tab is
      // active (see loadAll), so fetch once on first switch. Rastreio reuses
      // whatever /processing already has cached (refreshed every tick
      // regardless of tab) instead of fetching it a second time.
      if (btn.dataset.tab === "held") loadHeld();
      if (btn.dataset.tab === "manual-tracking") loadManualTracking(processingOrders);
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

// Runs the same catch-up reconciliation-cron does on its own schedule, on
// demand -- lets someone check for a fresh tracking code right now instead
// of waiting for the next scheduled tick.
function setupSyncNow() {
  const btn = document.getElementById("syncNowBtn");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = "Sincronizando...";
    try {
      await api("/reconciliation/run", { method: "POST" });
      await loadAll();
    } catch (error) {
      await showAlert(`Erro ao sincronizar: ${error.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
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
      await showAlert("Informe o motivo.");
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
      await showAlert(`Erro ao segurar pedidos: ${error.message}`);
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
      await showAlert("Informe o motivo.");
      return;
    }
    try {
      await api(`/${cancelTargetId}/cancel`, { method: "POST", body: JSON.stringify({ reason }) });
      dialog.close();
      await loadProcessing();
      await refreshKpis();
    } catch (error) {
      await showAlert(`Erro ao cancelar etiqueta: ${error.message}`);
    }
  });
}

function setupBulkPrint() {
  const btn = document.getElementById("bulkPrintBtn");
  btn.addEventListener("click", async () => {
    const orders = processingOrders.filter((o) => selectedProcessing.has(o.id));
    if (orders.length === 0) return;
    await openAllLabels(orders);
  });
}

function setupToolbar() {
  document.getElementById("pendingSearch").addEventListener("input", renderPendingRows);
  document.getElementById("releasedSearch").addEventListener("input", renderReleasedRows);
  document.getElementById("postedSearch").addEventListener("input", renderPostedRows);
  document.getElementById("heldSearch").addEventListener("input", renderHeldRows);

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

  document.getElementById("approveBtn").addEventListener("click", async () => {
    if (selectedPending.size === 0) return;
    const btn = document.getElementById("approveBtn");
    btn.disabled = true;
    try {
      const preview = await api("/approve-preview", {
        method: "POST",
        body: JSON.stringify({ ids: Array.from(selectedPending) }),
      });
      if (preview.sufficient === false) {
        const shortfall = preview.estimatedTotal - preview.balance;
        await showAlert(
          `Saldo insuficiente na Melhor Envio para emitir essas etiquetas.\n\n` +
            `Frete estimado: ${formatCurrency(preview.estimatedTotal, "BRL")}\n` +
            `Saldo disponivel: ${formatCurrency(preview.balance, "BRL")}\n` +
            `Falta: ${formatCurrency(shortfall, "BRL")}\n\n` +
            `Adicione credito antes de continuar.`,
        );
        return;
      }

      const problems = preview.problems || [];
      const blockingList = problems.filter((p) => p.blocking.length > 0);
      const warningList = problems.filter((p) => p.blocking.length === 0 && p.warnings.length > 0);

      // Missing CPF/CNPJ always fails the real purchase (no fallback exists
      // for it, unlike a missing quote) — refuse the whole batch rather
      // than approve orders that are guaranteed to land in "Falhou".
      if (blockingList.length > 0) {
        const lines = blockingList.map((p) => `#${p.orderNumber ?? p.id}: ${p.blocking.join("; ")}`);
        await showAlert(
          `${blockingList.length} pedido(s) certamente vao falhar se aprovados agora:\n\n${lines.join("\n")}\n\n` +
            `Corrija esses pedidos (ou tire da selecao) antes de emitir.`,
        );
        return;
      }

      // A missing quote is a softer signal — createCartStep still falls back
      // to the default service, so it might still work. Warn but let a
      // human decide instead of blocking outright.
      if (warningList.length > 0) {
        const lines = warningList.map((p) => `#${p.orderNumber ?? p.id}: ${p.warnings.join("; ")}`);
        const proceed = await showConfirm(
          `${warningList.length} pedido(s) sem cotacao de frete confirmada:\n\n${lines.join("\n")}\n\n` +
            `Podem cair no frete padrao ou falhar. Continuar mesmo assim?`,
        );
        if (!proceed) return;
      }

      document.getElementById("stockConfirmDialog").showModal();
    } catch (error) {
      // Best-effort check — if the preview itself fails (e.g. Melhor Envio
      // down), don't block approving; just skip straight to the stock dialog.
      console.error("approve-preview failed, proceeding without it:", error);
      document.getElementById("stockConfirmDialog").showModal();
    } finally {
      btn.disabled = false;
    }
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
      await showAlert(`Erro ao aprovar: ${error.message}`);
    }
  });
}

// Pending/processing feed the always-visible KPI row, so they're fetched
// every tick regardless of which tab is open. Held and Rastreio aren't part
// of the KPIs, so they're only fetched when their own tab is the one showing
// — no point re-downloading a table nobody is looking at every 30s.
async function loadAll() {
  try {
    const activeTab = document.querySelector(".tab-btn.active")?.dataset.tab;
    const tasks = [loadPending(), loadProcessing()];
    if (activeTab === "held") tasks.push(loadHeld());
    const [pendingList, processingList] = await Promise.all(tasks);
    // Depends on processingList, so it runs after — reuses it instead of
    // fetching /processing a second time.
    if (activeTab === "manual-tracking") await loadManualTracking(processingList);
    renderKpis(pendingList, processingList);
  } catch (error) {
    console.error(error);
  }
}

setupTabs();
setupLogin();
setupSyncNow();
setupHoldDialog();
setupBulkPrint();
setupManualTracking();
setupCancelLabelDialog();
setupStockConfirmDialog();
setupToolbar();
setInterval(() => {
  if (document.getElementById("mainContent").style.display !== "none") loadAll();
}, 60000);
