import {
  detectStructuredKind,
  parseStructured,
  serializeStructured,
} from "./structured.mjs";

const state = {
  workspace: null,
  activeView: "libraries",
  activeFile: null,
  originalContent: "",
  dirty: false,
  mode: "edit",
  structuredKind: null,
  structuredView: null,
  filter: "",
  loadingFile: false,
  saving: false,
  deleting: false,
  searching: false,
  searchResults: [],
  searchTruncation: null,
  searchSequence: 0,
  searchTimer: null,
  // 记住作者手动展开/收起过的目录，重绘文件树时不要把人正在翻的章节文件夹关掉
  expandedDirs: new Set(),
  collapsedDirs: new Set(),
};

const elements = {
  workspaceName: document.querySelector("#workspaceName"),
  workspacePath: document.querySelector("#workspacePath"),
  connectionStatus: document.querySelector("#connectionStatus"),
  treeSearch: document.querySelector("#treeSearch"),
  libraryCount: document.querySelector("#libraryCount"),
  projectCount: document.querySelector("#projectCount"),
  fileCount: document.querySelector("#fileCount"),
  librariesBadge: document.querySelector("#librariesBadge"),
  projectsBadge: document.querySelector("#projectsBadge"),
  archiveTabs: [...document.querySelectorAll(".archive-tabs [role='tab']")],
  treePanel: document.querySelector("#treePanel"),
  treeLoading: document.querySelector("#treeLoading"),
  fileTree: document.querySelector("#fileTree"),
  refreshButton: document.querySelector("#refreshButton"),
  mobileBackButton: document.querySelector("#mobileBackButton"),
  editorEmpty: document.querySelector("#editorEmpty"),
  editorWorkspace: document.querySelector("#editorWorkspace"),
  editorTitle: document.querySelector("#editorTitle"),
  breadcrumbs: document.querySelector("#breadcrumbs"),
  dirtyStatus: document.querySelector("#dirtyStatus"),
  documentMeta: document.querySelector("#documentMeta"),
  editorInput: document.querySelector("#editorInput"),
  previewPane: document.querySelector("#previewPane"),
  modeButtons: [...document.querySelectorAll(".mode-switch button")],
  structuredModeButton: document.querySelector("#structuredModeButton"),
  structuredPane: document.querySelector("#structuredPane"),
  deleteButton: document.querySelector("#deleteButton"),
  saveButton: document.querySelector("#saveButton"),
  cursorPosition: document.querySelector("#cursorPosition"),
  encodingLabel: document.querySelector("#encodingLabel"),
  toastRegion: document.querySelector("#toastRegion"),
  conflictDialog: document.querySelector("#conflictDialog"),
  reloadConflictButton: document.querySelector("#reloadConflictButton"),
  truncationNotice: null,
};

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function requestJson(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    setConnection("offline", "连接中断");
    throw new ApiError(0, "network_error", "无法连接本地 Dashboard 服务");
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.error?.code || "request_failed",
      payload?.error?.message || `请求失败（${response.status}）`,
    );
  }
  setConnection("online", "仅本机");
  return payload;
}

function setConnection(status, label) {
  elements.connectionStatus.dataset.state = status;
  elements.connectionStatus.querySelector("span:last-child").textContent = label;
}

function showToast(message, kind = "success") {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.dataset.kind = kind;
  const text = document.createElement("p");
  text.textContent = message;
  toast.append(text);
  elements.toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(value || 0);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function countCharacters(content) {
  return [...content.replace(/\s/g, "")].length;
}

// textarea 的 value 永远是 LF：读盘时先归一化，写盘时再换回原文件的换行符，
// 否则 CRLF 稿件会被一次改动整篇重写，而且脏标记永远对不上、清不掉。
function detectEol(content) {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\r") {
      if (content[index + 1] === "\n") {
        crlf += 1;
        index += 1;
      } else {
        cr += 1;
      }
    } else if (content[index] === "\n") {
      lf += 1;
    }
  }
  // 按 LF/CRLF 的主流风格回写；只有纯 CR 文件才保留 CR。一个粘贴进来的孤立 CR
  // 不能把每个 LF 都扩散成 CR，反过来也不能让 CRLF 稿件整篇变成 LF。
  if (crlf > lf) return "\r\n";
  if (lf > 0) return "\n";
  if (cr > 0) return "\r";
  return "\n";
}

function normalizeEol(content) {
  return content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function applyEol(content, eol) {
  return !eol || eol === "\n" ? content : content.replaceAll("\n", eol);
}

function activeEol() {
  return state.activeFile?.eol || "\n";
}

function currentByteSize() {
  return new TextEncoder().encode(applyEol(elements.editorInput.value, activeEol())).length;
}

function fileExtension(name) {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1) : "";
}

function iconSvg(kind) {
  if (kind === "folder") {
    return `<svg class="tree-icon folder-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l2 2h9v10h-17z"></path></svg>`;
  }
  return `<svg class="tree-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4v13H6z"></path><path d="M14 3.5v4h4M9 12h6M9 16h5"></path></svg>`;
}

function createTreeEntry(node, depth = 0) {
  const item = document.createElement("li");
  if (node.type === "directory") {
    const details = document.createElement("details");
    details.dataset.path = node.path;
    const shouldOpen =
      state.expandedDirs.has(node.path) ||
      (depth === 0 && !state.collapsedDirs.has(node.path));
    details.open = shouldOpen;
    // 只记录作者亲手的展开/收起；首层程序化展开不算偏好。
    let recorded = shouldOpen;
    details.addEventListener("toggle", () => {
      if (details.open === recorded) return;
      recorded = details.open;
      if (details.open) {
        state.expandedDirs.add(node.path);
        state.collapsedDirs.delete(node.path);
        if (!node.loaded && !node.loading) loadDirectory(node);
      } else {
        state.expandedDirs.delete(node.path);
        state.collapsedDirs.add(node.path);
      }
    });
    const summary = document.createElement("summary");
    summary.innerHTML = iconSvg("folder");
    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = node.name;
    summary.append(label);
    details.append(summary);

    const list = document.createElement("ul");
    node.children.forEach((child) => {
      const childItem = createTreeEntry(child, depth + 1);
      if (childItem) list.append(childItem);
    });
    if (node.loading) {
      const loading = document.createElement("li");
      loading.className = "tree-inline-status";
      loading.textContent = "正在读取目录…";
      list.append(loading);
    } else if (node.loadError) {
      const retry = document.createElement("li");
      retry.className = "tree-inline-status";
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "目录加载失败，点击重试";
      button.addEventListener("click", () => loadDirectory(node));
      retry.append(button);
      list.append(retry);
    } else if (node.loaded && node.children.length === 0) {
      const empty = document.createElement("li");
      empty.className = "tree-inline-status";
      empty.textContent = "空目录";
      list.append(empty);
    }
    if (node.nextCursor && !node.loading) {
      const more = document.createElement("li");
      more.className = "tree-inline-status";
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "加载更多";
      button.addEventListener("click", () => loadDirectory(node, { append: true }));
      more.append(button);
      list.append(more);
    }
    details.append(list);
    item.append(details);
    if (shouldOpen && !node.loaded && !node.loading && !node.loadError && !node.loadQueued) {
      node.loadQueued = true;
      window.queueMicrotask(() => {
        node.loadQueued = false;
        if (!node.loaded && !node.loading && !node.loadError) loadDirectory(node);
      });
    }
    return item;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "file-row";
  button.dataset.path = node.path;
  button.dataset.active = String(state.activeFile?.path === node.path);
  button.disabled = !node.editable;
  button.title = node.editable ? node.path : `${node.path}（此文件类型只展示，不可编辑）`;
  button.innerHTML = iconSvg("file");

  const label = document.createElement("span");
  label.className = "tree-label";
  label.textContent = node.name;
  button.append(label);

  const extension = document.createElement("span");
  extension.className = "file-ext";
  extension.textContent = fileExtension(node.name);
  button.append(extension);
  if (node.editable) {
    button.addEventListener("click", () => openFile(node.path));
  }
  item.append(button);
  return item;
}

function mergeDirectoryEntries(node, entries, append) {
  if (!append) {
    node.children = entries;
    return;
  }
  const existingPaths = new Set(node.children.map((entry) => entry.path));
  node.children.push(...entries.filter((entry) => !existingPaths.has(entry.path)));
}

async function loadDirectory(node, { append = false } = {}) {
  if (node.loading) return;
  node.loading = true;
  node.loadError = "";
  renderTree();
  try {
    const cursor = append && node.nextCursor ? `&cursor=${encodeURIComponent(node.nextCursor)}` : "";
    const page = await requestJson(`/api/tree?path=${encodeURIComponent(node.path)}${cursor}`);
    mergeDirectoryEntries(node, page.entries, append);
    node.nextCursor = page.nextCursor;
    node.loaded = true;
  } catch (error) {
    node.loadError = error.message;
    showToast(error.message, "error");
  } finally {
    node.loading = false;
    renderLoadedFileCount();
    renderTree();
  }
}

function loadedFileCount() {
  const paths = new Set();
  function visit(node) {
    if (node.type === "file") {
      paths.add(node.path);
      return;
    }
    node.children.forEach(visit);
  }
  state.workspace?.libraries.forEach(visit);
  state.workspace?.projects.forEach(visit);
  return paths.size;
}

function renderLoadedFileCount() {
  if (!state.workspace) return;
  const count = loadedFileCount();
  elements.fileCount.textContent = count ? `${formatNumber(count)}+` : "按需";
  elements.fileCount.title = "文稿随目录展开按需加载，不预先遍历整个工作区";
}

// 只改当前高亮行，不重建整棵树——重建会把作者正在翻的目录全部收起
function syncActiveRow() {
  const activePath = state.activeFile?.path;
  elements.fileTree.querySelectorAll(".file-row").forEach((row) => {
    row.dataset.active = String(row.dataset.path === activePath);
  });
}

function searchTruncationMessage() {
  const status = state.searchTruncation;
  if (!status) return "";
  const messages = [];
  if (status.byResults) {
    messages.push(
      `匹配结果超过 ${formatNumber(status.limits.maxResults)} 条，仅显示最先找到的部分，请输入更精确的文件名`,
    );
  }
  if (status.byNodes) {
    messages.push(
      `搜索达到 ${formatNumber(status.limits.maxNodes)} 个节点的扫描上限，后续目录尚未检查，请直接展开目标目录查找`,
    );
  }
  if (status.byDepth) {
    messages.push(
      `部分目录超过 ${formatNumber(status.limits.maxDepth)} 层，更深处未搜索；其他项目已继续搜索`,
    );
  }
  if (status.byReadError) {
    const paths = status.scanErrors.map((entry) => entry.path).filter(Boolean);
    const shown = paths.slice(0, 3).join("、") || "部分目录";
    const more = paths.length > 3 ? `等 ${formatNumber(paths.length)} 处` : "";
    messages.push(
      `${shown}${more}无法读取，搜索结果可能不完整。请检查目录访问权限或外挂盘挂载状态`,
    );
  }
  return messages.join("；");
}

function renderTree() {
  elements.fileTree.replaceChildren();
  elements.treeLoading.hidden = true;
  const query = state.filter.trim();
  const collection = query
    ? state.searchResults
    : state.workspace?.[state.activeView] || [];

  if (query && state.searching) {
    const message = document.createElement("div");
    message.className = "tree-message";
    const text = document.createElement("p");
    text.textContent = `正在搜索“${query}”…`;
    message.append(text);
    elements.fileTree.append(message);
    return;
  }

  if (!collection.length) {
    const message = document.createElement("div");
    message.className = "tree-message";
    const text = document.createElement("p");
    text.textContent = query
      ? state.searchTruncation
        ? `搜索未完成，暂时无法确认是否存在“${query}”`
        : `没有找到“${query}”`
      : state.activeView === "libraries"
        ? "工作区里还没有拆文库。运行拆文 skill 后，档案会出现在这里。"
        : "还没有识别到写作项目。长篇需包含正文、大纲、设定或追踪目录；短篇需包含正文.md，并同时包含小节大纲.md或设定.md。";
    message.append(text);
    elements.fileTree.append(message);
    const truncation = searchTruncationMessage();
    if (query && truncation) {
      const status = document.createElement("div");
      status.className = "tree-message";
      status.setAttribute("role", "status");
      const statusText = document.createElement("p");
      statusText.textContent = truncation;
      status.append(statusText);
      elements.fileTree.append(status);
    }
    return;
  }

  const list = document.createElement("ul");
  collection.forEach((node) => {
    const item = createTreeEntry(node);
    if (item) list.append(item);
  });
  const truncation = searchTruncationMessage();
  if (query && truncation) {
    const status = document.createElement("li");
    status.className = "tree-inline-status";
    status.setAttribute("role", "status");
    status.textContent = truncation;
    list.append(status);
  }
  elements.fileTree.append(list);
}

function truncationMessage(scanErrors = []) {
  const paths = scanErrors.map((entry) => entry.path).filter(Boolean);
  const shown = paths.slice(0, 3).join("、") || "部分目录";
  const more = paths.length > 3 ? `等 ${formatNumber(paths.length)} 处` : "";
  return `${shown}${more}无法读取，其中的文稿没有列出。请检查这些目录的访问权限和外挂盘挂载状态，恢复后刷新目录。`;
}

function renderTruncationNotice(limits, scanErrors) {
  if (!limits?.truncated) {
    elements.truncationNotice?.remove();
    elements.truncationNotice = null;
    return;
  }
  if (!elements.truncationNotice) {
    const notice = document.createElement("div");
    notice.id = "treeTruncationNotice";
    notice.className = "tree-message";
    notice.setAttribute("role", "status");
    notice.append(document.createElement("p"));
    elements.treePanel.insertBefore(notice, elements.fileTree);
    elements.truncationNotice = notice;
  }
  elements.truncationNotice.querySelector("p").textContent = truncationMessage(scanErrors);
}

function renderWorkspace() {
  const { workspace, stats, libraries, projects, limits, scanErrors } = state.workspace;
  elements.workspaceName.textContent = workspace.name;
  elements.workspacePath.textContent = workspace.path;
  elements.workspacePath.title = workspace.path;
  elements.libraryCount.textContent = formatNumber(stats.libraries);
  elements.projectCount.textContent = formatNumber(stats.projects);
  renderLoadedFileCount();
  elements.librariesBadge.textContent = formatNumber(libraries.length);
  elements.projectsBadge.textContent = formatNumber(projects.length);
  renderTruncationNotice(limits, scanErrors);
  renderTree();
}

async function loadWorkspace({ announce = false } = {}) {
  window.clearTimeout(state.searchTimer);
  state.searchSequence += 1;
  elements.treeLoading.hidden = false;
  elements.fileTree.replaceChildren();
  setConnection("", "连接中");
  try {
    state.workspace = await requestJson("/api/workspace");
    state.searchResults = [];
    state.searchTruncation = null;
    state.searching = Boolean(state.filter.trim());
    renderWorkspace();
    if (state.filter.trim()) scheduleSearch();
    if (announce) showToast("工作区目录已刷新");
  } catch (error) {
    elements.treeLoading.hidden = true;
    const message = document.createElement("div");
    message.className = "tree-message";
    const text = document.createElement("p");
    text.textContent = error.message;
    message.append(text);
    elements.fileTree.replaceChildren(message);
    showToast(error.message, "error");
  }
}

function confirmDiscard() {
  return !state.dirty || window.confirm("当前文稿还有未保存的修改。确定放弃并打开另一份文件吗？");
}

function setDirty(dirty) {
  state.dirty = dirty;
  elements.dirtyStatus.dataset.state = dirty ? "dirty" : "saved";
  elements.dirtyStatus.querySelector("span:last-child").textContent = dirty ? "待保存" : "已保存";
  syncActionAvailability();
}

function syncActionAvailability() {
  const busy = state.loadingFile || state.saving || state.deleting;
  elements.saveButton.disabled = busy || !state.dirty;
  elements.deleteButton.disabled = busy || !state.activeFile;
}

function setSaving(saving) {
  state.saving = saving;
  elements.dirtyStatus.dataset.state = saving ? "saving" : state.dirty ? "dirty" : "saved";
  elements.dirtyStatus.querySelector("span:last-child").textContent = saving
    ? "保存中"
    : state.dirty
      ? "待保存"
      : "已保存";
  syncActionAvailability();
}

function renderBreadcrumbs(path) {
  elements.breadcrumbs.replaceChildren();
  path.split("/").forEach((part, index, parts) => {
    const label = document.createElement("span");
    label.textContent = part;
    elements.breadcrumbs.append(label);
    if (index < parts.length - 1) {
      const divider = document.createElement("i");
      divider.textContent = "／";
      elements.breadcrumbs.append(divider);
    }
  });
}

function updateDocumentMeta() {
  if (!state.activeFile) return;
  const content = elements.editorInput.value;
  elements.documentMeta.textContent = [
    formatBytes(currentByteSize()),
    `${formatNumber(countCharacters(content))} 字符`,
    fileExtension(state.activeFile.name).toUpperCase(),
  ].join("  ·  ");
}

function updateCursorPosition() {
  const content = elements.editorInput.value;
  const caret = elements.editorInput.selectionStart;
  const before = content.slice(0, caret);
  const lines = before.split("\n");
  elements.cursorPosition.textContent = `第 ${lines.length} 行，第 ${[...lines.at(-1)].length + 1} 列`;
}

async function openFile(path, { force = false } = {}) {
  if (state.loadingFile || (!force && !confirmDiscard())) return;
  state.loadingFile = true;
  syncActionAvailability();
  elements.fileTree.setAttribute("aria-busy", "true");
  try {
    const file = await requestJson(`/api/file?path=${encodeURIComponent(path)}`);
    const normalized = normalizeEol(file.content);
    file.eol = detectEol(file.content);
    file.content = normalized;
    state.activeFile = file;
    state.originalContent = normalized;
    elements.editorInput.value = normalized;
    elements.editorTitle.textContent = file.name;
    renderBreadcrumbs(file.path);
    state.structuredKind = detectStructuredKind(file.path);
    state.structuredView = null;
    elements.structuredModeButton.hidden = !state.structuredKind;
    setDirty(false);
    setMode("edit");
    updateDocumentMeta();
    updateCursorPosition();
    elements.editorEmpty.hidden = true;
    elements.editorWorkspace.hidden = false;
    document.body.classList.add("document-open");
    syncActiveRow();
    window.requestAnimationFrame(() => elements.editorInput.focus());
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    state.loadingFile = false;
    syncActionAvailability();
    elements.fileTree.removeAttribute("aria-busy");
  }
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function inlineMarkdown(value) {
  return value
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
}

function markdownToSafeHtml(markdown) {
  const lines = escapeHtml(markdown).replaceAll("\r\n", "\n").split("\n");
  const output = [];
  let inCode = false;
  let codeLines = [];
  let listType = null;
  let tableRows = [];

  const closeList = () => {
    if (listType) output.push(`</${listType}>`);
    listType = null;
  };

  const flushTable = () => {
    if (!tableRows.length) return;
    const parsed = tableRows.map((line) => {
      const cells = line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
      return cells;
    });
    let header = null;
    const rows = [];
    for (const cells of parsed) {
      if (!header) header = cells;
      else if (cells.every((c) => /^[-:]+$/.test(c) || c === "")) continue;
      else rows.push(cells);
    }
    if (header) {
      output.push(`<div class="md-table"><table><thead><tr>`);
      for (const cell of header) output.push(`<th>${inlineMarkdown(cell)}</th>`);
      output.push("</tr></thead><tbody>");
      for (const cells of rows) {
        output.push("<tr>");
        header.forEach((_, i) => output.push(`<td>${inlineMarkdown(cells[i] ?? "")}</td>`));
        output.push("</tr>");
      }
      output.push("</tbody></table></div>");
    }
    tableRows = [];
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      closeList();
      flushTable();
      if (inCode) {
        output.push(`<pre><code>${codeLines.join("\n")}</code></pre>`);
        codeLines = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      closeList();
      tableRows.push(line);
      continue;
    }
    if (tableRows.length) flushTable();

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
    } else if (unordered || ordered) {
      const nextType = unordered ? "ul" : "ol";
      if (listType !== nextType) {
        closeList();
        listType = nextType;
        output.push(`<${listType}>`);
      }
      output.push(`<li>${inlineMarkdown((unordered || ordered)[1])}</li>`);
    } else if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      closeList();
      output.push("<hr>");
    } else if (line.startsWith("&gt; ")) {
      closeList();
      output.push(`<blockquote>${inlineMarkdown(line.slice(5))}</blockquote>`);
    } else if (line.trim()) {
      closeList();
      output.push(`<p>${inlineMarkdown(line)}</p>`);
    } else {
      closeList();
    }
  }
  if (inCode) output.push(`<pre><code>${codeLines.join("\n")}</code></pre>`);
  flushTable();
  closeList();
  return output.join("");
}

function setMode(mode) {
  state.mode = mode;
  elements.modeButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  });
  const previewing = mode === "preview";
  const structuring = mode === "structured";
  elements.editorInput.hidden = previewing || structuring;
  elements.previewPane.hidden = !previewing;
  elements.structuredPane.hidden = !structuring;
  if (previewing) {
    elements.previewPane.innerHTML = markdownToSafeHtml(elements.editorInput.value);
  } else if (structuring) {
    if (state.structuredKind) {
      state.structuredView = parseStructured(elements.editorInput.value, state.structuredKind);
      renderStructured();
    }
  } else {
    window.requestAnimationFrame(() => elements.editorInput.focus());
  }
}

async function saveFile() {
  if (!state.activeFile || !state.dirty || state.saving || state.deleting) return;
  // 请求发出前就把身份和正文快照下来：保存期间作者可能换文件、也可能接着敲字，
  // 收尾只允许写回这次真正送出去的那份，绝不能落到别的文稿头上。
  const file = state.activeFile;
  const sent = elements.editorInput.value;
  setSaving(true);
  try {
    const saved = await requestJson("/api/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: file.path,
        content: applyEol(sent, file.eol),
        expectedVersion: file.version,
      }),
    });
    file.mtimeMs = saved.mtimeMs;
    file.version = saved.version;
    file.size = saved.size;
    showToast(`已保存《${file.name}》`);
    if (state.activeFile !== file) return;
    state.originalContent = sent;
    // 保存途中敲进来的字仍是未保存修改，不能被这次结果抹平成「已保存」
    setDirty(elements.editorInput.value !== sent);
    updateDocumentMeta();
  } catch (error) {
    if (state.activeFile !== file) {
      showToast(`《${file.name}》保存失败：${error.message}`, "error");
      return;
    }
    setDirty(true);
    if (error instanceof ApiError && error.status === 409) {
      elements.conflictDialog.showModal();
    } else {
      showToast(error.message, "error");
    }
  } finally {
    setSaving(false);
  }
}

async function deleteFile() {
  if (!state.activeFile || state.saving || state.deleting) return;
  const file = state.activeFile;
  const warning = state.dirty
    ? `《${file.name}》还有未保存修改。删除会永久移除磁盘文件并丢弃这些修改，且无法撤销。确定删除吗？`
    : `确定永久删除《${file.name}》吗？此操作无法撤销。`;
  if (!window.confirm(warning)) return;

  state.deleting = true;
  syncActionAvailability();
  try {
    await requestJson("/api/file", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: file.path,
        expectedVersion: file.version,
      }),
    });
    state.activeFile = null;
    state.originalContent = "";
    elements.editorInput.value = "";
    elements.editorWorkspace.hidden = true;
    elements.editorEmpty.hidden = false;
    document.body.classList.remove("document-open");
    setDirty(false);
    await loadWorkspace();
    showToast(`已删除《${file.name}》`);
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    state.deleting = false;
    syncActionAvailability();
  }
}

async function searchWorkspace(query, sequence) {
  state.searching = true;
  renderTree();
  try {
    const result = await requestJson(
      `/api/search?q=${encodeURIComponent(query)}&scope=${encodeURIComponent(state.activeView)}`,
    );
    if (sequence !== state.searchSequence) return;
    state.searchResults = result.results;
    state.searchTruncation = result.truncated
      ? {
          ...(result.truncation || {
            byResults: true,
            byNodes: false,
            byDepth: false,
            byReadError: false,
          }),
          scanErrors: result.scanErrors || [],
          limits: result.limits,
        }
      : null;
  } catch (error) {
    if (sequence !== state.searchSequence) return;
    state.searchResults = [];
    state.searchTruncation = null;
    showToast(error.message, "error");
  } finally {
    if (sequence === state.searchSequence) {
      state.searching = false;
      renderTree();
    }
  }
}

function scheduleSearch() {
  window.clearTimeout(state.searchTimer);
  const query = state.filter.trim();
  state.searchSequence += 1;
  const sequence = state.searchSequence;
  if (!query) {
    state.searching = false;
    state.searchResults = [];
    state.searchTruncation = null;
    renderTree();
    return;
  }
  state.searching = true;
  renderTree();
  state.searchTimer = window.setTimeout(() => searchWorkspace(query, sequence), 180);
}

function setActiveView(view) {
  state.activeView = view;
  elements.archiveTabs.forEach((tab) => {
    const selected = tab.dataset.view === view;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  elements.treePanel.setAttribute(
    "aria-labelledby",
    view === "libraries" ? "librariesTab" : "projectsTab",
  );
  if (state.filter.trim()) {
    scheduleSearch();
  } else {
    renderTree();
  }
}

elements.archiveTabs.forEach((tab) => {
  tab.addEventListener("click", () => setActiveView(tab.dataset.view));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const current = elements.archiveTabs.indexOf(event.currentTarget);
    const next = elements.archiveTabs.at(
      (current + direction + elements.archiveTabs.length) % elements.archiveTabs.length,
    );
    setActiveView(next.dataset.view);
    next.focus();
  });
});

elements.treeSearch.addEventListener("input", (event) => {
  state.filter = event.currentTarget.value;
  scheduleSearch();
});

elements.treeSearch.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.currentTarget.value = "";
    state.filter = "";
    scheduleSearch();
  }
});

elements.refreshButton.addEventListener("click", () => loadWorkspace({ announce: true }));
elements.mobileBackButton.addEventListener("click", () => {
  document.body.classList.remove("document-open");
  window.requestAnimationFrame(() => elements.treeSearch.focus());
});
elements.saveButton.addEventListener("click", saveFile);
elements.deleteButton.addEventListener("click", deleteFile);

elements.editorInput.addEventListener("input", () => {
  setDirty(elements.editorInput.value !== state.originalContent);
  updateDocumentMeta();
  updateCursorPosition();
});

["click", "keyup", "select"].forEach((eventName) => {
  elements.editorInput.addEventListener(eventName, updateCursorPosition);
});

elements.modeButtons.forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});

elements.conflictDialog.addEventListener("close", () => {
  if (elements.conflictDialog.returnValue === "reload" && state.activeFile) {
    openFile(state.activeFile.path, { force: true });
  }
});

document.addEventListener("keydown", (event) => {
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && event.key.toLocaleLowerCase() === "s") {
    event.preventDefault();
    saveFile();
  }
  if (modifier && event.key.toLocaleLowerCase() === "k") {
    event.preventDefault();
    elements.treeSearch.focus();
    elements.treeSearch.select();
  }
});


// ================= 结构化视图（设定 / 角色卡 / 角色线 / 角色状态） ==================
function createStructuredElement(tag, cls) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

function structuredRows(value) {
  const count = String(value ?? "").split("\n").length + 1;
  return Math.max(3, Math.min(count, 16)); // 身高按内容自适应，封顶 16 行
}

function renderFieldRow(label, value, bind) {
  const row = createStructuredElement("div", "s-field");
  const dt = createStructuredElement("dt");
  dt.textContent = label;
  const dd = createStructuredElement("dd");
  const ta = createStructuredElement("textarea", "s-field-input");
  ta.value = String(value ?? "");
  ta.rows = structuredRows(value);
  ta.dataset.bind = JSON.stringify(bind);
  dd.append(ta);
  row.append(dt, dd);
  return row;
}

function renderStructuredGroup(title, count) {
  const group = createStructuredElement("section", "s-group");
  const heading = createStructuredElement("h3", "s-group-title");
  heading.textContent = title;
  if (count) { const badge = createStructuredElement("span", "s-count"); badge.textContent = count; heading.append(badge); }
  const body = createStructuredElement("div", "s-fields");
  group.append(heading, body);
  return { group, body };
}

function renderStructuredMaster(view) {
  const master = createStructuredElement("div", "s-master");
  const title = String(view.title || "").trim();
  const avatar = createStructuredElement("div", "s-avatar");
  avatar.textContent = title.replace(/^角色线：/, "").trim().charAt(0) || "设";
  const copy = createStructuredElement("div");
  const heading = createStructuredElement("h2");
  heading.textContent = title || "(未命名)";
  copy.append(heading);
  const sub = createStructuredElement("p", "s-sub");
  sub.textContent = view.kind === "character-card" ? "角色卡 · 设定/角色" :
    view.kind === "arc" ? "角色线 · 弧线定义 + 阶段规划" :
    view.kind === "character-status" ? "角色状态 · 追踪/角色状态" : "设定文档";
  copy.append(sub);
  if (Array.isArray(view.aliases) && view.aliases.length) {
    const tags = createStructuredElement("div", "s-tags");
    for (const alias of view.aliases) { const tag = createStructuredElement("span", "s-tag"); tag.textContent = alias; tags.append(tag); }
    copy.append(tags);
  }
  master.append(avatar, copy);
  return master;
}

function renderTableGroup(view) {
  const group = createStructuredElement("section", "s-group");
  const heading = createStructuredElement("h3", "s-group-title");
  heading.textContent = "出场记录";
  const badge = createStructuredElement("span", "s-count");
  badge.textContent = view.table.rows.length + " 行";
  heading.append(badge);
  group.append(heading);
  const wrap = createStructuredElement("div", "s-table-wrap");
  const table = createStructuredElement("table");
  const thead = createStructuredElement("thead");
  const headRow = createStructuredElement("tr");
  for (const cell of view.table.header) { const th = createStructuredElement("th"); th.textContent = cell; headRow.append(th); }
  thead.append(headRow);
  table.append(thead);
  const tbody = createStructuredElement("tbody");
  for (const row of view.table.rows) {
    const tr = createStructuredElement("tr");
    view.table.header.forEach((_, i) => { const td = createStructuredElement("td"); td.textContent = row[i] ?? ""; tr.append(td); });
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  group.append(wrap);
  return group;
}

// overridden：已被结构化渲染的节标题，不再进「其他小节」原始编辑；
// skipPre：角色状态的头部前置行已被 header 渲染。
function renderRawSections(view, overridden, options = {}) {
  const raw = view.rawSections || [];
  const stack = createStructuredElement("div", "s-fields");
  let shown = 0;
  raw.forEach((part, index) => {
    if (part.kind === "h1") return;
    if (part.kind === "section" && overridden.has((part.heading || "").trim())) return;
    if (part.kind === "pre" && options.skipPre) return;
    const details = createStructuredElement("details", "s-raw-section");
    const summary = createStructuredElement("summary");
    if (part.kind === "hr") { summary.textContent = "——— 分隔线 ———"; details.classList.add("s-raw-note"); }
    else summary.textContent = part.kind === "pre" ? "§ 前言 / 文档说明" : "§ " + (part.heading || "未命名节");
    details.append(summary);
    if (part.kind !== "hr") {
      const body = createStructuredElement("div", "s-raw-body");
      const hint = createStructuredElement("p", "s-raw-hint");
      hint.textContent = "按 Markdown 原文编辑，保存时原样写回。";
      body.append(hint);
      const ta = createStructuredElement("textarea", "s-raw-input");
      ta.value = part.kind === "pre" ? part.text : (part.lines || []).join("\n");
      ta.rows = structuredRows(ta.value);
      ta.dataset.bind = JSON.stringify({ k: "r", i: index });
      body.append(ta);
      details.append(body);
    }
    stack.append(details);
    shown += 1;
  });
  if (!shown) return null;
  const group = createStructuredElement("section", "s-group");
  const heading = createStructuredElement("h3", "s-group-title");
  heading.textContent = "其他小节";
  group.append(heading, stack);
  return group;
}

function renderStructured() {
  const view = state.structuredView;
  if (!view) return;
  const pane = elements.structuredPane;
  pane.replaceChildren();
  const scroll = createStructuredElement("div", "s-scroll");
  scroll.append(renderStructuredMaster(view));
  if (view.kind === "character-card") {
    if (view.basic.length) {
      const g = renderStructuredGroup("基本信息");
      view.basic.forEach((field, i) => g.body.append(renderFieldRow(field.core, field.value, { k: "f", set: "basic", i })));
      scroll.append(g.group);
    }
    if (view.table) scroll.append(renderTableGroup(view));
    const raw = renderRawSections(view, new Set(["基本信息", "出场记录"]));
    if (raw) scroll.append(raw);
  } else if (view.kind === "arc") {
    if (view.definition.length) {
      const g = renderStructuredGroup("弧线定义");
      view.definition.forEach((field, i) => g.body.append(renderFieldRow(field.core, field.value, { k: "def", i })));
      scroll.append(g.group);
    }
    if (view.stages.length) {
      const g = renderStructuredGroup("阶段规划", view.stages.length + " 阶段");
      for (const stage of view.stages) {
        const details = createStructuredElement("details", "s-stage");
        details.open = true;
        const summary = createStructuredElement("summary");
        summary.textContent = stage.heading;
        details.append(summary);
        const body = createStructuredElement("div", "s-fields");
        stage.items.forEach((item, j) => body.append(renderFieldRow(item.core, item.value, { k: "stage", i: view.stages.indexOf(stage), j })));
        details.append(body);
        g.body.append(details);
      }
      scroll.append(g.group);
    }
    const overridden = new Set(["弧线定义", "阶段规划"]);
    for (const part of view.rawSections || []) {
      if (part.kind === "section" && /^阶段\s*\d+/.test((part.heading || "").trim())) overridden.add((part.heading || "").trim());
    }
    const raw = renderRawSections(view, overridden);
    if (raw) scroll.append(raw);
  } else if (view.kind === "character-status") {
    if (view.header.length) {
      const g = renderStructuredGroup("当前状态");
      view.header.forEach((field, i) => g.body.append(renderFieldRow(field.core, field.value, { k: "h", i })));
      scroll.append(g.group);
    }
    const raw = renderRawSections(view, new Set(), { skipPre: true });
    if (raw) scroll.append(raw);
  } else {
    const raw = renderRawSections(view, new Set(), { skipPre: false });
    if (raw) scroll.append(raw);
    else { const empty = createStructuredElement("p", "s-raw-hint"); empty.textContent = "该设定文档没有可拆分的小节。"; scroll.append(empty); }
  }
  pane.append(scroll);
}

function applyStructuredEdit(bind, value) {
  const view = state.structuredView;
  if (!view || !bind) return;
  if (bind.k === "f") { const list = view[bind.set]; if (list && list[bind.i]) list[bind.i].value = value; }
  else if (bind.k === "def") { if (view.definition && view.definition[bind.i]) view.definition[bind.i].value = value; }
  else if (bind.k === "stage") { const s = view.stages && view.stages[bind.i]; if (s && s.items && s.items[bind.j]) s.items[bind.j].value = value; }
  else if (bind.k === "h") { if (view.header && view.header[bind.i]) view.header[bind.i].value = value; }
  else if (bind.k === "r") {
    const part = view.rawSections && view.rawSections[bind.i];
    if (part) { if (part.kind === "pre") part.text = value; else part.lines = value.split("\n"); }
  }
  const md = serializeStructured(view);
  elements.editorInput.value = md;
  setDirty(md !== state.originalContent);
  updateDocumentMeta();
}

// 结构化视图的编辑事件（事件委托到面板容器）
elements.structuredPane.addEventListener("input", (event) => {
  const textarea = event.target.closest("textarea[data-bind]");
  if (!textarea) return;
  try { applyStructuredEdit(JSON.parse(textarea.dataset.bind), textarea.value); } catch { /* 忽略损坏的绑定 */ }
});

window.addEventListener("beforeunload", (event) => {
  if (state.dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});

loadWorkspace();
