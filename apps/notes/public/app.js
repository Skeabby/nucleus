// Notes 2.0 — Craft front-end. Vanilla ES-module, zero deps.
// Every mutation goes through /api/op (bus commands), so the tape, undo and
// agent proposals see exactly what the human sees.
//
// The chrome is not this app's business any more. NucleusShell owns the menubar,
// the options bar, the panel, the status bar and every shortcut; this file only
// describes *what* Notes can do (menus + context) and paints the editor.
//
// Editor generations (F4): `localRev` bumps on every keystroke, `sentRev`
// tracks the last generation successfully saved. They only differ while a
// save is in flight — exactly when the server must not clobber the textarea.

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const EMPTY_STATS = { notes: 0, notebooks: 0, favorites: 0, pinned: 0, trashed: 0, tags: 0, words: 0 };

const MODES = ["edit", "split", "preview"];

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

/** Layout: edit | split | preview (persisted through the shell's settings). */
let viewMode = window.innerWidth >= 1100 ? "split" : "edit";

/** Pending auto-save timer + the two things the options bar reports. */
let saveTimer = null;
let saving = false;
let dirty = false;
let lastSavedAt = null;

/**
 * The library filter — one dropdown, one dimension (brief #3 §4.2):
 *   { kind: "all" } · { kind: "favorites" } · { kind: "trash" }
 *   { kind: "book", id: string | null }   (null = Unfiled)
 *   { kind: "tag", tag: string }
 */
let filter = { kind: "all" };
let sortMode = "updated";
let query = "";

/** Multi-select (Ctrl/Shift click) for bulk trash/restore. */
const selection = new Set();
let lastClicked = null;

/** Quick-open overlay state. */
let quickIndex = 0;
let quickResults = [];

/** Details popover. */
let detailsOpen = false;

/** Status bar state (the shell paints it). */
let status = { text: "Ready", kind: "ready" };

/** Live panel nodes, kept so search can repaint the list without a rebuild. */
let listNode = null;
let countChip = null;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

const workspace = $("#workspace");
const emptyHost = $("#empty");
const notePanel = $("#note-panel");
const titleInput = $("#title-input");
const editor = $("#editor");
const editorBody = $("#n-body");
const preview = $("#preview");
const noteUpdatedEl = $("#note-updated");
const detailsEl = $("#details");
const detailsToggle = $("#details-toggle");
const detailCreated = $("#detail-created");
const detailUpdated = $("#detail-updated");
const noteBookSelect = $("#note-book");
const noteTagsEl = $("#note-tags");
const tagInput = $("#tag-input");
const projectInput = $("#project-input");
const quickOverlay = $("#quick");
const quickInput = $("#quick-input");
const quickListEl = $("#quick-list");

// The search field is one node for the app's whole life: the shell re-appends
// it on every context change instead of cloning it, so its value survives.
const searchField = document.createElement("div");
searchField.className = "nk-search";
const searchInput = document.createElement("input");
searchInput.type = "search";
searchInput.placeholder = "Search notes…";
searchInput.setAttribute("aria-label", "Search notes");
searchInput.spellcheck = false;
const searchClear = document.createElement("button");
searchClear.type = "button";
searchClear.className = "nk-search__clear";
searchClear.title = "Clear search";
searchClear.textContent = "×";
searchClear.hidden = true;
searchField.append(searchInput, searchClear);

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
  let list;
  if (filter.kind === "trash") {
    list = state.notes.filter((note) => note.trashedAt);
  } else {
    list = liveNotes();
    if (filter.kind === "favorites") list = list.filter((note) => note.favorite);
    else if (filter.kind === "book") {
      list = list.filter((note) => (filter.id ? note.notebookId === filter.id : !note.notebookId));
    } else if (filter.kind === "tag") {
      list = list.filter((note) => (note.tags ?? []).includes(filter.tag));
    }
  }
  list = list.filter((note) => matchesQuery(note, terms));

  return [...list].sort((a, b) => {
    if (filter.kind !== "trash") {
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
  if (!id) return "Unfiled";
  return state.notebooks.find((book) => book.id === id)?.title ?? "Unfiled";
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
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

/** "Saved just now" / "Saving…" / "Unsaved changes" — the options bar's hint. */
function savedLabel(note) {
  if (saving) return "Saving…";
  if (dirty) return "Unsaved changes";
  if (lastSavedAt) {
    const mins = Math.floor((Date.now() - lastSavedAt) / 60_000);
    return mins < 1 ? "Saved just now" : `Saved ${mins}m ago`;
  }
  // Nothing typed in this session yet: the server's stamp is the truth.
  return note?.updatedAt ? `Saved ${relativeDate(note.updatedAt)}` : "Saved";
}

// ---------------------------------------------------------------------------
// Shell context
// ---------------------------------------------------------------------------

function sync(options) {
  // Panels are rebuilt by the shell; pass { panels: false } while the list is
  // being repainted for a keystroke that cannot change it.
  window.NucleusShell?.setContext(
    {
      note: activeId,
      trashed: Boolean(currentNote()?.trashedAt),
      mode: viewMode,
      selection: [...selection],
      filter: filter.kind,
      query,
      sort: sortMode,
      count: visibleNotes().length,
      canUndo: Boolean(state.canUndo),
      canRedo: Boolean(state.canRedo),
      stats: state.stats ?? EMPTY_STATS,
      details: detailsOpen,
    },
    options,
  );
}

function setStatus(text, kind = "ready", duration = 0) {
  status = { text, kind };
  sync();
  if (duration > 0) {
    setTimeout(() => {
      if (status.text === text) {
        status = { text: "Ready", kind: "ready" };
        sync();
      }
    }, duration);
  }
}

function markError(message) {
  status = { text: message, kind: "error" };
  window.NucleusKit?.toast(message, "error");
  sync();
}

// ---------------------------------------------------------------------------
// Panel: the library (one dropdown, one list)
// ---------------------------------------------------------------------------

function panelHead(title, count) {
  const head = document.createElement("div");
  head.className = "c-panelhead";
  const label = document.createElement("span");
  label.textContent = title;
  head.appendChild(label);
  if (count !== undefined) {
    const chip = document.createElement("span");
    chip.className = "c-chip";
    chip.textContent = String(count);
    head.appendChild(chip);
  }
  return head;
}

function filterValue() {
  if (filter.kind === "book") return filter.id ? `book:${filter.id}` : "book:unfiled";
  if (filter.kind === "tag") return `tag:${filter.tag}`;
  if (filter.kind === "favorites") return "scope:favorites";
  if (filter.kind === "trash") return "scope:trash";
  return "scope:all";
}

function parseFilter(value) {
  const [kind, ...rest] = String(value).split(":");
  const arg = rest.join(":");
  if (kind === "book") return { kind: "book", id: arg === "unfiled" || arg === "" ? null : arg };
  if (kind === "tag") return { kind: "tag", tag: arg };
  if (arg === "favorites" || arg === "trash") return { kind: arg };
  return { kind: "all" };
}

function optionGroup(label, entries) {
  const group = document.createElement("optgroup");
  group.label = label;
  for (const [value, text] of entries) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    group.appendChild(option);
  }
  return group;
}

function filterSelect() {
  const wrap = document.createElement("div");
  wrap.className = "n-filter";
  const select = document.createElement("select");
  select.className = "n-filter__select";
  select.setAttribute("aria-label", "Filter notes");

  select.appendChild(optionGroup("Show", [
    ["scope:all", "All notes"],
    ["scope:favorites", "Favorites"],
    ["scope:trash", "Trash"],
  ]));
  const books = [["book:unfiled", "Unfiled"]];
  for (const book of state.notebooks) books.push([`book:${book.id}`, book.title]);
  select.appendChild(optionGroup("Notebooks", books));
  if (state.tags.length > 0) {
    select.appendChild(optionGroup("Tags", state.tags.map((entry) => [`tag:${entry.tag}`, `#${entry.tag} (${entry.count})`])));
  }

  select.value = filterValue();
  select.addEventListener("change", () => {
    filter = parseFilter(select.value);
    selection.clear();
    lastClicked = null;
    if (activeId && !visibleNotes().some((note) => note.id === activeId)) activeId = null;
    render();
  });

  wrap.appendChild(select);
  return wrap;
}

function emptyListMessage() {
  if (query !== "") return "Nothing matches your search.";
  if (filter.kind === "trash") return "The trash is empty.";
  if (filter.kind === "favorites") return "No favorites yet — Edit → Favorite note.";
  if (filter.kind === "book") return "No note in this notebook yet.";
  if (filter.kind === "tag") return "No note carries this tag yet.";
  return "No notes yet — Ctrl N starts one.";
}

function noteRow(note, index) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const row = document.createElement("button");
  row.type = "button";
  row.className = "c-row";
  row.dataset.id = note.id;
  // The visible index, not the absolute one: shift-click ranges follow the list.
  row.dataset.index = String(index);
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", String(selection.has(note.id) || note.id === activeId));
  if (note.trashedAt) row.classList.add("is-trashed");
  if (note.pinned) row.classList.add("is-pinned");
  if (selection.has(note.id)) row.classList.add("is-selected");

  const title = document.createElement("span");
  title.className = "c-row__title";
  title.innerHTML =
    highlight(note.title || "Untitled", terms) +
    (note.favorite ? '<span class="n-star" title="Favorite">★</span>' : "");

  const meta = document.createElement("span");
  meta.className = "c-row__meta";
  const snippet = document.createElement("span");
  snippet.className = "c-row__snippet";
  snippet.innerHTML = highlight(note.snippet || "No content", terms);
  const time = document.createElement("span");
  time.className = "c-row__time";
  time.textContent = relativeDate(note.trashedAt || note.updatedAt);
  meta.append(snippet, time);

  row.append(title, meta);
  return row;
}

function fillRows(body) {
  const notes = visibleNotes();
  if (notes.length === 0) {
    const empty = document.createElement("p");
    empty.className = "c-help n-list__empty";
    empty.textContent = emptyListMessage();
    body.replaceChildren(empty);
    return;
  }
  body.replaceChildren(...notes.map((note, index) => noteRow(note, index)));
}

function renderListOnly() {
  if (!listNode) return;
  fillRows(listNode);
  if (countChip) countChip.textContent = String(visibleNotes().length);
}

function bulkBar() {
  const bar = document.createElement("div");
  bar.className = "n-bulk";
  const label = document.createElement("span");
  label.className = "n-bulk__count";
  label.textContent = `${selection.size} selected`;

  const action = document.createElement("button");
  action.type = "button";
  action.className = "c-btn";
  action.textContent = filter.kind === "trash" ? "Restore" : "Trash";
  action.addEventListener("click", () => void bulkApply());

  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "c-btn";
  clear.textContent = "Clear";
  clear.addEventListener("click", () => {
    selection.clear();
    lastClicked = null;
    render();
  });

  bar.append(label, action, clear);
  return bar;
}

function notesPanel(ctx) {
  if (ctx.panel === "history") {
    listNode = null;
    countChip = null;
    return null; // the shell paints History itself
  }

  const wrap = document.createElement("div");
  wrap.className = "n-panel";

  const head = panelHead("Notes", visibleNotes().length);
  countChip = head.querySelector(".c-chip");
  wrap.appendChild(head);
  wrap.appendChild(filterSelect());

  const body = document.createElement("div");
  body.className = "c-rail__body n-list";
  body.id = "note-list";
  body.setAttribute("role", "listbox");
  body.setAttribute("aria-label", "Notes");
  body.setAttribute("aria-multiselectable", "true");
  listNode = body;
  fillRows(body);
  body.addEventListener("click", onRowClick);
  wrap.appendChild(body);

  if (selection.size > 0) wrap.appendChild(bulkBar());
  return wrap;
}

// ---------------------------------------------------------------------------
// Editor rendering
// ---------------------------------------------------------------------------

function renderMode() {
  editorBody.dataset.mode = viewMode;
  // The header follows the layout: in split it lines up with the editor half.
  notePanel.dataset.mode = viewMode;
  if (viewMode !== "edit") renderPreview();
}

function renderPreview() {
  // Preview shows the live textarea content, not the last saved copy.
  preview.innerHTML = renderMarkdown(editor.value);
}

function renderDetails(note) {
  detailsEl.hidden = !detailsOpen;
  detailsToggle.setAttribute("aria-expanded", String(detailsOpen));
  if (!note) return;

  detailCreated.textContent = shortDate(note.createdAt);
  detailUpdated.textContent = shortDate(note.updatedAt);

  const options = [document.createElement("option")];
  options[0].value = "";
  options[0].textContent = "Unfiled";
  for (const book of state.notebooks) {
    const option = document.createElement("option");
    option.value = book.id;
    option.textContent = book.title;
    options.push(option);
  }
  noteBookSelect.replaceChildren(...options);
  noteBookSelect.value = note.notebookId ?? "";
  noteBookSelect.disabled = Boolean(note.trashedAt);

  const chips = note.tags.map((tag) => {
    const chip = document.createElement("span");
    chip.className = "n-tagchip";
    chip.appendChild(document.createTextNode(tag));
    if (!note.trashedAt) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.title = "Remove tag";
      remove.textContent = "×";
      remove.addEventListener("click", () => void removeTag(tag));
      chip.appendChild(remove);
    }
    return chip;
  });
  noteTagsEl.replaceChildren(...chips);
  tagInput.hidden = Boolean(note.trashedAt);
}

function renderEditor() {
  const note = currentNote();

  if (!note) {
    emptyHost.hidden = false;
    notePanel.hidden = true;
    activeId = null;
    return;
  }

  emptyHost.hidden = true;
  notePanel.hidden = false;

  // Never clobber unsent typing: only take server text when every local edit
  // has been saved (F4). Otherwise a save round-trip can drop keystrokes.
  const clean = localRev === sentRev;
  if (clean && titleInput.value !== note.title) titleInput.value = note.title;
  if (clean && editor.value !== note.content) editor.value = note.content;

  titleInput.readOnly = Boolean(note.trashedAt);
  editor.readOnly = Boolean(note.trashedAt);

  noteUpdatedEl.textContent = note.trashedAt
    ? `in trash · ${relativeDate(note.trashedAt)}`
    : `edited ${relativeDate(note.updatedAt)}`;

  renderDetails(note);
  renderMode();
}

function render() {
  renderEditor();
  sync();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function applyState(data) {
  if (!data.ok) {
    markError(`Error: ${data.error?.message ?? data.error ?? "unknown"}`);
    return false;
  }
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
  if (filter.kind === "book" && filter.id && !state.notebooks.some((book) => book.id === filter.id)) {
    filter = { kind: "all" };
  }
  if (filter.kind === "tag" && !state.tags.some((entry) => entry.tag === filter.tag)) filter = { kind: "all" };
  render();
  return true;
}

async function refresh() {
  applyState(await apiFetch("/api/state"));
}

async function openNote(id) {
  if (id === activeId) {
    if (viewMode !== "preview") editor.focus();
    return;
  }
  // Pending edits belong to the note we're leaving; flush them first so they
  // aren't silently dropped when the editor is repointed.
  clearTimeout(saveTimer);
  if (activeId) await flushSave().catch(() => {});
  activeId = id;
  localRev = 0;
  sentRev = 0;
  dirty = false;
  render();
  if (viewMode !== "preview") editor.focus();
}

function scheduleSave() {
  localRev += 1;
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 600);
}

async function flushSave() {
  if (!activeId) return;
  clearTimeout(saveTimer);
  const note = currentNote();
  if (!note || note.trashedAt) return; // read-only in the trash
  const rev = localRev;
  saving = true;
  sync();
  try {
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
    if (rev === localRev) {
      dirty = false;
      lastSavedAt = Date.now();
      setStatus("Saved", "ready", 1200);
    }
  } finally {
    saving = false;
    sync();
  }
}

async function createNote() {
  if (filter.kind === "trash") filter = { kind: "all" };
  const params = { title: "Untitled", content: "" };
  if (filter.kind === "book" && filter.id) params.notebookId = filter.id;
  if (filter.kind === "tag") params.tags = [filter.tag];
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
  await flushSave().catch(() => {});
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
  setStatus("Moved to trash — Ctrl Z undoes it");
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
  const data = await op("note.purge", { id: note.id }, "Delete note forever");
  activeId = null;
  applyState(data);
  setStatus("Deleted forever — Ctrl Z still works this session");
}

async function setFlags(patch) {
  const note = currentNote();
  if (!note) return;
  const data = await op("note.setFlags", { id: note.id, ...patch }, "Update flags");
  applyState(data);
  setStatus(patch.pinned === true ? "Pinned" : patch.pinned === false ? "Unpinned" : "Updated");
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
  const data = await apiFetch("/api/undo", { method: "POST" });
  if (applyState(data)) {
    dirty = false;
    lastSavedAt = Date.now();
    setStatus("Undone");
  }
}

async function redo() {
  clearTimeout(saveTimer);
  const data = await apiFetch("/api/redo", { method: "POST" });
  if (applyState(data)) {
    dirty = false;
    lastSavedAt = Date.now();
    setStatus("Redone");
  }
}

// --- notebooks --------------------------------------------------------------

async function createNotebook() {
  const title = await window.NucleusShell.ask({
    title: "New notebook",
    body: "A notebook groups notes in the filter above the list.",
    placeholder: "Notebook name",
    confirmLabel: "Create notebook",
  });
  if (!title) return;
  const data = await op("notebook.create", { title }, "New notebook");
  const created = commandResult(data);
  if (applyState(data) && created?.id) filter = { kind: "book", id: created.id };
  render();
  setStatus(`Notebook “${title}” created`);
}

function selectedNotebook() {
  return filter.kind === "book" && filter.id ? state.notebooks.find((book) => book.id === filter.id) ?? null : null;
}

async function renameNotebook() {
  const book = selectedNotebook();
  if (!book) return;
  const title = await window.NucleusShell.ask({
    title: "Rename notebook",
    value: book.title,
    confirmLabel: "Rename",
  });
  if (!title || title === book.title) return;
  const data = await op("notebook.rename", { id: book.id, title }, "Rename notebook");
  applyState(data);
  setStatus("Notebook renamed");
}

async function deleteNotebook() {
  const book = selectedNotebook();
  if (!book) return;
  const count = book.noteCount ?? 0;
  const accepted = await window.NucleusShell.confirm({
    title: "Delete notebook",
    body: count === 0
      ? `Delete “${book.title}”?`
      : `Delete “${book.title}”? Its ${plural(count, "note")} move to Unfiled — nothing is deleted.`,
    confirmLabel: "Delete notebook",
  });
  if (!accepted) return;
  const data = await op("notebook.delete", { id: book.id }, "Delete notebook");
  filter = { kind: "all" };
  applyState(data);
  setStatus("Notebook deleted — notes kept");
}

// --- files ------------------------------------------------------------------

function download(text, name, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function slug(text) {
  return String(text || "note")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "note";
}

async function exportNote() {
  const note = currentNote();
  if (!note) return;
  await flushSave().catch(() => {});
  download(`# ${note.title || "Untitled"}\n\n${editor.value}\n`, `${slug(note.title)}.md`, "text/markdown");
  setStatus("Note exported as Markdown");
}

function exportAll() {
  window.location.href = "/api/export";
  setStatus("Exporting every note…");
}

function saveCopy() {
  window.location.href = "/api/project";
  setStatus("Saving a copy of the project…");
}

function openCopy() {
  projectInput.click();
}

// --- selection --------------------------------------------------------------

function toggleSelection(id, index) {
  if (selection.has(id)) selection.delete(id);
  else selection.add(id);
  lastClicked = index;
  render();
}

function selectRange(index) {
  const notes = visibleNotes();
  const from = lastClicked ?? index;
  const [start, end] = from <= index ? [from, index] : [index, from];
  for (let i = start; i <= end; i++) {
    const note = notes[i];
    if (note) selection.add(note.id);
  }
  render();
}

function onRowClick(event) {
  const row = event.target.closest("[data-id]");
  if (!row) return;
  const id = row.dataset.id;
  const index = Number(row.dataset.index);
  if (event.ctrlKey || event.metaKey) {
    toggleSelection(id, index);
    return;
  }
  if (event.shiftKey) {
    selectRange(index);
    return;
  }
  if (selection.size > 0) {
    selection.clear();
    lastClicked = null;
  }
  void openNote(id);
}

async function bulkApply() {
  const ids = [...selection];
  if (ids.length === 0) return;
  const command = filter.kind === "trash" ? "note.restore" : "note.trash";
  let last = null;
  for (const id of ids) {
    last = await op(command, { id }, filter.kind === "trash" ? "Restore notes" : "Trash notes");
  }
  selection.clear();
  lastClicked = null;
  if (last) applyState(last);
  else await refresh();
  setStatus(filter.kind === "trash" ? "Restored" : "Moved to trash — Ctrl Z undoes it once per note");
}

// --- layout -----------------------------------------------------------------

function setViewMode(mode, persist = true) {
  if (!MODES.includes(mode)) return;
  if (mode !== "edit") {
    clearTimeout(saveTimer);
    void flushSave().catch(() => {});
  }
  viewMode = mode;
  if (persist) void window.NucleusShell.setSetting("viewMode", mode);
  renderMode();
  sync();
}

function cycleViewMode() {
  setViewMode(MODES[(MODES.indexOf(viewMode) + 1) % MODES.length]);
}

function setSort(mode) {
  sortMode = mode;
  render();
}

function clearContext() {
  if (detailsOpen) {
    detailsOpen = false;
    renderDetails(currentNote());
    sync();
    return;
  }
  if (selection.size > 0) {
    selection.clear();
    lastClicked = null;
    render();
    return;
  }
  if (query !== "") {
    searchInput.value = "";
    query = "";
    searchClear.hidden = true;
    renderListOnly();
    sync({ panels: false });
  }
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
  if (note.trashedAt) filter = { kind: "trash" };
  else if (filter.kind === "trash") filter = { kind: "all" };
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

searchInput.addEventListener("input", () => {
  query = searchInput.value.trim();
  searchClear.hidden = query === "";
  renderListOnly();
});

searchClear.addEventListener("click", () => {
  searchInput.value = "";
  query = "";
  searchClear.hidden = true;
  renderListOnly();
  searchInput.focus();
});

titleInput.addEventListener("input", () => {
  scheduleSave();
  sync({ panels: false });
});

editor.addEventListener("input", () => {
  scheduleSave();
  if (viewMode === "split") renderPreview();
  sync({ panels: false });
});

detailsToggle.addEventListener("click", () => {
  detailsOpen = !detailsOpen;
  renderDetails(currentNote());
  sync({ panels: false });
});

document.addEventListener("mousedown", (event) => {
  if (!detailsOpen) return;
  if (detailsEl.contains(event.target) || detailsToggle.contains(event.target)) return;
  detailsOpen = false;
  renderDetails(currentNote());
  sync({ panels: false });
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
  filter = { kind: "all" };
  titleInput.value = "";
  editor.value = "";
  applyState(data);
  setStatus("Copy opened");
  projectInput.value = "";
});

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

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

emptyHost.appendChild(
  window.NucleusShell.emptyState({
    title: "Your thoughts, written.",
    body: "Notebooks, tags and a rewindable history. Autosave keeps every keystroke; Ctrl Z takes it back.",
    cta: "New note",
    onCta: () => void createNote(),
    hint: "Everything stays on this machine · Ctrl K lists every command",
  }),
);

function modeSeg() {
  const seg = document.createElement("div");
  seg.className = "c-seg";
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "Layout");
  for (const [mode, label] of [["edit", "Edit"], ["split", "Split"], ["preview", "Preview"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.mode = mode;
    button.textContent = label;
    button.setAttribute("aria-pressed", String(viewMode === mode));
    button.addEventListener("click", () => setViewMode(mode));
    seg.appendChild(button);
  }
  return seg;
}

const FORMAT_ITEMS = [
  { id: "format.bold", label: "Bold", shortcut: "Ctrl+B", run: () => insertMarkdown("bold") },
  { id: "format.italic", label: "Italic", shortcut: "Ctrl+I", run: () => insertMarkdown("italic") },
  { sep: true },
  { id: "format.h1", label: "Heading 1", run: () => insertMarkdown("h1") },
  { id: "format.h2", label: "Heading 2", run: () => insertMarkdown("h2") },
  { id: "format.h3", label: "Heading 3", run: () => insertMarkdown("h3") },
  { sep: true },
  { id: "format.list", label: "Bulleted list", run: () => insertMarkdown("ul") },
  { id: "format.numbered", label: "Numbered list", run: () => insertMarkdown("ol") },
  { id: "format.task", label: "Task list", run: () => insertMarkdown("task") },
  { id: "format.quote", label: "Quote", run: () => insertMarkdown("quote") },
  { id: "format.link", label: "Link…", run: () => insertMarkdown("link") },
  { sep: true },
  { id: "format.code", label: "Inline code", run: () => insertMarkdown("code") },
  { id: "format.snippet", label: "Code block", run: () => insertMarkdown("snippet") },
  { id: "format.table", label: "Table", run: () => insertMarkdown("table") },
  { id: "format.rule", label: "Divider", run: () => insertMarkdown("rule") },
];

window.NucleusShell.mount({
  app: { name: "Notes", accent: "#8ab4f8" },
  main: workspace,
  // Notes wants the proposal card above the title, not in a side column.
  reviewHost: "#review-slot",
  menus: [
    {
      label: "File",
      items: [
        { id: "file.newNote", label: "New note", shortcut: "Ctrl+N", run: () => void createNote() },
        { id: "file.newNotebook", label: "New notebook…", shortcut: "Ctrl+Shift+N", run: () => void createNotebook() },
        { sep: true },
        { id: "file.renameNotebook", label: "Rename notebook…", run: () => void renameNotebook() },
        { id: "file.deleteNotebook", label: "Delete notebook…", danger: true, run: () => void deleteNotebook() },
        { sep: true },
        { id: "file.saveCopy", label: "Save a copy…", shortcut: "Ctrl+S", run: saveCopy },
        { id: "file.openCopy", label: "Open a copy…", run: openCopy },
        { sep: true },
        { id: "file.exportNote", label: "Export note…", run: () => void exportNote() },
        { id: "file.exportAll", label: "Export all as Markdown…", run: exportAll },
      ],
    },
    {
      label: "Edit",
      items: [
        { id: "edit.undo", label: "Undo", shortcut: "Ctrl+Z", command: "tape.undo", run: () => void undo() },
        { id: "edit.redo", label: "Redo", shortcut: ["Ctrl+Shift+Z", "Ctrl+Y"], command: "tape.redo", run: () => void redo() },
        { sep: true },
        { id: "edit.quickOpen", label: "Quick open…", shortcut: "Ctrl+P", run: openQuick },
        { id: "edit.duplicate", label: "Duplicate note", shortcut: "Ctrl+D", run: () => void duplicateNote() },
        { sep: true },
        { id: "edit.pin", label: "Pin note", checked: () => Boolean(currentNote()?.pinned), run: () => void setFlags({ pinned: !currentNote()?.pinned }) },
        { id: "edit.favorite", label: "Favorite note", checked: () => Boolean(currentNote()?.favorite), run: () => void setFlags({ favorite: !currentNote()?.favorite }) },
        { sep: true },
        { id: "edit.trash", label: "Move to trash", shortcut: "Del", run: () => void trashNote() },
        { id: "edit.restore", label: "Restore note", run: () => void restoreNote() },
        {
          id: "edit.purge",
          label: "Delete forever…",
          danger: true,
          confirm: "Delete this note forever? Undo still works until the app closes, but the note is gone from the library.",
          run: () => void purgeNote(),
        },
        { sep: true },
        { id: "edit.clear", label: "Clear selection or search", shortcut: "Esc", run: clearContext },
      ],
    },
    { label: "Format", items: FORMAT_ITEMS },
    {
      label: "View",
      items: [
        { id: "view.edit", label: "Edit", shortcut: "Ctrl+1", checked: () => viewMode === "edit", run: () => setViewMode("edit") },
        { id: "view.split", label: "Split", shortcut: "Ctrl+2", checked: () => viewMode === "split", run: () => setViewMode("split") },
        { id: "view.preview", label: "Preview", shortcut: "Ctrl+3", checked: () => viewMode === "preview", run: () => setViewMode("preview") },
        { sep: true },
        { id: "view.cycle", label: "Next layout", shortcut: "Ctrl+E", run: cycleViewMode },
        { sep: true },
        { id: "view.sortUpdated", label: "Sort by updated", checked: () => sortMode === "updated", run: () => setSort("updated") },
        { id: "view.sortCreated", label: "Sort by created", checked: () => sortMode === "created", run: () => setSort("created") },
        { id: "view.sortTitle", label: "Sort by title", checked: () => sortMode === "title", run: () => setSort("title") },
        { sep: true },
        ...window.NucleusShell.standardViewMenu(),
      ],
    },
    { label: "Help", items: window.NucleusShell.standardHelpMenu() },
  ],
  primary: { id: "file.newNote" },
  noun: (ids) => plural(ids.length, "note"),
  options: (ctx) => {
    const note = currentNote();
    if (!note) return { left: searchField, hint: "Ctrl N starts a note." };

    const ids = [];
    // Formatting rides in the options bar while there is room for it; below
    // ~1200 px the Format menu keeps every action, the bar stays readable.
    if (!note.trashedAt && ctx.mode !== "preview" && window.innerWidth >= 1200) {
      ids.push("format.bold", "format.italic", "format.h1", "format.list", "format.task", "format.quote", "format.link");
    }
    ids.push("view.history");

    return {
      left: searchField,
      label: ctx.mode === "preview" ? `${notebookName(note.notebookId)} / ${note.title || "Untitled"}` : "",
      hint: note.trashedAt ? "Read-only — this note is in the trash." : savedLabel(note),
      ids,
      right: modeSeg(),
    };
  },
  rail: [
    { id: "notes", icon: "note", label: "Notes" },
    { id: "history", icon: "history", label: "History" },
  ],
  panels: { left: notesPanel },
  status: {
    left: () => {
      const node = document.createElement("span");
      node.className = "n-status";
      const dot = document.createElement("span");
      dot.className = "c-dot";
      if (status.kind === "busy") dot.classList.add("c-dot--busy");
      if (status.kind === "error") dot.classList.add("c-dot--err");
      node.append(dot, document.createTextNode(status.text));
      return node;
    },
    right: () => {
      const note = currentNote();
      if (!note) {
        const stats = state.stats ?? EMPTY_STATS;
        return `${plural(stats.notes, "note")} · ${plural(stats.notebooks, "notebook")} · ${stats.trashed} in trash`;
      }
      const words = countWords(editor.value);
      const reading = words === 0 ? 0 : Math.max(1, Math.round(words / 200));
      const parts = [plural(words, "word"), `${editor.value.length} chars`, `${reading} min read`];
      parts.push(notebookName(note.notebookId));
      if (note.trashedAt) parts.push("read-only");
      return parts.join(" · ");
    },
  },
  enabled: {
    "file.renameNotebook": () => Boolean(selectedNotebook()),
    "file.deleteNotebook": () => Boolean(selectedNotebook()),
    "file.saveCopy": () => state.stats.notes > 0,
    "file.exportNote": () => Boolean(currentNote()),
    "file.exportAll": () => state.stats.notes > 0,
    "edit.undo": () => Boolean(state.canUndo) && !saving,
    "edit.redo": () => Boolean(state.canRedo) && !saving,
    "edit.quickOpen": () => liveNotes().length > 0,
    "edit.duplicate": () => Boolean(currentNote()) && !currentNote().trashedAt,
    "edit.pin": () => Boolean(currentNote()) && !currentNote().trashedAt,
    "edit.favorite": () => Boolean(currentNote()) && !currentNote().trashedAt,
    "edit.trash": () => Boolean(currentNote()) && !currentNote().trashedAt,
    "edit.restore": () => Boolean(currentNote()?.trashedAt),
    "edit.purge": () => Boolean(currentNote()?.trashedAt),
    "edit.clear": () => selection.size > 0 || detailsOpen || query !== "",
    "format.bold": () => editable(),
    "format.italic": () => editable(),
    "format.h1": () => editable(),
    "format.h2": () => editable(),
    "format.h3": () => editable(),
    "format.list": () => editable(),
    "format.numbered": () => editable(),
    "format.task": () => editable(),
    "format.quote": () => editable(),
    "format.link": () => editable(),
    "format.code": () => editable(),
    "format.snippet": () => editable(),
    "format.table": () => editable(),
    "format.rule": () => editable(),
  },
  highlight: (ids, kind) => {
    if (!listNode) return;
    for (const row of listNode.querySelectorAll("[data-id]")) {
      const touched = ids.includes(row.dataset.id);
      row.classList.toggle("is-touched", touched);
      row.classList.toggle("is-added", touched && kind === "added");
    }
  },
});

function editable() {
  const note = currentNote();
  return Boolean(note) && !note.trashedAt && viewMode !== "preview";
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

void (async () => {
  await refresh();

  // The layout is a setting (server-side, never localStorage). The window size
  // only decides the default for a fresh install.
  try {
    const json = await (await fetch("/api/settings")).json();
    const saved = json?.settings?.viewMode;
    if (MODES.includes(saved)) {
      viewMode = saved;
      renderMode();
      sync({ panels: false });
    }
  } catch {
    /* no settings endpoint: keep the default */
  }

  const first = visibleNotes()[0];
  if (first) await openNote(first.id);
})();

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
