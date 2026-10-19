// Notes — Craft front-end. Vanilla ES-module, zero deps.
// Every mutation goes through /api/op (bus commands), so the tape, undo and
// agent proposals see exactly what the human sees.
//
// Editor generations (F4): `localRev` bumps on every keystroke, `sentRev`
// tracks the last generation successfully saved. They only differ while a
// save is in flight — exactly when the server must not clobber the textarea.

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let state = { notes: [], docVersion: 0, canUndo: false, canRedo: false };

/** The note id currently open in the editor. */
let activeId = null;

/** F4 edit generations (see header). */
let localRev = 0;
let sentRev = 0;

/** Editor layout: write | split | read (Ctrl+E cycles). */
let viewMode = "write";

/** Pending auto-save timer. */
let saveTimer = null;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

const noteList = $("#note-list");
const searchInput = $("#search");
const titleInput = $("#title-input");
const editor = $("#editor");
const editorBody = $("#n-body");
const preview = $("#preview");
const emptyState = $("#empty-state");
const editorDepth = $("#editor-depth");
const undoBtn = $("#undo");
const redoBtn = $("#redo");
const deleteBtn = $("#delete-note");
const exportBtn = $("#export");
const saveProjectBtn = $("#save-project");
const projectInput = $("#project-input");
const statusEl = $("#status");
const dotEl = $("#dot");
const metaEl = $("#meta");
const noteCountEl = $("#note-count");
const inspectorEl = $("#inspector");

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function apiFetch(path, options = {}) {
  const res = await fetch(path, options);
  return res.json();
}

async function op(name, params = {}, label) {
  return apiFetch("/api/op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, params, label }),
  });
}

// ---------------------------------------------------------------------------
// Lightweight Markdown renderer (kept from v1 — hardened, no external deps)
// ---------------------------------------------------------------------------

function renderMarkdown(src) {
  if (!src) return "";

  // Escape HTML entities first
  const esc = s => s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Process fenced code blocks before line-by-line
  src = src.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="lang-${esc(lang)}">${esc(code.trimEnd())}</code></pre>`;
  });

  const lines = src.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Already-processed HTML (fenced code blocks)
    if (line.startsWith("<pre>")) {
      out.push(line);
      i++;
      continue;
    }

    // Headings
    const hMatch = line.match(/^(#{1,3})\s+(.*)/);
    if (hMatch) {
      const level = hMatch[1].length;
      out.push(`<h${level}>${inlineMarkdown(hMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      out.push("<hr />");
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      out.push(`<blockquote><p>${inlineMarkdown(line.slice(2))}</p></blockquote>`);
      i++;
      continue;
    }

    // Unordered list
    if (/^[-*+]\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*+]\s/.test(lines[i] ?? "")) {
        items.push(`<li>${inlineMarkdown((lines[i] ?? "").slice(2))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i] ?? "")) {
        items.push(`<li>${inlineMarkdown((lines[i] ?? "").replace(/^\d+\.\s/, ""))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph
    const para = [];
    while (i < lines.length && (lines[i] ?? "").trim() !== "" && !isBlock(lines[i] ?? "")) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${inlineMarkdown(para.join(" "))}</p>`);
  }

  return out.join("\n");
}

function isBlock(line) {
  return (
    /^#{1,3}\s/.test(line) ||
    /^[-*+]\s/.test(line) ||
    /^\d+\.\s/.test(line) ||
    /^> /.test(line) ||
    /^---+$/.test(line.trim()) ||
    line.startsWith("<pre>")
  );
}

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function inlineMarkdown(raw) {
  // Escape BEFORE any markup is introduced, so user/agent text can never inject
  // HTML. Only http(s)/mailto links survive; anything else is left as text.
  let s = esc(raw);
  // code
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  // bold
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__(.+?)__/g, "<strong>$1</strong>");
  // italic
  s = s.replace(/\*(.+?)\*/g, "<em>$1</em>");
  s = s.replace(/_(.+?)_/g, "<em>$1</em>");
  // link (validate the scheme; &amp; must be decoded before testing)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, text, href) =>
    /^(https?:|mailto:)/i.test(href.replace(/&amp;/g, "&"))
      ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
      : match);
  return s;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function relativeDate(iso) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1)   return "just now";
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7)   return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function currentNote() {
  return state.notes.find(n => n.id === activeId) ?? null;
}

function renderNoteList() {
  const query = searchInput.value.trim().toLowerCase();
  const filtered = query
    ? state.notes.filter(n =>
        n.title.toLowerCase().includes(query) ||
        n.content.toLowerCase().includes(query)
      )
    : state.notes;

  noteCountEl.textContent = String(filtered.length);

  if (filtered.length === 0) {
    noteList.innerHTML = `<div class="c-help" style="padding:10px 12px;color:var(--c-faint);font-size:11.5px">${
      query ? "No notes match your search." : "No notes yet — Ctrl+N."
    }</div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  for (const note of filtered) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "c-row";
    row.dataset.id = note.id;
    if (note.id === activeId) row.setAttribute("aria-selected", "true");
    row.innerHTML =
      `<span class="c-row__title">${esc(note.title || "Untitled")}</span>` +
      `<span class="c-row__meta">` +
      `<span class="c-row__snippet">${esc(note.snippet || "No content")}</span>` +
      `<span class="c-row__time">${relativeDate(note.updatedAt)}</span>` +
      `</span>`;
    row.addEventListener("click", () => void openNote(note.id));
    frag.appendChild(row);
  }
  noteList.replaceChildren(frag);
}

function renderViewMode() {
  editorBody.dataset.mode = viewMode;
  for (const button of document.querySelectorAll("#view-seg button")) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === viewMode));
  }
  if (viewMode !== "write" && activeId) renderPreview();
}

function renderPreview() {
  // Preview shows the live textarea content, not the last saved copy.
  preview.innerHTML = renderMarkdown(editor.value);
}

function renderEditor(opts = {}) {
  const note = currentNote();

  if (!note) {
    emptyState.style.display = "";
    editorDepth.style.display = "none";
    titleInput.disabled = true;
    deleteBtn.disabled = true;
    activeId = null;
    inspectorEl.innerHTML =
      '<div class="c-section">Document</div>' +
      propRow("Notes", String(state.notes.length)) +
      propRow("Can undo", state.canUndo ? "yes" : "no") +
      '<div class="c-section">Shortcuts</div>' +
      helpBlock();
    return;
  }

  emptyState.style.display = "none";
  editorDepth.style.display = "";
  titleInput.disabled = false;
  deleteBtn.disabled = false;

  // Never clobber unsent typing: only take server text when every local edit
  // has been saved (F4). Otherwise a save round-trip can drop keystrokes.
  const clean = localRev === sentRev;
  if (clean && titleInput.value !== note.title) titleInput.value = note.title;
  if (clean && editor.value !== note.content) editor.value = note.content;

  renderViewMode();
  if (viewMode !== "write" && opts.switched) renderPreview();
  renderInspector(note);
}

function propRow(label, value) {
  return (
    `<div class="c-prop"><span class="c-prop__label">${esc(label)}</span>` +
    `<span class="c-prop__value">${value}</span></div>`
  );
}

function helpBlock() {
  return (
    '<div class="c-help">' +
    "<p><kbd>Ctrl</kbd>+<kbd>N</kbd> new · <kbd>Ctrl</kbd>+<kbd>E</kbd> layout</p>" +
    "<p><kbd>Ctrl</kbd>+<kbd>B</kbd> bold · <kbd>Ctrl</kbd>+<kbd>I</kbd> italic</p>" +
    "<p><kbd>Ctrl</kbd>+<kbd>K</kbd> commands · <kbd>Ctrl</kbd>+<kbd>S</kbd> save now</p>" +
    "</div>"
  );
}

function renderInspector(note) {
  const words = countWords(note.content);
  const chars = note.content.length;
  const position = state.notes.findIndex(n => n.id === note.id) + 1;
  inspectorEl.innerHTML =
    '<div class="c-section">Note</div>' +
    propRow("Position", `#${position}`) +
    propRow("Created", esc(shortDate(note.createdAt))) +
    propRow("Updated", esc(shortDate(note.updatedAt))) +
    propRow("Node", `<code>${esc(note.id)}</code>`) +
    '<div class="c-section">Metrics</div>' +
    propRow("Words", String(words)) +
    propRow("Characters", String(chars)) +
    propRow("Lines", String(note.content.split("\n").length)) +
    '<div class="c-section">Shortcuts</div>' +
    helpBlock();
}

function shortDate(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function countWords(text) {
  return (text ?? "").trim().split(/\s+/).filter(Boolean).length;
}

function renderToolbar() {
  undoBtn.disabled = !state.canUndo;
  redoBtn.disabled = !state.canRedo;
  renderMeta();
}

function renderMeta() {
  const note = currentNote();
  const words = note ? countWords(editor.value) : 0;
  metaEl.textContent = `${words} words · ${state.notes.length} note${state.notes.length !== 1 ? "s" : ""}`;
}

function render(opts = {}) {
  renderNoteList();
  renderEditor(opts);
  renderToolbar();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function setStatus(msg, duration = 2000) {
  statusEl.textContent = msg;
  if (duration > 0) setTimeout(() => { statusEl.textContent = "Ready"; }, duration);
}

function applyState(data) {
  if (!data.ok) {
    dotEl.classList.add("c-dot--err");
    setStatus(`Error: ${data.error?.message ?? "unknown"}`);
    return;
  }
  dotEl.classList.remove("c-dot--err");
  state = { notes: data.notes, docVersion: data.docVersion, canUndo: data.canUndo, canRedo: data.canRedo };
  // The active note may have vanished (undo of its creation, delete).
  if (activeId && !state.notes.find(n => n.id === activeId)) activeId = null;
  render();
}

async function refresh() {
  applyState(await apiFetch("/api/state"));
}

async function openNote(id) {
  // Pending edits belong to the note we're leaving; flush them first so they
  // aren't silently dropped when the editor is repointed.
  clearTimeout(saveTimer);
  if (activeId && activeId !== id) await flushSave().catch(() => {});
  activeId = id;
  localRev = 0;
  sentRev = 0;
  render({ switched: true });
  editor.focus();
}

async function createNote() {
  const data = await op("note.create", { title: "Untitled", content: "" }, "New note");
  applyState(data);
  if (data.ok && data.result?.id) await openNote(data.result.id);
  setStatus("Note created");
}

function scheduleSave() {
  localRev += 1;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 600);
}

async function flushSave() {
  if (!activeId) return;
  clearTimeout(saveTimer);
  const rev = localRev;
  // The note.update command coalesces a burst into one undo step server-side,
  // so no client-side key is needed.
  const data = await op("note.update", {
    id: activeId,
    title: titleInput.value,
    content: editor.value,
  }, "Edit note");
  applyState(data);
  // Only claim these edits are saved if no keystroke landed mid-flight.
  sentRev = Math.max(sentRev, rev);
  setStatus("Saved", 1200);
}

async function deleteNote() {
  if (!activeId) return;
  const note = currentNote();
  if (!confirm(`Delete "${note?.title || "this note"}"? This can be undone.`)) return;
  const data = await op("note.delete", { id: activeId }, "Delete note");
  activeId = null;
  applyState(data);
  setStatus("Note deleted");
}

// --- editor niceties ---------------------------------------------------------

function insertMarkdown(kind) {
  const target = editor;
  const start = target.selectionStart ?? 0;
  const end = target.selectionEnd ?? 0;
  const selected = target.value.slice(start, end);
  let prefix = "";
  let inner = selected;
  let suffix = "";

  switch (kind) {
    case "h2": prefix = "## "; break;
    case "bold": suffix = "**"; inner = inner || "bold"; break;
    case "italic": suffix = "*"; inner = inner || "italic"; break;
    case "code": suffix = "`"; inner = inner || "code"; break;
    case "ul": prefix = "- "; break;
    case "ol": prefix = "1. "; break;
    case "quote": prefix = "> "; break;
    case "snippet": prefix = "```\n"; suffix = "\n```"; break;
    case "link": {
      const link = inner || "https://";
      inner = `[${inner || "label"}](${link})`;
      break;
    }
    default: break;
  }

  target.setRangeText(prefix + inner + suffix, start, end, "end");
  target.focus();
  editor.dispatchEvent(new Event("input", { bubbles: false }));
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

$("#new-note").addEventListener("click", createNote);
$("#add-rail").addEventListener("click", createNote);

searchInput.addEventListener("input", renderNoteList);

titleInput.addEventListener("input", scheduleSave);

editor.addEventListener("input", () => {
  scheduleSave();
  if (viewMode === "split") renderPreview();
  renderMeta();
});

for (const button of document.querySelectorAll("#view-seg button")) {
  button.addEventListener("click", () => setViewMode(button.dataset.mode));
}

function setViewMode(mode) {
  if (!["write", "split", "read"].includes(mode)) return;
  if (mode !== "write") {
    clearTimeout(saveTimer);
    void flushSave().catch(() => {});
  }
  viewMode = mode;
  renderViewMode();
}

for (const button of document.querySelectorAll("#n-mod button")) {
  button.addEventListener("click", () => insertMarkdown(button.dataset.md));
}

async function undo() {
  clearTimeout(saveTimer);
  applyState(await apiFetch("/api/undo", { method: "POST" }));
  setStatus("Undone");
}

async function redo() {
  applyState(await apiFetch("/api/redo", { method: "POST" }));
  setStatus("Redone");
}

undoBtn.addEventListener("click", undo);
redoBtn.addEventListener("click", redo);

$("#palette").addEventListener("click", () => window.NucleusKit?.openPalette());
$("#tape-hint").addEventListener("click", () => setStatus("The tape scrubber sits at the bottom — every edit is one rewindable step."));

exportBtn.addEventListener("click", () => {
  window.location.href = "/api/export";
  setStatus("Exporting…");
});

deleteBtn.addEventListener("click", deleteNote);

saveProjectBtn.addEventListener("click", () => {
  window.location.href = "/api/project";
  setStatus("Saving project…");
});

projectInput.addEventListener("change", async () => {
  const file = projectInput.files[0];
  if (!file) return;
  const text = await file.text();
  const data = await apiFetch("/api/project", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: text,
  });
  activeId = null;
  titleInput.value = "";
  editor.value = "";
  applyState(data);
  setStatus("Project loaded");
  projectInput.value = "";
});

// Keyboard shortcuts
document.addEventListener("keydown", (event) => {
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
  if (mod && key === "n") { event.preventDefault(); void createNote(); }
  else if (mod && key === "z" && !event.shiftKey) { event.preventDefault(); void undo(); }
  else if (mod && ((key === "z" && event.shiftKey) || key === "y")) { event.preventDefault(); void redo(); }
  else if (mod && key === "e") { event.preventDefault(); cycleViewMode(); }
  else if (mod && key === "s") { event.preventDefault(); setStatus("Saving…", 0); void flushSave(); }
  else if (mod && key === "b" && event.target === editor) { event.preventDefault(); insertMarkdown("bold"); }
  else if (mod && key === "i" && event.target === editor) { event.preventDefault(); insertMarkdown("italic"); }
  else if (event.key === "Escape" && !typing) {
    searchInput.focus();
  }
});

function cycleViewMode() {
  const order = ["write", "split", "read"];
  setViewMode(order[(order.indexOf(viewMode) + 1) % order.length]);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

void (async () => {
  viewMode = state.notes.length ? viewMode : "write";
  await refresh();
  if (state.notes.length > 0) await openNote(state.notes[0].id);
})();
