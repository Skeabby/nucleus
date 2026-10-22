// Notes 2.0 — Craft front-end. Vanilla ES-module, zero deps.
// Every mutation goes through /api/op (bus commands), so the tape, undo and
// agent proposals see exactly what the human sees.
//
// Editor generations (F4): `localRev` bumps on every keystroke, `sentRev`
// tracks the last generation successfully saved. They only differ while a
// save is in flight — exactly when the server must not clobber the textarea.

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const EMPTY_STATS = { notes: 0, notebooks: 0, favorites: 0, pinned: 0, trashed: 0, tags: 0, words: 0 };

let state = {
  notes: [],
  notebooks: [],
  tags: [],
  stats: EMPTY_STATS,
  docVersion: 0,
  canUndo: false,
  canRedo: false,
};

/** The note id currently open in the editor. */
let activeId = null;

/** F4 edit generations (see header). */
let localRev = 0;
let sentRev = 0;

/** Editor layout: write | split | read (Ctrl+E cycles). */
let viewMode = "write";

/** Pending auto-save timer. */
let saveTimer = null;

/** Library filters. */
let scope = "all"; // all | favorites | trash
let notebookFilter = null; // notebook id, "unfiled", or null (no filter)
let tagFilter = null;
let sortMode = "updated";
let query = "";

/** Multi-select + bulk move mode. */
const selection = new Set();
let bulkMoveMode = false;
let lastClicked = null;

/** Quick-open overlay state. */
let quickIndex = 0;
let quickResults = [];

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

const noteList = $("#note-list");
const bookList = $("#notebook-list");
const tagList = $("#tag-list");
const searchInput = $("#search");
const searchClear = $("#search-clear");
const titleInput = $("#title-input");
const editor = $("#editor");
const editorBody = $("#n-body");
const preview = $("#preview");
const emptyState = $("#empty-state");
const editorDepth = $("#editor-depth");
const undoBtn = $("#undo");
const redoBtn = $("#redo");
const exportBtn = $("#export");
const saveProjectBtn = $("#save-project");
const projectInput = $("#project-input");
const statusEl = $("#status");
const dotEl = $("#dot");
const metaEl = $("#meta");
const noteCountEl = $("#note-count");
const scopeTitleEl = $("#scope-title");
const scopeSeg = $("#scope-seg");
const inspectorEl = $("#inspector");
const railStats = $("#rail-stats");
const bulkBar = $("#bulk-bar");
const bulkCount = $("#bulk-count");
const pinBtn = $("#pin-toggle");
const favBtn = $("#fav-toggle");
const noteBookSelect = $("#note-book");
const noteTagsEl = $("#note-tags");
const tagInput = $("#tag-input");
const noteUpdatedEl = $("#note-updated");
const editorCount = $("#editor-count");
const noteFootLeft = $("#note-foot-left");
const noteFootRight = $("#note-foot-right");
const sortSelect = $("#sort");
const quickOverlay = $("#quick");
const quickInput = $("#quick-input");
const quickListEl = $("#quick-list");
const clearTagBtn = $("#clear-tag");
const tagsSection = $("#tags-section");

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

/**
 * `/api/op` answers `{ ok, result: { result, applied, docVersion } }`: commands
 * carry their own `result` inside the invoke envelope. One place to unwrap it.
 */
function commandResult(data) {
  return data?.result?.result ?? data?.result ?? null;
}

// ---------------------------------------------------------------------------
// Lightweight Markdown renderer (no external deps, escape-first)
// ---------------------------------------------------------------------------

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
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__(.+?)__/g, "<strong>$1</strong>");
  s = s.replace(/~~(.+?)~~/g, "<del>$1</del>");
  s = s.replace(/\*(.+?)\*/g, "<em>$1</em>");
  s = s.replace(/(^|\s)_(.+?)_(\s|$)/g, "$1<em>$2</em>$3");
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, text, href) =>
    /^(https?:|mailto:)/i.test(href.replace(/&amp;/g, "&"))
      ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
      : match);
  return s;
}

function isBlock(line) {
  return (
    /^#{1,4}\s/.test(line) ||
    /^[-*+]\s/.test(line) ||
    /^\d+\.\s/.test(line) ||
    /^> /.test(line) ||
    /^---+$/.test(line.trim()) ||
    /^\|/.test(line) ||
    line.startsWith("<pre>")
  );
}

function renderMarkdown(src) {
  if (!src) return "";

  // Fenced code blocks first, protected from the line pass below.
  src = src.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
    `<pre data-lang="${esc(lang)}"><code>${esc(code.trimEnd())}</code></pre>`);

  const lines = src.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.startsWith("<pre")) {
      out.push(line);
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      out.push("<hr />");
      i++;
      continue;
    }

    // Table: | a | b | + | --- | --- |
    if (/^\|/.test(line) && /^\|[\s:|-]+\|?$/.test(lines[i + 1] ?? "")) {
      const cells = (row) => row.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i] ?? "")) {
        rows.push(cells(lines[i] ?? ""));
        i++;
      }
      out.push(
        `<table><thead><tr>${head.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead>` +
        `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`,
      );
      continue;
    }

    if (line.startsWith("> ")) {
      const quote = [];
      while (i < lines.length && (lines[i] ?? "").startsWith("> ")) {
        quote.push(inlineMarkdown((lines[i] ?? "").slice(2)));
        i++;
      }
      out.push(`<blockquote><p>${quote.join("<br />")}</p></blockquote>`);
      continue;
    }

    // Task list and bullet list share the same block.
    if (/^[-*+]\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*+]\s/.test(lines[i] ?? "")) {
        const body = (lines[i] ?? "").slice(2);
        const task = body.match(/^\[([ xX])\]\s*(.*)$/);
        if (task) {
          const checked = task[1].toLowerCase() === "x";
          items.push(
            `<li class="task"><input type="checkbox" disabled${checked ? " checked" : ""}>` +
            `<span>${inlineMarkdown(task[2])}</span></li>`,
          );
        } else {
          items.push(`<li>${inlineMarkdown(body)}</li>`);
        }
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i] ?? "")) {
        items.push(`<li>${inlineMarkdown((lines[i] ?? "").replace(/^\d+\.\s/, ""))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const para = [];
    while (i < lines.length && (lines[i] ?? "").trim() !== "" && !isBlock(lines[i] ?? "")) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${inlineMarkdown(para.join(" "))}</p>`);
  }

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Derived data
// ---------------------------------------------------------------------------

function liveNotes() {
  return state.notes.filter((note) => !note.trashedAt);
}

function matchesQuery(note, terms) {
  if (terms.length === 0) return true;
  const haystack = `${note.title}\n${note.content}\n${(note.tags ?? []).join(" ")}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function visibleNotes() {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  let list = scope === "trash" ? state.notes.filter((note) => note.trashedAt) : liveNotes();
  if (scope === "favorites") list = list.filter((note) => note.favorite);
  if (notebookFilter === "unfiled") list = list.filter((note) => !note.notebookId);
  else if (notebookFilter) list = list.filter((note) => note.notebookId === notebookFilter);
  if (tagFilter) list = list.filter((note) => (note.tags ?? []).includes(tagFilter));
  list = list.filter((note) => matchesQuery(note, terms));

  return [...list].sort((a, b) => {
    if (scope !== "trash") {
      const pinned = Number(b.pinned) - Number(a.pinned);
      if (pinned !== 0) return pinned;
    }
    if (sortMode === "title") return a.title.localeCompare(b.title);
    if (sortMode === "created") return b.createdAt.localeCompare(a.createdAt);
    return b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id);
  });
}

function currentNote() {
  return state.notes.find((note) => note.id === activeId) ?? null;
}

function notebookName(id) {
  return state.notebooks.find((book) => book.id === id)?.title ?? "Unfiled";
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function relativeDate(iso) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function shortDate(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function countWords(text) {
  return (text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/[#>*_~-]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
}

/** Escape, then wrap every search term in <mark>. */
function highlight(text, terms) {
  let html = esc(text);
  for (const term of terms) {
    if (!term) continue;
    const safe = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    html = html.replace(new RegExp(`(${safe})`, "gi"), "<mark>$1</mark>");
  }
  return html;
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
    "<p><kbd>Ctrl</kbd>+<kbd>N</kbd> note · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> notebook</p>" +
    "<p><kbd>Ctrl</kbd>+<kbd>P</kbd> quick open · <kbd>Ctrl</kbd>+<kbd>K</kbd> commands</p>" +
    "<p><kbd>Ctrl</kbd>+<kbd>D</kbd> duplicate · <kbd>Ctrl</kbd>+<kbd>E</kbd> layout</p>" +
    "<p><kbd>Ctrl</kbd>+<kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> All · Favorites · Trash</p>" +
    "</div>"
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderScopes() {
  for (const button of scopeSeg.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.scope === scope));
  }
  scopeTitleEl.textContent =
    scope === "trash" ? "Trash" : scope === "favorites" ? "Favorites" : "All notes";
  searchInput.placeholder =
    scope === "trash" ? "Search the trash…" : scope === "favorites" ? "Search favorites…" : "Search notes…";
}

function renderNotebooks() {
  const counts = new Map();
  for (const note of liveNotes()) {
    const key = note.notebookId ?? "unfiled";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const rows = [
    `<button class="n-book" data-book="unfiled" aria-current="${notebookFilter === "unfiled"}">` +
      `<span class="n-book__dot"></span><span class="n-book__name">Unfiled</span>` +
      `<span class="n-book__count">${counts.get("unfiled") ?? 0}</span></button>`,
  ];
  for (const book of state.notebooks) {
    rows.push(
      `<button class="n-book" data-book="${esc(book.id)}" aria-current="${notebookFilter === book.id}">` +
        `<span class="n-book__dot"></span>` +
        `<span class="n-book__name" title="Double-click to rename">${esc(book.title)}</span>` +
        `<span class="n-book__count">${book.noteCount}</span>` +
        `<span class="n-book__tools">` +
        `<span class="n-mini" data-book-rename="${esc(book.id)}" title="Rename">✎</span>` +
        `<span class="n-mini" data-book-delete="${esc(book.id)}" title="Delete notebook">×</span>` +
        `</span></button>`,
    );
  }
  bookList.innerHTML = rows.join("");
}

function renderTags() {
  if (state.tags.length === 0) {
    tagList.innerHTML = '<span class="n-foot-note">no tags yet — add one on a note</span>';
    clearTagBtn.hidden = true;
    return;
  }
  tagList.innerHTML = state.tags
    .map(
      (entry) =>
        `<button class="n-tag" data-tag="${esc(entry.tag)}" aria-pressed="${tagFilter === entry.tag}">` +
        `${esc(entry.tag)}<span class="n-tag__count">${entry.count}</span></button>`,
    )
    .join("");
  clearTagBtn.hidden = tagFilter === null;
}

function renderNoteList() {
  const notes = visibleNotes();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  noteCountEl.textContent = String(notes.length);

  if (notes.length === 0) {
    const message =
      query !== ""
        ? "Nothing matches your search."
        : scope === "trash"
          ? "The trash is empty."
          : scope === "favorites"
            ? "No favorites yet — press FAVORITE on a note."
            : notebookFilter || tagFilter
              ? "No note in this filter."
              : "No notes yet — Ctrl+N.";
    noteList.innerHTML = `<div class="c-help" style="padding:10px 12px;color:var(--c-faint);font-size:11.5px">${message}</div>`;
    return;
  }

  noteList.innerHTML = notes
    .map((note) => {
      const selected = selection.has(note.id) || note.id === activeId;
      const flags =
        (note.pinned ? '<span class="n-dot n-dot--pin">PIN</span>' : "") +
        (note.favorite ? '<span class="n-dot n-dot--fav">FAV</span>' : "");
      const tags = note.tags.length > 0 ? ` · ${note.tags.map((tag) => `#${tag}`).join(" ")}` : "";
      return (
        `<button class="c-row${note.trashedAt ? " is-trashed" : ""}${selection.has(note.id) ? " is-selected" : ""}"` +
        ` data-id="${esc(note.id)}" draggable="${!note.trashedAt}"` +
        ` role="option" aria-selected="${selected}">` +
        `<span class="c-row__check"></span>` +
        `<span class="c-row__title">${highlight(note.title || "Untitled", terms)}</span>` +
        `<span class="c-row__meta">` +
        `<span class="c-row__snippet">${highlight(note.snippet || "No content", terms)}${esc(tags)}</span>` +
        (flags ? `<span class="c-row__flags">${flags}</span>` : "") +
        `<span class="c-row__time">${relativeDate(note.trashedAt || note.updatedAt)}</span>` +
        `</span>` +
        `</button>`
      );
    })
    .join("");

  noteList.classList.toggle("n-selecting", selection.size > 0);
}

function renderBulkBar() {
  const count = selection.size;
  bulkBar.hidden = count === 0;
  if (count === 0) {
    bulkMoveMode = false;
    return;
  }
  bulkCount.textContent = `${count} selected`;
  for (const button of bulkBar.querySelectorAll("[data-bulk]")) {
    if (button.dataset.bulk === "trash") {
      button.textContent = scope === "trash" ? "Restore" : "Trash";
      button.hidden = false;
    }
    if (button.dataset.bulk === "move") button.hidden = scope === "trash";
  }
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

function renderEditor() {
  const note = currentNote();

  if (!note) {
    emptyState.style.display = "";
    editorDepth.hidden = true;
    activeId = null;
    renderInspector(null);
    return;
  }

  emptyState.style.display = "none";
  editorDepth.hidden = false;

  // Never clobber unsent typing: only take server text when every local edit
  // has been saved (F4). Otherwise a save round-trip can drop keystrokes.
  const clean = localRev === sentRev;
  if (clean && titleInput.value !== note.title) titleInput.value = note.title;
  if (clean && editor.value !== note.content) editor.value = note.content;

  titleInput.readOnly = Boolean(note.trashedAt);
  editor.readOnly = Boolean(note.trashedAt);

  pinBtn.setAttribute("aria-pressed", String(note.pinned));
  favBtn.setAttribute("aria-pressed", String(note.favorite));
  noteUpdatedEl.textContent = note.trashedAt
    ? `trashed ${relativeDate(note.trashedAt)}`
    : `edited ${relativeDate(note.updatedAt)}`;

  noteBookSelect.innerHTML =
    `<option value="">Unfiled</option>` +
    state.notebooks
      .map((book) => `<option value="${esc(book.id)}">${esc(book.title)}</option>`)
      .join("");
  noteBookSelect.value = note.notebookId ?? "";
  noteBookSelect.disabled = Boolean(note.trashedAt);

  noteTagsEl.innerHTML = note.tags
    .map(
      (tag) =>
        `<span class="n-tagchip">${esc(tag)}` +
        (note.trashedAt ? "" : `<button data-tagremove="${esc(tag)}" title="Remove tag">×</button>`) +
        `</span>`,
    )
    .join("");
  tagInput.hidden = Boolean(note.trashedAt);

  renderViewMode();
  renderCounts(note);
  renderInspector(note);
}

function renderCounts(note) {
  const words = countWords(editor.value);
  const reading = words === 0 ? 0 : Math.max(1, Math.round(words / 200));
  editorCount.textContent = `${words} words`;
  noteFootLeft.textContent = `${words} words · ${reading} min read · ${editor.value.length} chars`;
  noteFootRight.textContent = note.trashedAt ? "read-only (in trash)" : "autosaves · every edit is one step";
}

function renderInspector(note) {
  const stats = state.stats ?? EMPTY_STATS;
  const documentBlock =
    '<div class="c-section">Document</div>' +
    propRow("Notes", String(stats.notes)) +
    propRow("Notebooks", String(stats.notebooks)) +
    propRow("Favorites", String(stats.favorites)) +
    propRow("In trash", String(stats.trashed)) +
    propRow("Tags", String(stats.tags)) +
    propRow("Words", String(stats.words));

  if (!note) {
    inspectorEl.innerHTML =
      '<div class="c-section">Nothing open</div>' +
      propRow("Can undo", state.canUndo ? "yes" : "no") +
      documentBlock +
      '<div class="c-section">Shortcuts</div>' +
      helpBlock();
    return;
  }

  const actions = note.trashedAt
    ? '<div class="n-actions">' +
      '<button class="c-btn" data-act="restore">Restore</button>' +
      '<button class="c-btn c-btn--danger" data-act="purge">Delete forever</button>' +
      "</div>"
    : '<div class="n-actions">' +
      '<button class="c-btn" data-act="duplicate">Duplicate</button>' +
      '<button class="c-btn" data-act="trash">Move to trash</button>' +
      "</div>";

  inspectorEl.innerHTML =
    '<div class="c-section">Note</div>' +
    propRow("Notebook", esc(notebookName(note.notebookId))) +
    propRow("Pinned", note.pinned ? "yes" : "no") +
    propRow("Favorite", note.favorite ? "yes" : "no") +
    propRow("Created", esc(shortDate(note.createdAt))) +
    propRow("Updated", esc(shortDate(note.updatedAt))) +
    propRow("Node", `<code>${esc(note.id)}</code>`) +
    '<div class="c-section">Metrics</div>' +
    propRow("Words", String(countWords(note.content))) +
    propRow("Characters", String(note.content.length)) +
    propRow("Lines", String(note.content.split("\n").length)) +
    propRow("Reading", `${note.readingMinutes} min`) +
    actions +
    documentBlock +
    '<div class="c-section">Shortcuts</div>' +
    helpBlock();
}

function renderChrome() {
  undoBtn.disabled = !state.canUndo;
  redoBtn.disabled = !state.canRedo;
  const stats = state.stats ?? EMPTY_STATS;
  railStats.textContent = `${stats.notes} notes · ${stats.words} words · ${stats.favorites} fav`;
  metaEl.textContent = `${stats.notes} note${stats.notes === 1 ? "" : "s"} · ${stats.notebooks} notebook${stats.notebooks === 1 ? "" : "s"} · ${stats.trashed} in trash`;
}

function render() {
  renderScopes();
  renderNotebooks();
  renderTags();
  renderNoteList();
  renderBulkBar();
  renderEditor();
  renderChrome();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function setStatus(message, duration = 2000) {
  statusEl.textContent = message;
  if (duration > 0) setTimeout(() => {
    if (statusEl.textContent === message) statusEl.textContent = "Ready";
  }, duration);
}

function applyState(data) {
  if (!data.ok) {
    dotEl.classList.add("c-dot--err");
    setStatus(`Error: ${data.error?.message ?? data.error ?? "unknown"}`);
    return false;
  }
  dotEl.classList.remove("c-dot--err");
  state = {
    notes: data.notes ?? [],
    notebooks: data.notebooks ?? [],
    tags: data.tags ?? [],
    stats: data.stats ?? EMPTY_STATS,
    docVersion: data.docVersion,
    canUndo: data.canUndo,
    canRedo: data.canRedo,
  };
  // Drop ids that no longer exist (undo of a creation, purge, project load).
  for (const id of [...selection]) if (!state.notes.some((note) => note.id === id)) selection.delete(id);
  if (activeId && !state.notes.some((note) => note.id === activeId)) activeId = null;
  render();
  return true;
}

async function refresh() {
  applyState(await apiFetch("/api/state"));
}

async function openNote(id) {
  if (id === activeId) {
    editor.focus();
    return;
  }
  // Pending edits belong to the note we're leaving; flush them first so they
  // aren't silently dropped when the editor is repointed.
  clearTimeout(saveTimer);
  if (activeId) await flushSave().catch(() => {});
  activeId = id;
  localRev = 0;
  sentRev = 0;
  render();
  editor.focus();
}

function scheduleSave() {
  localRev += 1;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 600);
}

async function flushSave() {
  if (!activeId) return;
  clearTimeout(saveTimer);
  const note = currentNote();
  if (!note || note.trashedAt) return; // read-only in the trash
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
  if (rev === localRev) setStatus("Saved", 1200);
}

async function createNote(overrides = {}) {
  const params = {
    title: "Untitled",
    content: "",
    ...(notebookFilter && notebookFilter !== "unfiled" ? { notebookId: notebookFilter } : {}),
    ...(tagFilter ? { tags: [tagFilter] } : {}),
    ...overrides,
  };
  const data = await op("note.create", params, "New note");
  const created = commandResult(data);
  if (applyState(data) && created?.id) {
    await openNote(created.id);
    titleInput.select();
  }
  setStatus("Note created");
}

async function duplicateNote() {
  const note = currentNote();
  if (!note) return;
  const data = await op("note.duplicate", { id: note.id }, "Duplicate note");
  const copy = commandResult(data);
  if (applyState(data) && copy?.id) await openNote(copy.id);
  setStatus("Duplicated");
}

async function trashNote() {
  const note = currentNote();
  if (!note) return;
  await flushSave().catch(() => {});
  const data = await op("note.trash", { id: note.id }, "Move to trash");
  activeId = null;
  applyState(data);
  setStatus("Moved to trash — Ctrl+Z to undo");
}

async function restoreNote() {
  const note = currentNote();
  if (!note) return;
  const data = await op("note.restore", { id: note.id }, "Restore note");
  applyState(data);
  setStatus("Restored");
}

async function purgeNote() {
  const note = currentNote();
  if (!note) return;
  if (!confirm(`Delete "${note.title || "this note"}" forever?`)) return;
  const data = await op("note.purge", { id: note.id }, "Delete note forever");
  activeId = null;
  applyState(data);
  setStatus("Deleted forever — Ctrl+Z still works in this session");
}

async function setFlags(patch) {
  const note = currentNote();
  if (!note) return;
  const data = await op("note.setFlags", { id: note.id, ...patch }, "Update flags");
  applyState(data);
}

async function setNotebook(id) {
  const note = currentNote();
  if (!note) return;
  const data = await op("note.move", { id: note.id, notebookId: id === "" ? null : id }, "Move note");
  applyState(data);
  setStatus(`Filed in ${notebookName(id === "" ? null : id)}`);
}

async function addTag(raw) {
  const note = currentNote();
  const tag = raw.trim();
  if (!note || tag === "") return;
  const tags = [...new Set([...note.tags, tag])];
  const data = await op("note.setTags", { id: note.id, tags }, "Add tag");
  applyState(data);
  tagInput.value = "";
}

async function removeTag(tag) {
  const note = currentNote();
  if (!note) return;
  const data = await op("note.setTags", { id: note.id, tags: note.tags.filter((entry) => entry !== tag) }, "Remove tag");
  applyState(data);
}

async function undo() {
  clearTimeout(saveTimer);
  applyState(await apiFetch("/api/undo", { method: "POST" }));
  setStatus("Undone");
}

async function redo() {
  clearTimeout(saveTimer);
  applyState(await apiFetch("/api/redo", { method: "POST" }));
  setStatus("Redone");
}

// --- notebooks --------------------------------------------------------------

/** Inline input for create (no id) or rename (id). */
function inlineBookInput(mode, id) {
  const existing = bookList.querySelector(".n-bookinput");
  if (existing) existing.remove();
  const holder = document.createElement("div");
  holder.className = "n-books";
  holder.style.padding = "0 8px";
  holder.innerHTML = `<input class="n-bookinput" placeholder="${mode === "create" ? "Notebook name" : "New name"}" />`;
  bookList.before(holder);
  const input = holder.querySelector("input");
  const value = mode === "rename" ? notebookName(id === "" ? null : id) : "";
  input.value = mode === "rename" ? value : "";
  input.focus();
  input.select();

  const done = async (commit) => {
    const title = input.value.trim();
    holder.remove();
    if (!commit || title === "") return;
    const data =
      mode === "create"
        ? await op("notebook.create", { title }, "New notebook")
        : await op("notebook.rename", { id, title }, "Rename notebook");
    applyState(data);
    setStatus(mode === "create" ? `Notebook "${title}" created` : "Notebook renamed");
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); void done(true); }
    if (event.key === "Escape") { event.preventDefault(); void done(false); }
  });
  input.addEventListener("blur", () => void done(true));
}

async function deleteNotebook(id) {
  const book = state.notebooks.find((entry) => entry.id === id);
  const count = book?.noteCount ?? 0;
  const message = count === 0
    ? `Delete notebook "${book?.title}"?`
    : `Delete notebook "${book?.title}"? Its ${count} note${count === 1 ? "" : "s"} move to Unfiled.`;
  if (!confirm(message)) return;
  const data = await op("notebook.delete", { id }, "Delete notebook");
  if (notebookFilter === id) notebookFilter = null;
  applyState(data);
  setStatus("Notebook deleted — notes kept");
}

// --- selection --------------------------------------------------------------

function toggleSelection(id, mode, index) {
  if (mode === "range" && lastClicked !== null) {
    const notes = visibleNotes();
    const [from, to] = [lastClicked, index].sort((a, b) => a - b);
    for (let i = from; i <= to; i++) {
      const entry = notes[i];
      if (entry) selection.add(entry.id);
    }
  } else if (mode === "toggle") {
    if (selection.has(id)) selection.delete(id);
    else selection.add(id);
  } else {
    selection.clear();
  }
  lastClicked = index;
  renderNoteList();
  renderBulkBar();
}

async function bulkApply(kind) {
  const ids = [...selection];
  if (ids.length === 0) return;
  if (kind === "move") {
    bulkMoveMode = true;
    setStatus("Pick a notebook in the list (Esc cancels)", 0);
    return;
  }
  const command = scope === "trash" ? "note.restore" : "note.trash";
  let last = null;
  for (const id of ids) {
    last = await op(command, { id }, scope === "trash" ? "Restore notes" : "Trash notes");
  }
  selection.clear();
  if (last) applyState(last);
  setStatus(scope === "trash" ? "Restored" : "Moved to trash — Ctrl+Z to undo once per note");
}

async function bulkMoveTo(bookId) {
  const ids = [...selection];
  for (const id of ids) {
    await op("note.move", { id, notebookId: bookId }, "Move notes");
  }
  selection.clear();
  bulkMoveMode = false;
  await refresh();
  setStatus(`Moved ${ids.length} note${ids.length === 1 ? "" : "s"}`);
}

// --- quick open -------------------------------------------------------------

function quickCandidates() {
  const terms = quickInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return liveNotes()
    .filter((note) => matchesQuery(note, terms))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 8);
}

function renderQuick() {
  quickResults = quickCandidates();
  quickIndex = Math.min(quickIndex, Math.max(0, quickResults.length - 1));
  if (quickResults.length === 0) {
    quickListEl.innerHTML = '<div class="n-quick__empty">No note matches.</div>';
    return;
  }
  quickListEl.innerHTML = quickResults
    .map(
      (note, index) =>
        `<button class="n-quick__row" data-id="${esc(note.id)}" aria-selected="${index === quickIndex}">` +
        `<span>${esc(note.title || "Untitled")}</span>` +
        `<span class="n-quick__meta">${esc(notebookName(note.notebookId))} · ${relativeDate(note.updatedAt)}</span>` +
        `</button>`,
    )
    .join("");
}

function openQuick() {
  quickInput.value = "";
  quickIndex = 0;
  quickOverlay.hidden = false;
  renderQuick();
  quickInput.focus();
}

function closeQuick() {
  quickOverlay.hidden = true;
}

async function pickQuick(index) {
  const note = quickResults[index];
  if (!note) return;
  closeQuick();
  if (note.trashedAt) scope = "trash";
  else if (scope === "trash") scope = "all";
  await openNote(note.id);
}

// --- markdown insertion -----------------------------------------------------

function insertMarkdown(kind) {
  const target = editor;
  const start = target.selectionStart ?? 0;
  const end = target.selectionEnd ?? 0;
  const selected = target.value.slice(start, end);
  let prefix = "";
  let inner = selected;
  let suffix = "";

  switch (kind) {
    case "h1": prefix = "# "; break;
    case "h2": prefix = "## "; break;
    case "h3": prefix = "### "; break;
    case "bold": suffix = "**"; inner = inner || "bold"; break;
    case "italic": suffix = "*"; inner = inner || "italic"; break;
    case "strike": suffix = "~~"; inner = inner || "struck"; break;
    case "code": suffix = "`"; inner = inner || "code"; break;
    case "ul": prefix = "- "; break;
    case "ol": prefix = "1. "; break;
    case "task": prefix = "- [ ] "; inner = inner || "task"; break;
    case "quote": prefix = "> "; break;
    case "snippet": prefix = "```\n"; suffix = "\n```"; break;
    case "rule": prefix = "\n---\n"; break;
    case "table": inner = "\n| Column | Column |\n| --- | --- |\n| cell | cell |\n"; break;
    case "link": {
      const link = inner || "https://";
      inner = `[${selected || "label"}](${link})`;
      break;
    }
    default: break;
  }

  target.setRangeText(prefix + inner + suffix, start, end, "end");
  target.focus();
  editor.dispatchEvent(new Event("input", { bubbles: false }));
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

$("#new-note").addEventListener("click", () => void createNote());
$("#new-notebook").addEventListener("click", () => inlineBookInput("create"));
$("#new-notebook-2").addEventListener("click", () => inlineBookInput("create"));

searchInput.addEventListener("input", () => {
  query = searchInput.value.trim();
  searchClear.hidden = query === "";
  renderNoteList();
});

searchClear.addEventListener("click", () => {
  searchInput.value = "";
  query = "";
  searchClear.hidden = true;
  renderNoteList();
  searchInput.focus();
});

sortSelect.addEventListener("change", () => {
  sortMode = sortSelect.value;
  renderNoteList();
});

scopeSeg.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-scope]");
  if (!button) return;
  scope = button.dataset.scope;
  selection.clear();
  render();
  if (activeId && !visibleNotes().some((note) => note.id === activeId)) activeId = null;
});

bookList.addEventListener("click", async (event) => {
  const rename = event.target.closest("[data-book-rename]");
  if (rename) {
    event.stopPropagation();
    inlineBookInput("rename", rename.dataset.bookRename);
    return;
  }
  const remove = event.target.closest("[data-book-delete]");
  if (remove) {
    event.stopPropagation();
    await deleteNotebook(remove.dataset.bookDelete);
    return;
  }
  const book = event.target.closest("[data-book]");
  if (!book) return;
  const id = book.dataset.book;
  if (bulkMoveMode) {
    await bulkMoveTo(id === "unfiled" ? null : id);
    return;
  }
  notebookFilter = notebookFilter === id ? null : id;
  render();
});

bookList.addEventListener("dblclick", (event) => {
  const book = event.target.closest("[data-book]");
  if (!book || book.dataset.book === "unfiled") return;
  inlineBookInput("rename", book.dataset.book);
});

// Drag a note onto a notebook.
noteList.addEventListener("dragstart", (event) => {
  const row = event.target.closest("[data-id]");
  if (!row) return;
  event.dataTransfer.setData("text/plain", row.dataset.id);
  event.dataTransfer.effectAllowed = "move";
});

for (const target of [bookList]) {
  target.addEventListener("dragover", (event) => {
    const book = event.target.closest("[data-book]");
    if (!book) return;
    event.preventDefault();
    for (const other of bookList.querySelectorAll(".is-drop")) other.classList.remove("is-drop");
    book.classList.add("is-drop");
  });
  target.addEventListener("dragleave", () => {
    for (const other of bookList.querySelectorAll(".is-drop")) other.classList.remove("is-drop");
  });
  target.addEventListener("drop", async (event) => {
    const book = event.target.closest("[data-book]");
    if (!book) return;
    event.preventDefault();
    const id = event.dataTransfer.getData("text/plain");
    for (const other of bookList.querySelectorAll(".is-drop")) other.classList.remove("is-drop");
    if (!id) return;
    const data = await op("note.move", { id, notebookId: book.dataset.book === "unfiled" ? null : book.dataset.book }, "Move note");
    applyState(data);
    setStatus(`Moved to ${book.dataset.book === "unfiled" ? "Unfiled" : notebookName(book.dataset.book)}`);
  });
}

tagList.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-tag]");
  if (!chip) return;
  tagFilter = tagFilter === chip.dataset.tag ? null : chip.dataset.tag;
  render();
});

clearTagBtn.addEventListener("click", () => {
  tagFilter = null;
  render();
});

noteList.addEventListener("click", (event) => {
  const row = event.target.closest("[data-id]");
  if (!row) return;
  const id = row.dataset.id;
  const index = visibleNotes().findIndex((note) => note.id === id);
  if (event.ctrlKey || event.metaKey) {
    toggleSelection(id, "toggle", index);
    return;
  }
  if (event.shiftKey) {
    toggleSelection(id, "range", index);
    return;
  }
  if (selection.size > 0) {
    selection.clear();
    renderNoteList();
    renderBulkBar();
  }
  void openNote(id);
});

bulkBar.addEventListener("click", (event) => {
  const button = event.target.closest("[data-bulk]");
  if (!button) return;
  void bulkApply(button.dataset.bulk);
});

$("#bulk-clear").addEventListener("click", () => {
  selection.clear();
  bulkMoveMode = false;
  render();
});

titleInput.addEventListener("input", scheduleSave);

editor.addEventListener("input", () => {
  scheduleSave();
  if (viewMode === "split") renderPreview();
  const note = currentNote();
  if (note) renderCounts(note);
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

pinBtn.addEventListener("click", () => {
  const note = currentNote();
  if (note) void setFlags({ pinned: !note.pinned });
});

favBtn.addEventListener("click", () => {
  const note = currentNote();
  if (note) void setFlags({ favorite: !note.favorite });
});

noteBookSelect.addEventListener("change", () => void setNotebook(noteBookSelect.value));

tagInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === ",") {
    event.preventDefault();
    void addTag(tagInput.value);
  } else if (event.key === "Backspace" && tagInput.value === "") {
    const note = currentNote();
    const last = note?.tags[note.tags.length - 1];
    if (last) void removeTag(last);
  }
});
tagInput.addEventListener("blur", () => {
  if (tagInput.value.trim() !== "") void addTag(tagInput.value);
});

noteTagsEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-tagremove]");
  if (button) void removeTag(button.dataset.tagRemove);
});

inspectorEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-act]");
  if (!button) return;
  switch (button.dataset.act) {
    case "duplicate": void duplicateNote(); break;
    case "trash": void trashNote(); break;
    case "restore": void restoreNote(); break;
    case "purge": void purgeNote(); break;
    default: break;
  }
});

undoBtn.addEventListener("click", () => void undo());
redoBtn.addEventListener("click", () => void redo());
$("#palette").addEventListener("click", () => window.NucleusKit?.openPalette());
$("#quick-open").addEventListener("click", openQuick);

quickInput.addEventListener("input", () => {
  quickIndex = 0;
  renderQuick();
});
quickInput.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    quickIndex = Math.min(quickIndex + 1, quickResults.length - 1);
    renderQuick();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    quickIndex = Math.max(quickIndex - 1, 0);
    renderQuick();
  } else if (event.key === "Enter") {
    event.preventDefault();
    void pickQuick(quickIndex);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeQuick();
  }
});
quickOverlay.addEventListener("click", (event) => {
  if (event.target === quickOverlay) closeQuick();
});
quickListEl.addEventListener("click", (event) => {
  const row = event.target.closest("[data-id]");
  if (!row) return;
  const index = quickResults.findIndex((note) => note.id === row.dataset.id);
  void pickQuick(index);
});

exportBtn.addEventListener("click", () => {
  window.location.href = "/api/export";
  setStatus("Exporting…");
});

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
  selection.clear();
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

  if (!quickOverlay.hidden && event.key === "Escape") {
    event.preventDefault();
    closeQuick();
    return;
  }
  if (mod && key === "p") { event.preventDefault(); openQuick(); }
  else if (mod && key === "n" && event.shiftKey) { event.preventDefault(); inlineBookInput("create"); }
  else if (mod && key === "n") { event.preventDefault(); void createNote(); }
  else if (mod && key === "d") { event.preventDefault(); void duplicateNote(); }
  else if (mod && key === "z" && !event.shiftKey) { event.preventDefault(); void undo(); }
  else if (mod && ((key === "z" && event.shiftKey) || key === "y")) { event.preventDefault(); void redo(); }
  else if (mod && key === "e") { event.preventDefault(); cycleViewMode(); }
  else if (mod && key === "s") { event.preventDefault(); setStatus("Saving…", 0); void flushSave(); }
  else if (mod && key === "b" && event.target === editor) { event.preventDefault(); insertMarkdown("bold"); }
  else if (mod && key === "i" && event.target === editor) { event.preventDefault(); insertMarkdown("italic"); }
  else if (mod && key === "1") { event.preventDefault(); scope = "all"; selection.clear(); render(); }
  else if (mod && key === "2") { event.preventDefault(); scope = "favorites"; selection.clear(); render(); }
  else if (mod && key === "3") { event.preventDefault(); scope = "trash"; selection.clear(); render(); }
  else if (event.key === "Escape") {
    if (bulkMoveMode) {
      bulkMoveMode = false;
      setStatus("Bulk move cancelled");
    } else if (selection.size > 0) {
      selection.clear();
      render();
    } else if (query !== "") {
      searchInput.value = "";
      query = "";
      searchClear.hidden = true;
      renderNoteList();
    } else if (!typing) {
      searchInput.focus();
    }
  }
});

function cycleViewMode() {
  const order = ["write", "split", "read"];
  setViewMode(order[(order.indexOf(viewMode) + 1) % order.length]);
}

// Live updates from other tabs / agents: the app-kit SSE hub broadcasts a
// `state` frame after every command, wherever it came from.
if (typeof EventSource !== "undefined") {
  let refreshTimer = null;
  const events = new EventSource("/api/events");
  events.addEventListener("state", () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refresh(), 250);
  });
  events.onerror = () => {
    /* EventSource reconnects on its own */
  };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

void (async () => {
  await refresh();
  const first = visibleNotes()[0];
  if (first) await openNote(first.id);
})();
