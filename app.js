const STORAGE_KEY = "japan-40th-data-v4";
const TIME_FORMAT_KEY = "japan-40th-time-format";
const START_DATE = "2026-05-25";
const END_DATE = "2026-06-10";

// Clicks on these selectors don't collapse an expanded row.
const COLLAPSE_IGNORE = ".row, .day-chip, .header-button, .add-row";

const CATEGORIES = [
  { value: "", label: "None" },
  { value: "transportation", label: "Transport" },
  { value: "lodging", label: "Lodging" },
  { value: "activity", label: "Activity" },
  { value: "lunch", label: "Lunch" },
  { value: "dinner", label: "Dinner" },
];

const HIGHLIGHTS = ["green", "yellow", "red"];

const SAMPLE_DATA = { days: {} };

const DATES = generateDates(START_DATE, END_DATE);
let state = loadState();
let expandedId = null;
let editingId = null;
let editBuffer = null;
let flashTimeout;
let lastScrolledDate = null;
let editFetchTargetId = null;
let highlightFilter = null;
// Lets a click in the category view jump to a day with that row already
// expanded — without it, the hashchange listener would clear expandedId.
let pendingExpandId = null;

function parseDate(date) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function stripContinuation(obj) {
  delete obj._continuation;
  delete obj._sourceDate;
  delete obj._displayTime;
}

function generateDates(start, end) {
  const dates = [];
  const d = parseDate(start);
  const last = parseDate(end);
  while (d <= last) {
    dates.push(toIsoDate(d));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Migrate old in-state timeFormat to the dedicated per-device key
      if (parsed.timeFormat && !localStorage.getItem(TIME_FORMAT_KEY)) {
        localStorage.setItem(TIME_FORMAT_KEY, parsed.timeFormat);
      }
      return normalizeState(parsed);
    }
  } catch {}
  return normalizeState(structuredClone(SAMPLE_DATA));
}

function persistLocal() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function getTimeFormat() {
  return localStorage.getItem(TIME_FORMAT_KEY) || "24h";
}

function saveState() {
  persistLocal();
  flashSaved("Saved");
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncToRemote, 800);
}

function commit() {
  saveState();
  rerender();
}

function flashSaved(msg = "Saved") {
  const ind = document.querySelector("#save-indicator");
  ind.textContent = msg;
  ind.classList.add("visible");
  clearTimeout(flashTimeout);
  flashTimeout = setTimeout(() => ind.classList.remove("visible"), 1500);
}

// === Sync (JSONbin) ===

const BIN_ID_KEY = "japan-40th-bin-id";
const MASTER_KEY_KEY = "japan-40th-master-key";
const JSONBIN_BASE = "https://api.jsonbin.io/v3";

let syncTimer;
let syncController;

function getCreds() {
  return {
    binId: localStorage.getItem(BIN_ID_KEY),
    key: localStorage.getItem(MASTER_KEY_KEY),
  };
}

function hasCreds() {
  const { binId, key } = getCreds();
  return !!(binId && key);
}

function clearCreds() {
  localStorage.removeItem(BIN_ID_KEY);
  localStorage.removeItem(MASTER_KEY_KEY);
}

function normalizeState(s) {
  if (!s.days) s.days = {};
  if (!s.notes) s.notes = {};
  return s;
}

async function binFetch(binId, key, signal) {
  const res = await fetch(`${JSONBIN_BASE}/b/${binId}/latest`, {
    headers: { "X-Master-Key": key },
    signal,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()).record;
}

async function binSave(binId, key, data, signal) {
  const res = await fetch(`${JSONBIN_BASE}/b/${binId}`, {
    method: "PUT",
    headers: { "X-Master-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify(data),
    signal,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

// Pull remote; if it has a valid state shape, adopt it. Otherwise push our state up.
async function adoptOrPush(binId, key, signal) {
  const remote = await binFetch(binId, key, signal);
  if (remote && typeof remote === "object" && remote.days) {
    state = normalizeState(remote);
    persistLocal();
  } else {
    await binSave(binId, key, state, signal);
  }
}

// Returns true if caller should bail (creds rejected or request superseded).
function handleSyncError(e, fallbackMsg) {
  if (e.name === "AbortError") return true;
  if (/^40[13]/.test(e.message)) {
    clearCreds();
    showSetup("Credentials rejected. Re-enter them.");
    return true;
  }
  flashSaved(fallbackMsg);
  return false;
}

function showSetup(msg) {
  document.body.classList.add("needs-setup");
  document.querySelector("#setup-error").textContent = msg || "";
}

function hideSetup() {
  document.body.classList.remove("needs-setup");
}

function wireSetup() {
  document.querySelector("#setup-form").onsubmit = async (e) => {
    e.preventDefault();
    const binId = document.querySelector("#setup-bin-id").value.trim();
    const key = document.querySelector("#setup-master-key").value.trim();
    if (!binId || !key) {
      showSetup("Both fields are required.");
      return;
    }
    try {
      await adoptOrPush(binId, key);
      localStorage.setItem(BIN_ID_KEY, binId);
      localStorage.setItem(MASTER_KEY_KEY, key);
      hideSetup();
      setupTimeFormatToggle();
      setupViewToggle();
      setupReloadButton();
      routeAndRender();
    } catch (err) {
      showSetup("Couldn't connect: " + err.message);
    }
  };
}

async function syncToRemote() {
  const { binId, key } = getCreds();
  if (!binId || !key) return;
  if (syncController) syncController.abort();
  syncController = new AbortController();
  flashSaved("Syncing…");
  try {
    await binSave(binId, key, state, syncController.signal);
    flashSaved("Synced");
  } catch (e) {
    handleSyncError(e, "Sync failed");
  }
}

async function syncFromRemote(failMsg) {
  const { binId, key } = getCreds();
  if (!binId || !key) return true;
  flashSaved("Syncing…");
  try {
    await adoptOrPush(binId, key);
    flashSaved("Synced");
    render();
    return true;
  } catch (e) {
    handleSyncError(e, failMsg);
    return false;
  }
}

// Flush any pending or in-flight save first — otherwise the pull would
// overwrite local-only changes (e.g. day-note typing in the debounce window)
// with stale remote data.
async function pullLatest(failMsg) {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
    await syncToRemote();
  }
  return syncFromRemote(failMsg);
}

// If the tab is closing within the 800ms debounce window, fire the pending
// PUT now with keepalive so the request survives unload (otherwise the save
// dies with the page and remote silently rolls back on next sync).
function flushPendingSync() {
  if (!syncTimer) return;
  clearTimeout(syncTimer);
  syncTimer = null;
  const { binId, key } = getCreds();
  if (!binId || !key) return;
  fetch(`${JSONBIN_BASE}/b/${binId}`, {
    method: "PUT",
    headers: { "X-Master-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify(state),
    keepalive: true,
  }).catch(() => {});
}

window.addEventListener("pagehide", flushPendingSync);

// DevTools escape hatch: window.resetSync() clears credentials and reloads.
window.resetSync = () => { clearCreds(); location.reload(); };

function formatTime(time, format) {
  if (!time) return `<span class="row-time-empty">—</span>`;
  const [hStr, mStr] = time.split(":");
  let h = parseInt(hStr, 10);
  if (format === "12h") {
    const period = h >= 12 ? "pm" : "am";
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${mStr}${period}`;
  }
  return `${h}:${mStr}`;
}

function autoResize(textarea) {
  if (!textarea) return;
  textarea.style.height = "auto";
  textarea.style.height = textarea.scrollHeight + "px";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function categoryLabel(value) {
  return CATEGORIES.find(c => c.value === value)?.label || "";
}

function currentDate() {
  const hash = location.hash.slice(2);
  return DATES.includes(hash) ? hash : DATES[0];
}

function isCategoryView() {
  return location.hash === "#/all";
}

function dayRows(date) {
  return state.days[date] || [];
}

function getRows(date) {
  const own = dayRows(date).slice();
  const continuations = [];
  for (const src in state.days) {
    if (src >= date) continue;
    for (const row of state.days[src]) {
      if (row.category !== "lodging") continue;
      if (!row.endDate || row.endDate < date) continue;
      continuations.push({
        ...row,
        _continuation: true,
        _sourceDate: src,
        _displayTime: row.endDate === date ? (row.endTime || "") : "",
      });
    }
  }
  return [...own, ...continuations].sort((a, b) =>
    ((a._displayTime ?? a.time) || "").localeCompare((b._displayTime ?? b.time) || "")
  );
}

function removeRow(date, id) {
  if (state.days[date]) {
    state.days[date] = state.days[date].filter(r => r.id !== id);
  }
}

function formatDayTitle(date) {
  return parseDate(date).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
}

function formatChip(date) {
  const dt = parseDate(date);
  return {
    dow: dt.toLocaleDateString("en-US", { weekday: "short" }),
    day: dt.getDate(),
    mon: dt.toLocaleDateString("en-US", { month: "short" }),
  };
}

function render() {
  const inCat = isCategoryView();
  document.querySelector("#day-view").hidden = inCat;
  document.querySelector("#category-view").hidden = !inCat;
  document.querySelector("#day-strip").hidden = inCat;
  document.querySelector("#view-toggle").textContent = inCat ? "Category" : "Daily";
  if (inCat) {
    renderCategoryView();
  } else {
    renderDayStrip();
    renderDay();
  }
}

// Re-renders just the active view's row list — skips the day-strip and
// view-toggle update, which never change on row-only mutations.
function rerender() {
  if (isCategoryView()) renderCategoryView();
  else renderDay();
}

function pinHtml(location) {
  if (!location) return "";
  const href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
  return `<a class="row-pin" href="${href}" target="_blank" rel="noopener" aria-label="Open location in Google Maps" title="Open in Google Maps">📍</a>`;
}

function badgeHtml(category) {
  if (!category) return "";
  return `<span class="cat-badge cat-${category}">${categoryLabel(category)}</span>`;
}

function descHtml(text, isExpanded) {
  if (!text) return "";
  const inner = isExpanded
    ? text
    : text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).join(", ");
  return `<div class="row-desc">${escapeHtml(inner)}</div>`;
}

function actionsHtml(row, leading = "") {
  const editBtn = editFetchTargetId === row.id
    ? `<button type="button" class="button edit-button" disabled>Syncing…</button>`
    : `<button type="button" class="button edit-button">Edit</button>`;
  return `
    <div class="row-actions">
      ${leading}
      <button type="button" class="button copy-button" popovertarget="${copyMenuId(row)}">Copy</button>
      ${editBtn}
      ${renderCopyMenu(row)}
    </div>
  `;
}

function chipLabel(date) {
  const { dow, mon, day } = formatChip(date);
  return `${dow} ${mon} ${day}`;
}

function renderCategoryView() {
  renderHighlightFilter();
  renderCategoryList();
}

function renderHighlightFilter() {
  const bar = document.querySelector("#hl-filter-bar");
  bar.innerHTML = "";
  const options = [{ value: null, label: "All", cls: "hl-all" }];
  for (const hl of HIGHLIGHTS) {
    options.push({ value: hl, label: hl[0].toUpperCase() + hl.slice(1), cls: `hl-${hl}` });
  }
  for (const opt of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `button hl-filter ${opt.cls}` + (highlightFilter === opt.value ? " selected" : "");
    btn.textContent = opt.label;
    btn.onclick = () => {
      if (highlightFilter === opt.value) return;
      highlightFilter = opt.value;
      renderCategoryView();
    };
    bar.appendChild(btn);
  }
}

function renderCategoryList() {
  const list = document.querySelector("#category-list");
  list.innerHTML = "";

  const buckets = new Map();
  for (const c of CATEGORIES) if (c.value) buckets.set(c.value, []);
  buckets.set("", []);

  for (const date in state.days) {
    for (const row of state.days[date]) {
      if (highlightFilter && row.highlight !== highlightFilter) continue;
      buckets.get(row.category || "").push({ row, date });
    }
  }

  let hasAny = false;
  for (const [cat, items] of buckets) {
    if (!items.length) continue;
    hasAny = true;
    items.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return (a.row.time || "").localeCompare(b.row.time || "");
    });
    const section = document.createElement("section");
    section.className = "cat-section" + (cat ? ` cat-${cat}` : "");
    const label = cat ? categoryLabel(cat) : "Uncategorized";
    section.innerHTML = `<h3 class="cat-heading">${escapeHtml(label)} <span class="cat-count">${items.length}</span></h3>`;
    const rowsEl = document.createElement("div");
    rowsEl.className = "cat-rows";
    for (const { row, date } of items) rowsEl.appendChild(renderCategoryRow(row, date));
    section.appendChild(rowsEl);
    list.appendChild(section);
  }

  if (!hasAny) {
    const empty = document.createElement("p");
    empty.className = "cat-empty";
    empty.textContent = highlightFilter
      ? `No ${highlightFilter} rows yet.`
      : "No rows yet.";
    list.appendChild(empty);
  }
}

function renderCategoryRow(row, date) {
  if (editingId === row.id) return renderEditingRow(date);

  const el = document.createElement("div");
  el.className = "row cat-row fmt-" + getTimeFormat();
  if (row.category) el.classList.add("cat-" + row.category);
  if (row.highlight) el.classList.add("hl-" + row.highlight);
  el.dataset.id = row.id;

  const isExpanded = expandedId === row.id;
  if (isExpanded) el.classList.add("expanded");

  const time = row.time ? formatTime(row.time, getTimeFormat()) : "";
  const dateLabel = chipLabel(date) + (time ? ` · ${time}` : "");
  const jumpBtn = `<button type="button" class="button jump-button">Go to day</button>`;

  el.innerHTML = `
    <div class="row-info">
      <div class="cat-row-date">${dateLabel}</div>
      <div class="row-title">${badgeHtml(row.category)}${escapeHtml(row.title || "(untitled)")}</div>
      ${descHtml(row.description, isExpanded)}
    </div>
    ${pinHtml(row.location)}
    ${isExpanded ? actionsHtml(row, jumpBtn) : ""}
  `;

  el.onclick = (e) => {
    if (e.target.closest(".row-pin")) return;
    if (e.target.classList.contains("edit-button")) {
      enterEdit(row, date);
      return;
    }
    if (e.target.classList.contains("jump-button")) {
      pendingExpandId = row.id;
      location.hash = "#/" + date;
      return;
    }
    const copyTarget = e.target.closest(".copy-menu-item");
    if (copyTarget) {
      copyRowToDate(row, copyTarget.dataset.date);
      return;
    }
    if (isExpanded) return;
    expandedId = row.id;
    rerender();
  };

  return el;
}

function renderDayStrip() {
  const strip = document.querySelector("#day-strip");
  strip.innerHTML = "";
  const today = currentDate();
  for (const date of DATES) {
    const { dow, day, mon } = formatChip(date);
    const btn = document.createElement("button");
    btn.className = "button day-chip" + (date === today ? " active" : "");
    btn.innerHTML = `
      <span class="day-chip-dow">${dow}</span>
      <span class="day-chip-day">${day}</span>
      <span class="day-chip-mon">${mon}</span>
    `;
    btn.onclick = () => { location.hash = "#/" + date; };
    strip.appendChild(btn);
  }
  if (lastScrolledDate !== today) {
    const active = strip.querySelector(".day-chip.active");
    if (active) active.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    lastScrolledDate = today;
  }
}

function renderDay() {
  const date = currentDate();
  document.querySelector("#day-title").textContent = formatDayTitle(date);
  renderDayNote(date);

  const list = document.querySelector("#rows");
  list.innerHTML = "";
  const rows = getRows(date);
  for (const row of rows) {
    list.appendChild(renderRow(row, date));
  }
  // Editing a not-yet-saved new row: it isn't in state.days, so append its form at the end.
  if (editingId && editBuffer && !rows.some(r => r.id === editingId)) {
    list.appendChild(renderEditingRow(date));
  }
  const addBtn = document.createElement("button");
  addBtn.className = "button add-row";
  addBtn.textContent = "＋ Add row";
  addBtn.onclick = () => addRow(date);
  list.appendChild(addBtn);
}

function renderDayNote(date) {
  const wrapper = document.querySelector("#day-note-wrapper");
  // Skip rebuild when the date hasn't changed so the textarea keeps focus + caret across re-renders.
  if (wrapper.dataset.date === date) return;
  wrapper.dataset.date = date;
  wrapper.innerHTML = "";

  const ta = document.createElement("textarea");
  ta.className = "day-note";
  ta.placeholder = "Notes for the day — what’s the plan?";
  ta.value = (state.notes && state.notes[date]) || "";
  ta.rows = 1;
  ta.addEventListener("input", () => {
    if (!state.notes) state.notes = {};
    state.notes[date] = ta.value;
    autoResize(ta);
    saveState();
  });
  wrapper.appendChild(ta);
  requestAnimationFrame(() => autoResize(ta));
}

function renderRow(row, date) {
  if (editingId === row.id) return renderEditingRow(date);

  const el = document.createElement("div");
  el.dataset.id = row.id;
  el.className = "row fmt-" + getTimeFormat();
  if (row.category) el.classList.add("cat-" + row.category);
  if (row.highlight) el.classList.add("hl-" + row.highlight);

  const isExpanded = expandedId === row.id;
  if (isExpanded) el.classList.add("expanded");

  el.innerHTML = `
    <div class="row-time">${formatTime(row._displayTime ?? row.time, getTimeFormat())}</div>
    <div class="row-info">
      <div class="row-title">${badgeHtml(row.category)}${escapeHtml(row.title || "(untitled)")}</div>
      ${descHtml(row.description, isExpanded)}
    </div>
    ${pinHtml(row.location)}
    ${isExpanded ? actionsHtml(row) : ""}
  `;

  el.onclick = (e) => {
    if (e.target.closest(".row-pin")) return;
    if (e.target.classList.contains("edit-button")) {
      enterEdit(row, date);
      return;
    }
    const copyTarget = e.target.closest(".copy-menu-item");
    if (copyTarget) {
      copyRowToDate(row, copyTarget.dataset.date);
      return;
    }
    if (isExpanded) return;
    expandedId = row.id;
    rerender();
  };

  return el;
}

const copyMenuId = (row) => `copy-menu-${row.id}`;

function renderCopyMenu(row) {
  const items = DATES.map(d => {
    const { dow, day, mon } = formatChip(d);
    return `<button type="button" class="copy-menu-item" data-date="${d}">
      <span class="copy-menu-dow">${dow}</span>
      <span class="copy-menu-day">${mon} ${day}</span>
    </button>`;
  }).join("");
  return `<div class="copy-menu" id="${copyMenuId(row)}" popover="auto" role="menu">${items}</div>`;
}

function copyRowToDate(row, toDate) {
  const clone = structuredClone(row);
  clone.id = newId();
  stripContinuation(clone);
  if (!state.days[toDate]) state.days[toDate] = [];
  state.days[toDate].push(clone);
  document.getElementById(copyMenuId(row))?.hidePopover();
  commit();
  const { mon, day } = formatChip(toDate);
  flashSaved(`Copied to ${mon} ${day}`);
}

function renderEditingRow(date) {
  const el = document.createElement("div");
  el.className = "row editing fmt-" + getTimeFormat();
  el.dataset.id = editingId;
  const isExisting = !!(editBuffer._sourceDate && state.days[editBuffer._sourceDate]?.some(r => r.id === editingId));
  el.innerHTML = renderEditForm(editBuffer, isExisting);
  wireEditForm(el, date);
  return el;
}

async function enterEdit(row, viewDate) {
  if (editFetchTargetId) return;
  editFetchTargetId = row.id;
  const sourceDate = row._sourceDate || viewDate;
  rerender();
  try {
    if (hasCreds()) {
      // Pull latest before opening so the user's edits can't overwrite
      // a newer remote version, and re-find the row in the (possibly
      // replaced) state.
      const ok = await pullLatest("Sync failed — edit canceled");
      if (!ok) return;
      const fresh = dayRows(sourceDate).find(r => r.id === row.id);
      if (!fresh) {
        flashSaved("Row no longer exists");
        return;
      }
      row = fresh;
    }
    editingId = row.id;
    editBuffer = structuredClone(row);
    stripContinuation(editBuffer);
    editBuffer._sourceDate = sourceDate;
    editBuffer._startDate = sourceDate;
    expandedId = null;
  } finally {
    editFetchTargetId = null;
    rerender();
  }
}

function exitEdit() {
  editingId = null;
  editBuffer = null;
}

function renderEditForm(buf, isExisting) {
  const cat = buf.category || "";
  const hl = buf.highlight || "none";
  const startDate = buf._startDate || "";
  const startDt = startDate && buf.time ? `${startDate}T${buf.time}` : "";
  const endDt = buf.endDate && buf.endTime ? `${buf.endDate}T${buf.endTime}` : "";
  const isLodging = cat === "lodging";
  return `
    <form class="form">
      <label>Category
        <div class="cat-picker">
          ${CATEGORIES.map((c) => `
            <button type="button" class="button cat-button cat-${c.value || "none"}${cat === c.value ? " selected" : ""}" data-cat="${c.value}">${c.label}</button>
          `).join("")}
        </div>
      </label>
      <label>${isLodging ? "Check-in" : "Time"}
        <input class="input" type="datetime-local" data-field="start" value="${startDt}">
      </label>
      ${isLodging ? `
        <label>Check-out
          <input class="input" type="datetime-local" data-field="end" value="${endDt}"${startDt ? ` min="${startDt}"` : ""}>
        </label>
      ` : ""}
      <label>Title
        <input class="input" type="text" data-field="title" value="${escapeHtml(buf.title || "")}" placeholder="What’s happening?">
      </label>
      <label>Location
        <input class="input" type="text" data-field="location" value="${escapeHtml(buf.location || "")}" placeholder="Address or place name (optional)">
      </label>
      <label>Description
        <textarea class="input" data-field="description" rows="3" placeholder="Details, reservation #, notes…">${escapeHtml(buf.description || "")}</textarea>
      </label>
      <label>Highlight
        <div class="hl-picker">
          ${["none", ...HIGHLIGHTS].map((c) => `
            <button type="button" class="hl-button hl-${c}${hl === c ? " selected" : ""}" data-hl="${c}" aria-label="${c}"></button>
          `).join("")}
        </div>
      </label>
      <div class="form-actions">
        ${isExisting ? `<button type="button" class="button delete-button">Delete</button>` : ""}
        <button type="button" class="button cancel-button">Cancel</button>
        <button type="submit" class="button primary-button">Save</button>
      </div>
    </form>
  `;
}

function wireEditForm(el, date) {
  el.querySelectorAll("[data-field]").forEach((input) => {
    const field = input.dataset.field;
    if (field === "start") {
      input.addEventListener("input", () => {
        const v = input.value;
        if (!v) {
          editBuffer.time = "";
          if (editBuffer._sourceDate) editBuffer._startDate = editBuffer._sourceDate;
          return;
        }
        const [d, t] = v.split("T");
        editBuffer._startDate = d;
        editBuffer.time = t;
      });
    } else if (field === "end") {
      input.addEventListener("input", () => {
        const v = input.value;
        if (!v) {
          delete editBuffer.endDate;
          delete editBuffer.endTime;
          return;
        }
        const [d, t] = v.split("T");
        editBuffer.endDate = d;
        editBuffer.endTime = t;
      });
    } else {
      input.addEventListener("input", () => {
        editBuffer[field] = input.value;
      });
    }
  });
  el.querySelectorAll(".cat-button").forEach((btn) => {
    btn.onclick = () => {
      const next = btn.dataset.cat || null;
      if (editBuffer.category === next) return;
      editBuffer.category = next;
      if (next === "lodging" && !editBuffer.endDate) {
        editBuffer.endDate = editBuffer._startDate || editBuffer._sourceDate;
        editBuffer.endTime = nowHHMM();
      }
      rerender();
    };
  });
  el.querySelectorAll(".hl-button").forEach((btn) => {
    btn.onclick = () => {
      const next = btn.dataset.hl === "none" ? null : btn.dataset.hl;
      if (editBuffer.highlight === next) return;
      editBuffer.highlight = next;
      rerender();
    };
  });
  el.querySelector(".form").onsubmit = (e) => {
    e.preventDefault();
    const cleaned = structuredClone(editBuffer);
    const sourceDate = cleaned._sourceDate || date;
    const newDate = cleaned._startDate || sourceDate;
    delete cleaned._sourceDate;
    delete cleaned._startDate;
    if (!cleaned.category) delete cleaned.category;
    if (!cleaned.highlight) delete cleaned.highlight;
    if (!cleaned.location || !cleaned.location.trim()) delete cleaned.location;
    else cleaned.location = cleaned.location.trim();
    if (cleaned.category !== "lodging") {
      delete cleaned.endDate;
      delete cleaned.endTime;
    }
    if (state.days[sourceDate]) {
      state.days[sourceDate] = state.days[sourceDate].filter(r => r.id !== editingId);
    }
    if (!state.days[newDate]) state.days[newDate] = [];
    const idx = state.days[newDate].findIndex(r => r.id === editingId);
    if (idx >= 0) state.days[newDate][idx] = cleaned;
    else state.days[newDate].push(cleaned);
    const id = editingId;
    exitEdit();
    if (newDate !== sourceDate && !isCategoryView()) {
      // Date was changed — follow the row to its new home.
      location.hash = "#/" + newDate;
      saveState();
    } else {
      expandedId = id;
      commit();
    }
  };
  el.querySelector(".cancel-button").onclick = () => {
    exitEdit();
    rerender();
  };
  el.querySelector(".delete-button")?.addEventListener("click", () => {
    const label = editBuffer.title?.trim() || "this row";
    if (!confirm(`Delete ${label}?`)) return;
    const sourceDate = editBuffer._sourceDate || date;
    removeRow(sourceDate, editingId);
    exitEdit();
    commit();
  });
}

const newId = () => Math.random().toString(36).slice(2, 10);

function addRow(date) {
  const id = newId();
  editingId = id;
  editBuffer = {
    id, time: nowHHMM(),
    title: "", description: "", category: null, highlight: null,
    _sourceDate: date, _startDate: date,
  };
  expandedId = null;
  rerender();
}

document.addEventListener("click", (e) => {
  if (e.target.closest(COLLAPSE_IGNORE)) return;
  if (expandedId === null) return;
  expandedId = null;
  rerender();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  // Browser handles Escape for open popovers (light-dismiss); don't also collapse the row.
  if (document.querySelector(":popover-open")) return;
  if (editingId) {
    document.querySelector(".cancel-button")?.click();
  } else if (expandedId) {
    expandedId = null;
    rerender();
  }
});

window.addEventListener("hashchange", () => {
  expandedId = pendingExpandId;
  pendingExpandId = null;
  exitEdit();
  render();
});

function setupTimeFormatToggle() {
  const btn = document.querySelector("#time-format-toggle");
  const sync = () => { btn.textContent = getTimeFormat() === "12h" ? "12h" : "24h"; };
  btn.onclick = () => {
    localStorage.setItem(TIME_FORMAT_KEY, getTimeFormat() === "12h" ? "24h" : "12h");
    sync();
    rerender();
  };
  sync();
}

function setupViewToggle() {
  const btn = document.querySelector("#view-toggle");
  btn.onclick = () => {
    if (editingId) {
      flashSaved("Finish editing first");
      return;
    }
    if (isCategoryView()) {
      // Return to a sensible day: today (if in range) else trip start.
      const todayStr = toIsoDate(new Date());
      let target;
      if (todayStr < START_DATE) target = START_DATE;
      else if (todayStr > END_DATE) target = END_DATE;
      else target = todayStr;
      location.hash = "#/" + target;
    } else {
      location.hash = "#/all";
    }
  };
}

function setupReloadButton() {
  const btn = document.querySelector("#reload-button");
  btn.onclick = async () => {
    if (editingId) {
      flashSaved("Finish editing first");
      return;
    }
    btn.disabled = true;
    try {
      await pullLatest("Reload failed");
    } finally {
      btn.disabled = false;
    }
  };
}

function routeAndRender() {
  const initialHash = location.hash.slice(2);
  if (initialHash === "all" || DATES.includes(initialHash)) {
    render();
    return;
  }
  const todayStr = toIsoDate(new Date());
  let initial;
  if (todayStr < START_DATE) initial = START_DATE;
  else if (todayStr > END_DATE) initial = END_DATE;
  else initial = todayStr;
  location.hash = "#/" + initial;
  // hashchange listener will render
}

function setupOfflineBanner() {
  const banner = document.querySelector("#offline-banner");
  const sync = () => { banner.hidden = navigator.onLine; };
  window.addEventListener("online", sync);
  window.addEventListener("offline", sync);
  sync();
}

async function initApp() {
  setupTimeFormatToggle();
  setupViewToggle();
  setupReloadButton();
  setupOfflineBanner();
  routeAndRender(); // render cached state immediately so slow networks don't blank the screen
  await syncFromRemote("Offline — using cached data");
}

wireSetup();
if (hasCreds()) initApp();
else showSetup();
