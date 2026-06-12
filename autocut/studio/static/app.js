/* AutoCut Studio — edit video by editing its transcript */
"use strict";

const $ = (sel) => document.querySelector(sel);
const video = $("#video");

const MIN_GAP_SHOW = 0.3; // gaps shorter than this are not worth cutting

const state = {
  name: "",
  duration: 0,
  segments: [], // {id, start, end, text, deleted}
  deletedGaps: new Set(), // "head" | "tail" | id of the sentence before the gap
  selected: new Set(),
  lastClicked: null,
  undo: [],
  redo: [],
  preview: true,
  showSubs: true,
  subStyle: null,
  saveTimer: null,
  styleTimer: null,
  pollTimer: null,
};

const DEFAULT_SUB_STYLE = {
  font: "PingFang SC",
  size: 4.5, // % of video height
  color: "#ffffff",
  stroke: "#141414",
  posv: 5, // offset from bottom, % of video height
};

/* ---------- helpers ---------- */

function fmt(t) {
  t = Math.max(0, t);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function gapList() {
  const segs = state.segments;
  const gaps = [];
  if (!segs.length) return gaps;
  if (segs[0].start > MIN_GAP_SHOW) {
    gaps.push({ key: "head", start: 0, end: segs[0].start });
  }
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i + 1].start - segs[i].end > MIN_GAP_SHOW) {
      gaps.push({
        key: String(segs[i].id),
        start: segs[i].end,
        end: segs[i + 1].start,
      });
    }
  }
  const last = segs[segs.length - 1];
  if (state.duration - last.end > MIN_GAP_SHOW) {
    gaps.push({ key: "tail", start: last.end, end: state.duration });
  }
  return gaps;
}

function mergedDeletedRanges() {
  const spans = state.segments
    .filter((s) => s.deleted)
    .map((s) => [s.start, s.end]);
  for (const g of gapList()) {
    if (state.deletedGaps.has(g.key)) spans.push([g.start, g.end]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of spans) {
    if (merged.length && a <= merged[merged.length - 1][1] + 0.01) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], b);
    } else {
      merged.push([a, b]);
    }
  }
  return merged;
}

function outputDuration() {
  const cut = mergedDeletedRanges().reduce((acc, [a, b]) => acc + (b - a), 0);
  return Math.max(0, state.duration - cut);
}

function mapToOutput(t) {
  let cutBefore = 0;
  for (const [a, b] of mergedDeletedRanges()) {
    if (t >= b) cutBefore += b - a;
    else if (t > a) cutBefore += t - a;
  }
  return t - cutBefore;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

/* ---------- transcript rendering ---------- */

function pauseChip(g) {
  const el = document.createElement("span");
  el.className = "pause";
  el.dataset.gap = g.key;
  el.dataset.tag = "pause-chip";
  const dur = (g.end - g.start).toFixed(1);
  el.title = `停顿 ${dur} 秒 · 点击剪掉/恢复`;
  el.textContent = `⏸ ${dur}s`;
  return el;
}

function renderTranscript() {
  const root = $("#transcript");
  root.innerHTML = "";
  const gapAfter = new Map(gapList().map((g) => [g.key, g]));
  if (gapAfter.has("head")) {
    root.appendChild(pauseChip(gapAfter.get("head")));
    root.appendChild(document.createTextNode(" "));
  }
  for (const seg of state.segments) {
    const el = document.createElement("span");
    el.className = "sentence";
    el.dataset.id = seg.id;
    el.dataset.tag = "sentence";
    const tc = document.createElement("span");
    tc.className = "tc";
    tc.textContent = fmt(seg.start);
    el.appendChild(tc);
    el.appendChild(document.createTextNode(seg.text));
    root.appendChild(el);
    root.appendChild(document.createTextNode(" "));
    const g = gapAfter.get(String(seg.id));
    if (g) {
      root.appendChild(pauseChip(g));
      root.appendChild(document.createTextNode(" "));
    }
  }
  if (gapAfter.has("tail")) {
    root.appendChild(pauseChip(gapAfter.get("tail")));
  }
  refreshClasses();
}

function refreshClasses() {
  const byId = new Map(state.segments.map((s) => [s.id, s]));
  for (const el of document.querySelectorAll(".sentence")) {
    const seg = byId.get(Number(el.dataset.id));
    el.classList.toggle("deleted", !!seg.deleted);
    el.classList.toggle("selected", state.selected.has(seg.id));
  }
  for (const el of document.querySelectorAll(".pause")) {
    el.classList.toggle("deleted", state.deletedGaps.has(el.dataset.gap));
  }
  renderTimeline();
  renderStats();
  $("#btn-undo").disabled = state.undo.length === 0;
  $("#btn-redo").disabled = state.redo.length === 0;
}

function renderStats() {
  const deletedCount = state.segments.filter((s) => s.deleted).length;
  const gapCount = state.deletedGaps.size;
  $("#stat-duration").innerHTML =
    `原片 ${fmt(state.duration)} · 成片 <b>${fmt(outputDuration())}</b>`;
  const parts = [];
  if (deletedCount) parts.push(`已删 ${deletedCount} 句`);
  if (gapCount) parts.push(`${gapCount} 处停顿`);
  $("#stat-deleted").textContent = parts.join(" · ");
}

/* ---------- timeline ---------- */

function renderTimeline() {
  const blocks = $("#blocks");
  blocks.innerHTML = "";
  if (!state.duration) return;
  const place = (el, start, end) => {
    el.style.left = `${(start / state.duration) * 100}%`;
    el.style.width = `${((end - start) / state.duration) * 100}%`;
    blocks.appendChild(el);
  };
  for (const g of gapList()) {
    const el = document.createElement("div");
    el.className =
      "block gap" + (state.deletedGaps.has(g.key) ? " deleted" : "");
    el.dataset.kind = "gap";
    el.dataset.key = g.key;
    el.dataset.tag = "timeline-gap";
    el.title = `停顿 ${(g.end - g.start).toFixed(1)} 秒 · 双击剪掉/恢复`;
    place(el, g.start, g.end);
  }
  for (const seg of state.segments) {
    const el = document.createElement("div");
    el.className =
      "block" +
      (seg.deleted ? " deleted" : "") +
      (state.selected.has(seg.id) ? " sel" : "");
    el.dataset.kind = "seg";
    el.dataset.id = seg.id;
    el.dataset.tag = "timeline-sentence";
    el.title = `${seg.text}\n单击选中 · 双击删除/恢复`;
    place(el, seg.start, seg.end);
  }
}

function tickPlayhead() {
  if (state.duration) {
    $("#playhead").style.left =
      `${(video.currentTime / state.duration) * 100}%`;
    syncCurrentSentence();
    if (state.preview && !video.paused) skipDeleted();
    updateTimeDisplay();
    updateLiveSub();
  }
  requestAnimationFrame(tickPlayhead);
}

function updateLiveSub() {
  const el = $("#live-sub");
  const panelOpen = !$("#style-panel").classList.contains("hidden");
  if ((!state.showSubs && !panelOpen) || !state.segments.length) {
    el.classList.add("hidden");
    return;
  }
  const t = video.currentTime;
  let seg = state.segments.find(
    (s) => !s.deleted && t >= s.start && t < s.end
  );
  // while styling, always show a sample line so changes are visible anywhere
  if (!seg && panelOpen) seg = state.segments.find((s) => !s.deleted);
  if (!seg) {
    el.classList.add("hidden");
    return;
  }
  if (el.textContent !== seg.text) el.textContent = seg.text;
  // pin to the rendered video frame (the element letterboxes inside the wrap)
  const r = video.getBoundingClientRect();
  const w = $("#video-wrap").getBoundingClientRect();
  if (r.height < 40) {
    el.classList.add("hidden");
    return;
  }
  const st = state.subStyle || DEFAULT_SUB_STYLE;
  el.style.left = `${r.left - w.left}px`;
  el.style.width = `${r.width}px`;
  el.style.bottom = `${w.bottom - r.bottom + (r.height * st.posv) / 100}px`;
  el.style.fontSize = `${Math.max(12, (r.height * st.size) / 100)}px`;
  el.style.fontFamily = `"${st.font}", "PingFang SC", sans-serif`;
  el.style.color = st.color;
  const sc = st.stroke;
  el.style.textShadow =
    `0 0 3px ${sc}, 0 1px 3px ${sc}, 0 -1px 3px ${sc}, ` +
    `1px 0 3px ${sc}, -1px 0 3px ${sc}`;
  el.classList.remove("hidden");
}

/* ---------- subtitle style panel ---------- */

function syncStylePanel() {
  const st = state.subStyle;
  $("#ss-font").value = st.font;
  $("#ss-size").value = st.size;
  $("#ss-size-val").textContent = `${st.size}%`;
  $("#ss-color").value = st.color;
  $("#ss-stroke").value = st.stroke;
  $("#ss-posv").value = st.posv;
  $("#ss-posv-val").textContent = `${st.posv}%`;
  for (const sw of document.querySelectorAll("#ss-swatches i")) {
    sw.classList.toggle(
      "active",
      sw.dataset.c.toLowerCase() === (st.color || "").toLowerCase()
    );
  }
}

function toggleStylePanel(show) {
  const panel = $("#style-panel");
  const open = show ?? panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !open);
  $("#btn-style").classList.toggle("open", open);
}

function applyStyle(patch) {
  Object.assign(state.subStyle, patch);
  syncStylePanel();
  updateLiveSub();
  clearTimeout(state.styleTimer);
  state.styleTimer = setTimeout(
    () => api("PUT", "/api/style", state.subStyle),
    400
  );
}

function bindStylePanel() {
  $("#btn-style").addEventListener("click", () => toggleStylePanel());
  $("#ss-font").addEventListener("change", (e) =>
    applyStyle({ font: e.target.value })
  );
  $("#ss-size").addEventListener("input", (e) =>
    applyStyle({ size: parseFloat(e.target.value) })
  );
  $("#ss-color").addEventListener("input", (e) =>
    applyStyle({ color: e.target.value })
  );
  $("#ss-stroke").addEventListener("input", (e) =>
    applyStyle({ stroke: e.target.value })
  );
  $("#ss-posv").addEventListener("input", (e) =>
    applyStyle({ posv: parseFloat(e.target.value) })
  );
  $("#ss-swatches").addEventListener("click", (e) => {
    const c = e.target.dataset.c;
    if (c) applyStyle({ color: c });
  });
  $("#ss-reset").addEventListener("click", () =>
    applyStyle({ ...DEFAULT_SUB_STYLE })
  );
  document.addEventListener("click", (e) => {
    const panel = $("#style-panel");
    if (
      !panel.classList.contains("hidden") &&
      !panel.contains(e.target) &&
      !e.target.closest("#sub-control")
    ) {
      toggleStylePanel(false);
    }
  });
}

function skipDeleted() {
  const t = video.currentTime;
  for (const [a, b] of mergedDeletedRanges()) {
    if (t >= a - 0.02 && t < b - 0.03) {
      if (b >= state.duration - 0.05) {
        video.pause();
        video.currentTime = a > 0.05 ? a - 0.05 : 0;
      } else {
        video.currentTime = b + 0.01;
      }
      return;
    }
  }
}

let lastCurrentId = null;
function syncCurrentSentence() {
  const t = video.currentTime;
  let cur = null;
  for (const seg of state.segments) {
    if (t >= seg.start && t < seg.end) {
      cur = seg.id;
      break;
    }
  }
  if (cur === lastCurrentId) return;
  lastCurrentId = cur;
  for (const el of document.querySelectorAll(".sentence.current")) {
    el.classList.remove("current");
  }
  if (cur !== null) {
    const el = document.querySelector(`.sentence[data-id="${cur}"]`);
    if (el) {
      el.classList.add("current");
      const box = $("#transcript");
      const r = el.getBoundingClientRect();
      const br = box.getBoundingClientRect();
      if (r.top < br.top + 20 || r.bottom > br.bottom - 20) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  }
}

function updateTimeDisplay() {
  const cur = state.preview ? mapToOutput(video.currentTime) : video.currentTime;
  const total = state.preview ? outputDuration() : state.duration;
  $("#time-display").textContent = `${fmt(cur)} / ${fmt(total)}`;
}

/* ---------- editing ops (undo/redo) ---------- */

function applyOp(ids, after) {
  const byId = new Map(state.segments.map((s) => [s.id, s]));
  const before = {};
  let changed = false;
  for (const id of ids) {
    const seg = byId.get(id);
    if (!seg || seg.deleted === after) continue;
    before[id] = seg.deleted;
    seg.deleted = after;
    changed = true;
  }
  if (!changed) return;
  state.undo.push({ kind: "seg", before, after });
  state.redo = [];
  state.selected.clear();
  refreshClasses();
  scheduleSave();
}

function applyGapOp(keys, after) {
  const before = {};
  let changed = false;
  for (const key of keys) {
    const cur = state.deletedGaps.has(key);
    if (cur === after) continue;
    before[key] = cur;
    after ? state.deletedGaps.add(key) : state.deletedGaps.delete(key);
    changed = true;
  }
  if (!changed) return;
  state.undo.push({ kind: "gap", before, after });
  state.redo = [];
  refreshClasses();
  scheduleSave();
}

function setGap(key, deleted) {
  deleted ? state.deletedGaps.add(key) : state.deletedGaps.delete(key);
}

function undo() {
  const op = state.undo.pop();
  if (!op) return;
  if (op.kind === "gap") {
    for (const [key, was] of Object.entries(op.before)) setGap(key, was);
  } else {
    const byId = new Map(state.segments.map((s) => [s.id, s]));
    for (const [id, was] of Object.entries(op.before)) {
      byId.get(Number(id)).deleted = was;
    }
  }
  state.redo.push(op);
  refreshClasses();
  scheduleSave();
}

function redo() {
  const op = state.redo.pop();
  if (!op) return;
  if (op.kind === "gap") {
    for (const key of Object.keys(op.before)) setGap(key, op.after);
  } else {
    const byId = new Map(state.segments.map((s) => [s.id, s]));
    for (const id of Object.keys(op.before)) {
      byId.get(Number(id)).deleted = op.after;
    }
  }
  state.undo.push(op);
  refreshClasses();
  scheduleSave();
}

function scheduleSave() {
  $("#save-state").textContent = "保存中…";
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(async () => {
    const deleted_ids = state.segments.filter((s) => s.deleted).map((s) => s.id);
    await api("PUT", "/api/segments", {
      deleted_ids,
      deleted_gaps: [...state.deletedGaps],
    });
    $("#save-state").textContent = "已自动保存";
  }, 500);
}

/* ---------- selection ---------- */

function clickSentence(id, shift) {
  if (shift && state.lastClicked !== null) {
    const [a, b] = [
      Math.min(state.lastClicked, id),
      Math.max(state.lastClicked, id),
    ];
    for (const seg of state.segments) {
      if (seg.id >= a && seg.id <= b) state.selected.add(seg.id);
    }
  } else {
    if (state.selected.has(id) && state.selected.size === 1) {
      state.selected.clear();
    } else {
      state.selected.clear();
      state.selected.add(id);
    }
    state.lastClicked = id;
  }
  refreshClasses();
}

/* ---------- search ---------- */

function runSearch(q) {
  for (const el of document.querySelectorAll(".sentence.match")) {
    el.classList.remove("match");
  }
  if (!q) return;
  let first = null;
  for (const seg of state.segments) {
    if (seg.text.includes(q)) {
      const el = document.querySelector(`.sentence[data-id="${seg.id}"]`);
      el.classList.add("match");
      if (!first) first = el;
    }
  }
  if (first) first.scrollIntoView({ block: "center", behavior: "smooth" });
}

/* ---------- transcribe flow ---------- */

function showTranscribeOverlay(asr) {
  $("#overlay-transcribe").classList.remove("hidden");
  if (asr.state === "loading" || asr.state === "running") {
    $("#btn-transcribe").classList.add("hidden");
    $("#asr-progress").classList.remove("hidden");
    $("#asr-msg").textContent =
      asr.state === "loading"
        ? "正在加载 Paraformer 模型…（首次运行需下载，约 1GB）"
        : `正在识别语音…已用 ${Math.round(asr.elapsed)} 秒`;
  }
  if (asr.state === "error") {
    $("#btn-transcribe").classList.remove("hidden");
    $("#asr-progress").classList.add("hidden");
    $("#asr-error").classList.remove("hidden");
    $("#asr-error").textContent = asr.error;
  }
}

async function pollAsr() {
  const { asr } = await api("GET", "/api/status");
  if (asr.state === "done") {
    const project = await api("GET", "/api/project");
    state.segments = project.segments;
    $("#overlay-transcribe").classList.add("hidden");
    $("#btn-export").disabled = false;
    renderTranscript();
    return;
  }
  showTranscribeOverlay(asr);
  if (asr.state !== "error") setTimeout(pollAsr, 1000);
}

/* ---------- export flow ---------- */

function openExport() {
  $("#overlay-export").classList.remove("hidden");
  $("#export-progress").classList.add("hidden");
  $("#export-done").classList.add("hidden");
  $("#export-error").classList.add("hidden");
  $("#btn-export-start").disabled = false;
  // burning follows the player's subtitle toggle: WYSIWYG
  $("#burn-subs").checked = state.showSubs;
}

async function startExport() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const opts = {
    mode,
    bridge_gap: parseFloat($("#bridge-gap").value) || 1.0,
    srt: $("#export-srt").checked,
    burn_subs: $("#burn-subs").checked,
  };
  $("#btn-export-start").disabled = true;
  $("#export-progress").classList.remove("hidden");
  $("#export-error").classList.add("hidden");
  $("#export-msg").textContent = "正在导出…";
  await api("POST", "/api/export", opts);
  pollExport();
}

async function pollExport() {
  const { export: ex } = await api("GET", "/api/status");
  if (ex.state === "running") {
    $("#export-bar-fill").style.width = `${Math.round(ex.progress * 100)}%`;
    $("#export-msg").textContent = `正在导出… ${Math.round(ex.progress * 100)}%`;
    setTimeout(pollExport, 500);
  } else if (ex.state === "done") {
    $("#export-bar-fill").style.width = "100%";
    $("#export-progress").classList.add("hidden");
    $("#export-done").classList.remove("hidden");
    $("#export-path").textContent = ex.output;
  } else if (ex.state === "error") {
    $("#export-progress").classList.add("hidden");
    $("#export-error").classList.remove("hidden");
    $("#export-error").textContent = ex.error;
    $("#btn-export-start").disabled = false;
  }
}

/* ---------- wire up ---------- */

function bindEvents() {
  const transcript = $("#transcript");

  transcript.addEventListener("click", (e) => {
    const chip = e.target.closest(".pause");
    if (chip) {
      const key = chip.dataset.gap;
      applyGapOp([key], !state.deletedGaps.has(key));
      return;
    }
    const el = e.target.closest(".sentence");
    if (!el) return;
    const id = Number(el.dataset.id);
    clickSentence(id, e.shiftKey);
    if (!e.shiftKey) {
      // jump the playhead to the clicked sentence (CapCut behavior);
      // shift-click only extends the selection without seeking
      const seg = state.segments.find((s) => s.id === id);
      if (seg) video.currentTime = seg.start + 0.01;
    }
  });

  transcript.addEventListener("dblclick", (e) => {
    const el = e.target.closest(".sentence");
    if (!el) return;
    const seg = state.segments.find((s) => s.id === Number(el.dataset.id));
    if (seg) {
      video.currentTime = seg.start + 0.01;
      video.play();
    }
  });

  $("#btn-del").addEventListener("click", () =>
    applyOp([...state.selected], true)
  );
  $("#btn-restore").addEventListener("click", () =>
    applyOp([...state.selected], false)
  );
  $("#btn-undo").addEventListener("click", undo);
  $("#btn-redo").addEventListener("click", redo);

  $("#btn-play").addEventListener("click", togglePlay);
  video.addEventListener("play", () => ($("#btn-play").textContent = "❚❚"));
  video.addEventListener("pause", () => ($("#btn-play").textContent = "▶"));

  $("#preview-toggle").addEventListener("change", (e) => {
    state.preview = e.target.checked;
    $("#preview-badge").classList.toggle("hidden", !state.preview);
    updateTimeDisplay();
  });

  $("#sub-toggle-btn").addEventListener("click", () => {
    state.showSubs = !state.showSubs;
    $("#sub-control").classList.toggle("on", state.showSubs);
  });

  $("#timeline").addEventListener("click", (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    video.currentTime = ((e.clientX - r.left) / r.width) * state.duration;
  });

  // timeline blocks: click = select & seek, double-click = cut/restore
  $("#blocks").addEventListener("click", (e) => {
    const b = e.target.closest(".block");
    if (!b) return;
    e.stopPropagation();
    if (b.dataset.kind === "seg") {
      const id = Number(b.dataset.id);
      const seg = state.segments.find((s) => s.id === id);
      clickSentence(id, e.shiftKey);
      if (seg) video.currentTime = seg.start + 0.01;
      const sentEl = document.querySelector(`.sentence[data-id="${id}"]`);
      if (sentEl) sentEl.scrollIntoView({ block: "center", behavior: "smooth" });
    } else {
      const g = gapList().find((x) => x.key === b.dataset.key);
      if (g) video.currentTime = g.start + 0.01;
    }
  });
  $("#blocks").addEventListener("dblclick", (e) => {
    const b = e.target.closest(".block");
    if (!b) return;
    e.stopPropagation();
    if (b.dataset.kind === "seg") {
      const id = Number(b.dataset.id);
      const seg = state.segments.find((s) => s.id === id);
      if (seg) applyOp([id], !seg.deleted);
    } else {
      const key = b.dataset.key;
      applyGapOp([key], !state.deletedGaps.has(key));
    }
  });

  $("#search").addEventListener("input", (e) => runSearch(e.target.value.trim()));

  $("#btn-transcribe").addEventListener("click", async () => {
    await api("POST", "/api/transcribe");
    showTranscribeOverlay({ state: "loading", elapsed: 0 });
    setTimeout(pollAsr, 800);
  });

  $("#btn-export").addEventListener("click", openExport);
  $("#btn-export-close").addEventListener("click", () =>
    $("#overlay-export").classList.add("hidden")
  );
  $("#btn-export-start").addEventListener("click", startExport);
  $("#btn-reveal").addEventListener("click", () => api("POST", "/api/reveal"));
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener("change", () => {
      $("#gap-field").style.display =
        radio.value === "compact" && radio.checked ? "flex" : "none";
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    const meta = e.metaKey || e.ctrlKey;
    if (e.code === "Space") {
      e.preventDefault();
      togglePlay();
    } else if ((e.key === "Backspace" || e.key === "Delete") && !meta) {
      e.preventDefault();
      applyOp([...state.selected], true);
    } else if (meta && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    } else if (e.key === "Escape") {
      if (!$("#style-panel").classList.contains("hidden")) {
        toggleStylePanel(false);
        return;
      }
      state.selected.clear();
      refreshClasses();
    } else if (e.key === "ArrowLeft") {
      video.currentTime = Math.max(0, video.currentTime - 3);
    } else if (e.key === "ArrowRight") {
      video.currentTime = Math.min(state.duration, video.currentTime + 3);
    }
  });
}

function togglePlay() {
  if (video.paused) {
    if (state.preview) skipDeleted();
    video.play();
  } else {
    video.pause();
  }
}

async function init() {
  bindEvents();
  bindStylePanel();
  const project = await api("GET", "/api/project");
  state.name = project.name;
  state.duration = project.duration;
  state.segments = project.segments || [];
  state.deletedGaps = new Set(project.deleted_gaps || []);
  state.subStyle = { ...DEFAULT_SUB_STYLE, ...(project.sub_style || {}) };
  syncStylePanel();
  $("#sub-control").classList.toggle("on", state.showSubs);
  $("#filename").textContent = project.name;
  document.title = `${project.name} — AutoCut Studio`;

  if (state.segments.length) {
    $("#btn-export").disabled = false;
    renderTranscript();
  } else {
    showTranscribeOverlay(project.asr);
    if (project.asr.state === "loading" || project.asr.state === "running") {
      setTimeout(pollAsr, 1000);
    }
  }
  renderStats();
  requestAnimationFrame(tickPlayhead);
}

init();
