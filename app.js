const STORAGE_KEY = "japan-40th-data-v4";
const START_DATE = "2026-05-25";
const END_DATE = "2026-06-10";

const CATEGORIES = [
  { value: "", label: "None" },
  { value: "transportation", label: "Transport" },
  { value: "lodging", label: "Lodging" },
  { value: "activity", label: "Activity" },
  { value: "lunch", label: "Lunch" },
  { value: "dinner", label: "Dinner" },
];

const SAMPLE_DATA = { days: {} };

const DATES = generateDates(START_DATE, END_DATE);
let state = loadState();
let expandedId = null;
let editingId = null;
let editBuffer = null;
let flashTimeout;
let saveDebounceTimer;
let lastScrolledDate = null;

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
      if (!parsed.notes) parsed.notes = {};
      if (!parsed.timeFormat) parsed.timeFormat = "24h";
      return parsed;
    }
  } catch {}
  const fresh = structuredClone(SAMPLE_DATA);
  fresh.notes = {};
  fresh.timeFormat = "24h";
  return fresh;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  flashSaved();
}

function debouncedSave() {
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(saveState, 250);
}

function commit() {
  saveState();
  renderDay();
}

function flashSaved() {
  const ind = document.querySelector("#save-indicator");
  ind.textContent = "Saved";
  ind.classList.add("visible");
  clearTimeout(flashTimeout);
  flashTimeout = setTimeout(() => ind.classList.remove("visible"), 1200);
}

function formatTime(time, format) {
  if (!time) return "--:--";
  if (format === "12h") {
    const [hStr, mStr] = time.split(":");
    let h = parseInt(hStr, 10);
    const period = h >= 12 ? "pm" : "am";
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${mStr}${period}`;
  }
  return time;
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

function dayRows(date) {
  return state.days[date] || [];
}

function getRows(date) {
  return dayRows(date).slice().sort((a, b) => {
    const at = a.time || "99:99";
    const bt = b.time || "99:99";
    return at.localeCompare(bt);
  });
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
  renderDayStrip();
  renderDay();
}

function renderDayStrip() {
  const strip = document.querySelector("#day-strip");
  strip.innerHTML = "";
  const today = currentDate();
  for (const date of DATES) {
    const { dow, day, mon } = formatChip(date);
    const btn = document.createElement("button");
    btn.className = "day-chip" + (date === today ? " active" : "");
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
  for (const row of getRows(date)) {
    list.appendChild(renderRow(row, date));
  }
  // Editing a not-yet-saved new row: it isn't in state.days, so append its form at the end.
  if (editingId && editBuffer && !dayRows(date).some(r => r.id === editingId)) {
    list.appendChild(renderEditingRow(date));
  }
  const addBtn = document.createElement("button");
  addBtn.className = "add-row";
  addBtn.textContent = "+ Add row";
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
  ta.placeholder = "Notes for the day — what's the plan?";
  ta.value = (state.notes && state.notes[date]) || "";
  ta.rows = 1;
  ta.addEventListener("input", () => {
    if (!state.notes) state.notes = {};
    state.notes[date] = ta.value;
    autoResize(ta);
    debouncedSave();
  });
  wrapper.appendChild(ta);
  requestAnimationFrame(() => autoResize(ta));
}

function renderRow(row, date) {
  if (editingId === row.id) return renderEditingRow(date);

  const el = document.createElement("div");
  el.dataset.id = row.id;
  el.className = "row fmt-" + state.timeFormat;
  if (row.category) el.classList.add("cat-" + row.category);
  if (row.highlight) el.classList.add("hl-" + row.highlight);

  const isExpanded = expandedId === row.id;
  if (isExpanded) el.classList.add("expanded");

  const badge = row.category ? `<span class="cat-badge cat-${row.category}">${categoryLabel(row.category)}</span>` : "";
  el.innerHTML = `
    <div class="row-time">${formatTime(row.time, state.timeFormat)}</div>
    <div class="row-info">
      <div class="row-title">${badge}${escapeHtml(row.title || "(untitled)")}</div>
      ${row.description ? `<div class="row-desc">${escapeHtml(row.description)}</div>` : ""}
      ${isExpanded ? `<div class="row-actions"><button type="button" class="edit-btn">Edit</button></div>` : ""}
    </div>
  `;

  el.onclick = (e) => {
    if (e.target.classList.contains("edit-btn")) {
      enterEdit(row);
      return;
    }
    if (isExpanded) return;
    expandedId = row.id;
    renderDay();
  };

  return el;
}

function renderEditingRow(date) {
  const el = document.createElement("div");
  el.className = "row editing fmt-" + state.timeFormat;
  el.dataset.id = editingId;
  el.innerHTML = renderEditForm(editBuffer, dayRows(date).some(r => r.id === editingId));
  wireEditForm(el, date);
  return el;
}

function enterEdit(row) {
  editingId = row.id;
  editBuffer = structuredClone(row);
  expandedId = null;
  renderDay();
}

function exitEdit() {
  editingId = null;
  editBuffer = null;
}

function renderEditForm(buf, isExisting) {
  const cat = buf.category || "";
  const hl = buf.highlight || "none";
  return `
    <div class="form">
      <label>Time
        <input type="time" data-field="time" value="${buf.time || ""}">
      </label>
      <label>Title
        <input type="text" data-field="title" value="${escapeHtml(buf.title || "")}" placeholder="What's happening">
      </label>
      <label>Description
        <textarea data-field="description" rows="3" placeholder="Details, reservation #, notes">${escapeHtml(buf.description || "")}</textarea>
      </label>
      <label>Category
        <div class="cat-picker">
          ${CATEGORIES.map((c) => `
            <button type="button" class="cat-btn cat-${c.value || "none"}${cat === c.value ? " selected" : ""}" data-cat="${c.value}">${c.label}</button>
          `).join("")}
        </div>
      </label>
      <label>Highlight
        <div class="hl-picker">
          ${["none", "green", "yellow", "red"].map((c) => `
            <button type="button" class="hl-btn hl-${c}${hl === c ? " selected" : ""}" data-hl="${c}" aria-label="${c}"></button>
          `).join("")}
        </div>
      </label>
      <div class="form-actions">
        ${isExisting ? `<button type="button" class="delete-btn">Delete</button>` : ""}
        <button type="button" class="cancel-btn">Cancel</button>
        <button type="button" class="save-btn">Save</button>
      </div>
    </div>
  `;
}

function wireEditForm(el, date) {
  el.querySelectorAll("[data-field]").forEach((input) => {
    const field = input.dataset.field;
    input.addEventListener("input", () => {
      editBuffer[field] = input.value;
    });
  });
  el.querySelectorAll(".cat-btn").forEach((btn) => {
    btn.onclick = () => {
      editBuffer.category = btn.dataset.cat || null;
      renderDay();
    };
  });
  el.querySelectorAll(".hl-btn").forEach((btn) => {
    btn.onclick = () => {
      editBuffer.highlight = btn.dataset.hl === "none" ? null : btn.dataset.hl;
      renderDay();
    };
  });
  el.querySelector(".save-btn").onclick = () => {
    const cleaned = structuredClone(editBuffer);
    if (!cleaned.category) delete cleaned.category;
    if (!cleaned.highlight) delete cleaned.highlight;
    if (!state.days[date]) state.days[date] = [];
    const idx = state.days[date].findIndex(r => r.id === editingId);
    if (idx >= 0) state.days[date][idx] = cleaned;
    else state.days[date].push(cleaned);
    const id = editingId;
    exitEdit();
    expandedId = id;
    commit();
  };
  el.querySelector(".cancel-btn").onclick = () => {
    exitEdit();
    renderDay();
  };
  el.querySelector(".delete-btn")?.addEventListener("click", () => {
    removeRow(date, editingId);
    exitEdit();
    commit();
  });
}

function addRow(date) {
  const id = Math.random().toString(36).slice(2, 10);
  editingId = id;
  editBuffer = { id, time: "", title: "", description: "", category: null, highlight: null };
  expandedId = null;
  renderDay();
}

document.addEventListener("click", (e) => {
  if (e.target.closest(".row, .day-chip, #time-format-toggle, .add-row")) return;
  if (expandedId === null) return;
  expandedId = null;
  renderDay();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (editingId) {
    document.querySelector(".cancel-btn")?.click();
  } else if (expandedId) {
    expandedId = null;
    renderDay();
  }
});

window.addEventListener("hashchange", () => {
  expandedId = null;
  exitEdit();
  render();
});

function setupTimeFormatToggle() {
  const btn = document.querySelector("#time-format-toggle");
  const sync = () => { btn.textContent = state.timeFormat === "12h" ? "12h" : "24h"; };
  btn.onclick = () => {
    state.timeFormat = state.timeFormat === "12h" ? "24h" : "12h";
    sync();
    saveState();
    renderDay();
  };
  sync();
}
setupTimeFormatToggle();

const initialHash = location.hash.slice(2);
if (!DATES.includes(initialHash)) {
  const todayStr = toIsoDate(new Date());
  let initial;
  if (todayStr < START_DATE) initial = START_DATE;
  else if (todayStr > END_DATE) initial = END_DATE;
  else initial = todayStr;
  location.hash = "#/" + initial;
} else {
  render();
}
