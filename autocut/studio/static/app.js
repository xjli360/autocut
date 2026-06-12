/* AutoCut Studio — edit video by editing its transcript */
"use strict";

const $ = (sel) => document.querySelector(sel);
const video = $("#video");

const state = {
  name: "",
  duration: 0,
  segments: [], // {id, start, end, text, deleted}
  selected: new Set(),
  lastClicked: null,
  undo: [],
  redo: [],
  preview: true,
  saveTimer: null,
  pollTimer: null,
};

/* ---------- helpers ---------- */

function fmt(t) {
  t = Math.max(0, t);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function mergedDeletedRanges() {
  const spans = state.segments
    .filter((s) => s.deleted)
    .map((s) => [s.start, s.end])
    .sort((a, b) => a[0] - b[0]);
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

function renderTranscript() {
  const root = $("#transcript");
  root.innerHTML = "";
  for (const seg of state.segments) {
    const el = document.createElement("span");
    el.className = "sentence";
    el.dataset.id = seg.id;
    const tc = document.createElement("span");
    tc.className = "tc";
    tc.textContent = fmt(seg.start);
    el.appendChild(tc);
    el.appendChild(document.createTextNode(seg.text));
    root.appendChild(el);
    root.appendChild(document.createTextNode(" "));
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
  renderTimeline();
  renderStats();
  $("#btn-undo").disabled = state.undo.length === 0;
  $("#btn-redo").disabled = state.redo.length === 0;
}

function renderStats() {
  const deletedCount = state.segments.filter((s) => s.deleted).length;
  $("#stat-duration").innerHTML =
    `原片 ${fmt(state.duration)} · 成片 <b>${fmt(outputDuration())}</b>`;
  $("#stat-deleted").textContent =
    deletedCount > 0 ? `已删 ${deletedCount} 句` : "";
}

/* ---------- timeline ---------- */

function renderTimeline() {
  const blocks = $("#blocks");
  blocks.innerHTML = "";
  if (!state.duration) return;
  for (const seg of state.segments) {
    const el = document.createElement("div");
    el.className = "block" + (seg.deleted ? " deleted" : "");
    el.style.left = `${(seg.start / state.duration) * 100}%`;
    el.style.width = `${((seg.end - seg.start) / state.duration) * 100}%`;
    blocks.appendChild(el);
  }
}

function tickPlayhead() {
  if (state.duration) {
    $("#playhead").style.left =
      `${(video.currentTime / state.duration) * 100}%`;
    syncCurrentSentence();
    if (state.preview && !video.paused) skipDeleted();
    updateTimeDisplay();
  }
  requestAnimationFrame(tickPlayhead);
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
  state.undo.push({ before, after });
  state.redo = [];
  state.selected.clear();
  refreshClasses();
  scheduleSave();
}

function undo() {
  const op = state.undo.pop();
  if (!op) return;
  const byId = new Map(state.segments.map((s) => [s.id, s]));
  for (const [id, was] of Object.entries(op.before)) {
    byId.get(Number(id)).deleted = was;
  }
  state.redo.push(op);
  refreshClasses();
  scheduleSave();
}

function redo() {
  const op = state.redo.pop();
  if (!op) return;
  const byId = new Map(state.segments.map((s) => [s.id, s]));
  for (const id of Object.keys(op.before)) {
    byId.get(Number(id)).deleted = op.after;
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
    await api("PUT", "/api/segments", { deleted_ids });
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

  $("#timeline").addEventListener("click", (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    video.currentTime = ((e.clientX - r.left) / r.width) * state.duration;
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
  const project = await api("GET", "/api/project");
  state.name = project.name;
  state.duration = project.duration;
  state.segments = project.segments || [];
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
