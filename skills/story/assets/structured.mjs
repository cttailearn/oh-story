// structured.js — oh-story Dashboard 结构化视图：设定 / 角色卡 / 角色线 / 角色状态 的
// 解析与序列化（纯逻辑，无 DOM 依赖，可被 node:test 直接单测）。
//
// 设计铁律：只对「表单里可编辑的单元」重新生成文本，其余一律按原始切片原样拼回；
// 各节在文档中的出现顺序由 rawSections 保持，序列化时按顺序回放。

function toPosix(value) {
  return String(value).replace(/\\/g, "/");
}

export function detectStructuredKind(path) {
  const p = toPosix(path);
  if (!p.endsWith(".md")) return null;
  if (/设定\/角色\//.test(p)) return "character-card";
  if (/\/角色线\//.test(p)) return "arc";
  if (/追踪\/角色状态\//.test(p)) return "character-status";
  if (/设定\//.test(p)) return "settings-doc";
  return null;
}

// ---------- 行级 tokenizer ----------
function tokenize(md) {
  const lines = String(md).replace(/\r\n/g, "\n").split("\n");
  const nodes = [];
  let i = 0;
  if (lines.length && lines[0].trim() === "---") {
    const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === "---");
    if (end > 0) { nodes.push({ t: "fm", raw: lines.slice(0, end + 1).join("\n") }); i = end + 1; }
  }
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) { nodes.push({ t: "blank" }); continue; }
    if (/^#\s+/.test(line)) nodes.push({ t: "h1", text: line.replace(/^#\s+/, "").trim() });
    else {
      const hm = /^(#{2,4})\s+(.+?)\s*$/.exec(line);
      if (hm) nodes.push({ t: "h", level: hm[1].length, text: hm[2].trim() });
      else if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) nodes.push({ t: "hr" });
      else nodes.push({ t: "text", line });
    }
  }
  return nodes;
}

// 把 token 流切成有序段：h1 / hr / section（heading+正文行）/ pre（无标题前置行）
function groupSections(nodes) {
  const parts = [];
  let pending = null;
  const flush = () => { if (pending) { parts.push(pending); pending = null; } };
  for (const node of nodes) {
    if (node.t === "h1") { flush(); parts.push({ kind: "h1", text: node.text }); }
    else if (node.t === "hr") { flush(); parts.push({ kind: "hr" }); }
    else if (node.t === "h") { flush(); pending = { kind: "section", heading: node.text, level: node.level, lines: [] }; }
    else if (pending) pending.lines.push(node.t === "text" ? node.line : "");
    else if (node.t === "text") parts.push({ kind: "pre", text: node.line });
  }
  flush();
  return parts;
}

// ---------- 字段解析 ----------
// Field：{ kind:bold|label, leading, core, suffix, valueRaw, value }
// 只把「顶格（leading 为空）的 - **k**…：」或「- k…：」当作新字段；
// 缩进的子子弹/续行并入当前字段的值，逐行保真。
function parseFields(lines) {
  const fields = [];
  let current = null;
  for (const line of lines) {
    if (!line.trim()) { if (current) current.valueRaw.push(""); continue; }
    const bold = /^(\s*)-\s+\*\*(.+?)\*\*\s*([^：:]{0,60})[：:]\s*([\s\S]*)$/.exec(line);
    const label = /^(\s*)-\s+([^：:]{2,60})[：:]\s*([\s\S]*)$/.exec(line);
    if (bold && bold[1] === "") {
      current = { kind: "bold", leading: "", core: bold[2].trim(), suffix: bold[3], valueRaw: bold[4] ? [bold[4]] : [], value: bold[4] ?? "" };
      fields.push(current);
    } else if (label && label[1] === "" && !/^(?:#{1,4}\s)/.test(line)) {
      current = { kind: "label", leading: "", core: label[2].trim(), suffix: "", valueRaw: label[3] ? [label[3]] : [], value: label[3] ?? "" };
      fields.push(current);
    } else if (current) {
      current.valueRaw.push(line);
      current.value = current.valueRaw.join("\n");
    } else {
      fields.push({ kind: "prose", value: line, leading: "" });
    }
  }
  return fields;
}

function serializeFields(fields) {
  const out = [];
  for (const f of fields) {
    if (f.kind === "prose") { out.push(f.value); continue; }
    const head = f.kind === "bold" ? "**" + f.core + "**" + (f.suffix || "") : f.core;
    out.push("- " + head + "：" + f.value);
  }
  return out.join("\n");
}

// ---------- 表格 ----------
function parseTable(lines) {
  let header = null;
  const rows = [];
  for (const line of lines) {
    const m = /^\s*\|(.+)\|\s*$/.exec(line);
    if (!m) continue;
    const cells = m[1].split("|").map((c) => c.trim());
    const isSep = cells.every((c) => /^[-:]+$/.test(c) || c === "");
    if (isSep) continue;
    if (!header) header = cells;
    else rows.push(cells);
  }
  return header ? { header, rows } : null;
}

function serializeTable(table) {
  const esc = (c) => String(c).replace(/\|/g, "\\|");
  const out = ["| " + table.header.map(esc).join(" | ") + " |"];
  out.push("| " + table.header.map(() => "---").join(" | ") + " |");
  for (const row of table.rows) out.push("| " + row.map(esc).join(" | ") + " |");
  return out.join("\n");
}

const SKIP = Symbol.for("oh-story-structured:skip");
// serializeDoc(kindView, kind, sections, rendered) 按 rawSections 顺序回放；
// 命中可编辑节（基本信息/出场记录/弧线定义/阶段规划）时用编辑后单元替换。
function serializeDoc(view, sections, render) {
  const out = [];
  if (view.frontmatter) { out.push(view.frontmatter.trim()); out.push(""); }
  if (view.title) { out.push("# " + view.title); out.push(""); }
  for (const part of sections) {
    const heading = (part.heading || "").trim();
    if (part.kind === "h1") continue; // 标题已随 view.title 在开头输出
    else if (part.kind === "hr") { out.push("---"); out.push(""); }
    else if (part.kind === "pre") { out.push(part.text); out.push(""); }
    else {
      const override = render && render(heading);
      if (override === SKIP) continue;
      if (override !== null && override !== undefined) { out.push("#".repeat(part.level || 2) + " " + heading); if (override) { out.push(""); out.push(override); } out.push(""); }
      else { out.push("#".repeat(part.level || 2) + " " + heading); if (part.lines && part.lines.length) { out.push(""); out.push(part.lines.join("\n")); } out.push(""); }
    }
  }
  const text = out.join("\n").replace(/\n{3,}/g, "\n\n");
  return text.trim() + "\n";
}

// ---------- 角色卡 ----------
function parseCharacterCard(md) {
  const nodes = tokenize(md);
  const h1Node = nodes.find((n) => n.t === "h1");
  const fmNode = nodes.find((n) => n.t === "fm");
  const parts = groupSections(nodes);
  const view = { kind: "character-card", title: h1Node ? h1Node.text : null, frontmatter: fmNode ? fmNode.raw : "", basic: [], table: null, aliases: [], rawSections: parts };
  for (const part of parts) {
    const heading = (part.heading || "").trim();
    if (part.kind === "section" && heading === "基本信息" && part.level === 2 && !view.basic.length) {
      view.basic = parseFields(part.lines || []);
    } else if (part.kind === "section" && heading === "出场记录" && part.level === 2 && !view.table) {
      view.table = parseTable(part.lines || []);
    } else if (part.kind === "section" && heading === "别名" && part.level === 2 && !view.aliases.length) {
      view.aliases = (part.lines || []).filter((l) => /^\s*[-*+]\s+/.test(l)).map((l) => l.replace(/^\s*[-*+]\s+/, "").trim());
    }
  }
  return view;
}

function serializeCharacterCard(view) {
  return serializeDoc(view, view.rawSections, (heading) => {
    if (heading === "基本信息" && view.basic.length) return serializeFields(view.basic);
    if (heading === "出场记录" && view.table) return serializeTable(view.table);
    return null;
  });
}

// ---------- 角色线 ----------
function parseArc(md) {
  const nodes = tokenize(md);
  const h1Node = nodes.find((n) => n.t === "h1");
  const parts = groupSections(nodes);
  const view = { kind: "arc", title: h1Node ? h1Node.text : null, definition: [], stages: [], rawSections: parts };
  let inPlan = false;
  for (const part of parts) {
    const heading = (part.heading || "").trim();
    if (part.kind !== "section") continue;
    if (part.level === 2 && heading === "弧线定义") { if (!view.definition.length) view.definition = parseFields(part.lines || []); continue; }
    if (part.level === 2 && heading === "阶段规划") { if (!view.stages.length) inPlan = true; continue; }
    if (inPlan && part.level === 3 && /^阶段\s*\d+\s*[：:]?/.test(heading)) {
      view.stages.push({ heading: part.heading, level: part.level, items: parseFields(part.lines || []) });
      continue;
    }
    if (part.level <= 2) inPlan = false;
  }
  return view;
}

function serializeArc(view) {
  let planWritten = false;
  return serializeDoc(view, view.rawSections, (heading) => {
    if (heading === "弧线定义" && view.definition.length) return serializeFields(view.definition);
    if (heading === "阶段规划" && view.stages.length) {
      const blocks = [];
      for (const stage of view.stages) {
        blocks.push("#".repeat(stage.level || 3) + " " + stage.heading);
        blocks.push("");
        blocks.push(serializeFields(stage.items));
        blocks.push("");
      }
      planWritten = true;
      return blocks.join("\n");
    }
    if (/^阶段\s*\d+/.test(heading) && planWritten) return SKIP; // 阶段已并入「阶段规划」节，不再单独回放
    return null;
  });
}

// ---------- 角色状态 ----------
function parseStatus(md) {
  const nodes = tokenize(md);
  const h1Node = nodes.find((n) => n.t === "h1");
  const parts = groupSections(nodes);
  const preLines = parts.filter((p) => p.kind === "pre").map((p) => p.text);
  const view = { kind: "character-status", title: h1Node ? h1Node.text : null, header: parseFields(preLines), rawSections: parts };
  return view;
}

function serializeStatus(view) {
  const out = [];
  if (view.title) { out.push("# " + view.title); out.push(""); }
  if (view.header.length) { out.push(serializeFields(view.header)); out.push(""); }
  for (const part of view.rawSections) {
    if (part.kind === "pre") continue; // 头部字段已由 header 回放
    if (part.kind === "h1") continue;   // 标题已随 view.title 输出
    if (part.kind === "hr") { out.push("---"); out.push(""); continue; }
    out.push("#".repeat(part.level || 2) + " " + (part.heading || ""));
    if (part.lines && part.lines.length) { out.push(""); out.push(part.lines.join("\n")); }
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// ---------- 设定文档 ----------
function parseSettings(md) {
  const nodes = tokenize(md);
  const h1Node = nodes.find((n) => n.t === "h1");
  const parts = groupSections(nodes);
  const view = { kind: "settings-doc", title: h1Node ? h1Node.text : null, sections: parts.filter((p) => p.kind === "section").map((p) => ({ heading: p.heading, level: p.level, body: (p.lines || []).join("\n") })), rawSections: parts };
  return view;
}

function serializeSettings(view) {
  return serializeDoc(view, view.rawSections, null);
}

// ---------- 统一入口 ----------
export function parseStructured(md, kind) {
  if (kind === "character-card") return parseCharacterCard(md);
  if (kind === "arc") return parseArc(md);
  if (kind === "character-status") return parseStatus(md);
  if (kind === "settings-doc") return parseSettings(md);
  return null;
}

export function serializeStructured(view) {
  if (!view) return "";
  if (view.kind === "character-card") return serializeCharacterCard(view);
  if (view.kind === "arc") return serializeArc(view);
  if (view.kind === "character-status") return serializeStatus(view);
  if (view.kind === "settings-doc") return serializeSettings(view);
  return "";
}
