#!/usr/bin/env node
// Renders FEATURE_BOARD.md into a standalone styled HTML file.
//
// Output: artifacts/feature-board.html (gitignored).
// Re-run any time the markdown changes.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const inputPath = resolve(repoRoot, "FEATURE_BOARD.md");
// Output at the repo root so it sits next to FEATURE_BOARD.md. Add
// FEATURE_BOARD.html to .gitignore since it is regenerable from the markdown.
const outputPath = resolve(repoRoot, "FEATURE_BOARD.html");

// ── Markdown → inline HTML ───────────────────────────────────────────────────

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInline(text) {
  // Preserve code spans first (so their contents don't get processed)
  const codeSlots = [];
  let working = text.replace(/`([^`]+)`/g, (_, code) => {
    codeSlots.push(code);
    return `\u0000CODE${codeSlots.length - 1}\u0000`;
  });

  working = escapeHtml(working);

  // Links [text](url)
  working = working.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, label, href) => {
      const safeHref = href.startsWith("http")
        ? href
        : href.startsWith("/")
          ? `https://github.com/derekrivers/RedDwarf/blob/master${href}`
          : `https://github.com/derekrivers/RedDwarf/blob/master/${href}`;
      return `<a href="${safeHref}" target="_blank" rel="noopener">${label}</a>`;
    }
  );

  // Bold
  working = working.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  // Italics (single * not inside bold)
  working = working.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");

  // Restore code spans
  working = working.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => {
    return `<code>${escapeHtml(codeSlots[Number(i)])}</code>`;
  });

  return working;
}

// ── Table parsing ───────────────────────────────────────────────────────────

function splitTableRow(line) {
  // Honour `\|` as a literal pipe (markdown table escape). Swap to a
  // sentinel before splitting, then swap back.
  const ESCAPED = "\u0001ESCPIPE\u0001";
  const trimmed = line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .replace(/\\\|/g, ESCAPED);
  return trimmed
    .split("|")
    .map((cell) => cell.trim().replaceAll(ESCAPED, "|"));
}

function isTableHeader(line) {
  return /^\s*\|/.test(line) && /\|\s*$/.test(line);
}

function isTableSeparator(line) {
  return /^\s*\|[\s|:-]+\|\s*$/.test(line);
}

// ── Parse markdown into a structured tree ───────────────────────────────────

function parse(markdown) {
  const lines = markdown.split("\n");
  const root = { type: "doc", children: [] };
  let currentMilestone = null;
  let currentPhase = null;
  let currentList = null;
  let i = 0;

  function pushToCurrent(node) {
    if (currentPhase) {
      currentPhase.children.push(node);
    } else if (currentMilestone) {
      currentMilestone.children.push(node);
    } else {
      root.children.push(node);
    }
    if (node.type !== "list") {
      currentList = null;
    }
  }

  while (i < lines.length) {
    const line = lines[i];

    // H1
    if (/^# [^#]/.test(line)) {
      root.title = line.replace(/^#\s+/, "").trim();
      i++;
      continue;
    }

    // H2 milestone
    if (/^## [^#]/.test(line)) {
      currentMilestone = {
        type: "milestone",
        title: line.replace(/^##\s+/, "").trim(),
        id: slugify(line.replace(/^##\s+/, "").trim()),
        children: []
      };
      currentPhase = null;
      root.children.push(currentMilestone);
      currentList = null;
      i++;
      continue;
    }

    // H3 phase/subsection
    if (/^### [^#]/.test(line)) {
      const title = line.replace(/^###\s+/, "").trim();
      const isFeaturePhase = /^Phase \d/i.test(title);
      currentPhase = {
        type: "section",
        title,
        id: slugify(title),
        isFeaturePhase,
        children: []
      };
      (currentMilestone
        ? currentMilestone.children
        : root.children
      ).push(currentPhase);
      currentList = null;
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*---\s*$/.test(line)) {
      currentList = null;
      i++;
      continue;
    }

    // Table
    if (isTableHeader(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = splitTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableHeader(lines[i]) && !isTableSeparator(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      pushToCurrent({ type: "table", headers, rows });
      continue;
    }

    // Bullet list
    if (/^\s*-\s+/.test(line)) {
      const item = line.replace(/^\s*-\s+/, "").trim();
      if (!currentList) {
        currentList = { type: "list", items: [] };
        pushToCurrent(currentList);
      }
      currentList.items.push(item);
      i++;
      continue;
    }

    // Code block (```…```)
    if (/^\s*```/.test(line)) {
      const codeLines = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      pushToCurrent({ type: "code", content: codeLines.join("\n") });
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      currentList = null;
      i++;
      continue;
    }

    // Paragraph
    const paragraphLines = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^#{1,3}\s/.test(lines[i]) &&
      !/^\s*-\s+/.test(lines[i]) &&
      !isTableHeader(lines[i]) &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s*---\s*$/.test(lines[i])
    ) {
      paragraphLines.push(lines[i]);
      i++;
    }
    pushToCurrent({ type: "paragraph", content: paragraphLines.join(" ") });
    currentList = null;
  }

  return root;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ── Feature-table handling (the key shape on this board) ────────────────────

function statusBadge(status) {
  const s = status.toLowerCase();
  const palette = {
    pending: "pending",
    complete: "complete",
    completed: "complete",
    "in progress": "in-progress",
    "in-progress": "in-progress",
    blocked: "blocked"
  };
  const cls = palette[s] ?? "pending";
  return `<span class="badge badge-${cls}">${escapeHtml(status)}</span>`;
}

function renderFeatureTable(headers, rows) {
  const headerIdx = {
    num: headers.findIndex((h) => h.trim() === "#"),
    feature: headers.findIndex((h) => /feature/i.test(h)),
    status: headers.findIndex((h) => /status/i.test(h)),
    deps: headers.findIndex((h) => /depends/i.test(h)),
    notes: headers.findIndex((h) => /note|spec ref|audit ref|reference/i.test(h))
  };

  // If it doesn't look like a feature table, fall back to a generic table
  if (headerIdx.feature < 0 || headerIdx.status < 0) {
    return renderGenericTable(headers, rows);
  }

  const cards = rows
    .map((cells) => {
      const num = cells[headerIdx.num] ?? "";
      const featureCell = cells[headerIdx.feature] ?? "";
      const status = cells[headerIdx.status] ?? "pending";
      const deps = headerIdx.deps >= 0 ? cells[headerIdx.deps] ?? "—" : "—";
      const notes = headerIdx.notes >= 0 ? cells[headerIdx.notes] ?? "" : "";

      // Split feature cell into bold title (leading **...**) and rest
      const boldMatch = /^\*\*([^*]+)\*\*\s*(?:—|--)?\s*/.exec(featureCell);
      const title = boldMatch ? boldMatch[1] : featureCell;
      const body = boldMatch ? featureCell.slice(boldMatch[0].length) : "";

      return `
<article class="feature card feature-${status.toLowerCase().replace(/\s+/g, "-")}">
  <header class="feature-head">
    <span class="feature-num">#${escapeHtml(num)}</span>
    <h4 class="feature-title">${renderInline(title)}</h4>
    ${statusBadge(status)}
  </header>
  ${body ? `<p class="feature-body">${renderInline(body)}</p>` : ""}
  <dl class="feature-meta">
    <div><dt>Depends on</dt><dd>${renderInline(deps || "—")}</dd></div>
    ${notes ? `<div><dt>Notes</dt><dd>${renderInline(notes)}</dd></div>` : ""}
  </dl>
</article>`;
    })
    .join("\n");

  return `<div class="feature-grid">\n${cards}\n</div>`;
}

function renderGenericTable(headers, rows) {
  const head = headers.map((h) => `<th>${renderInline(h)}</th>`).join("");
  const body = rows
    .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`)
    .join("\n");
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// ── Stats ───────────────────────────────────────────────────────────────────

function collectStats(doc) {
  const counts = { total: 0, pending: 0, complete: 0, other: 0 };
  for (const milestone of doc.children) {
    if (milestone.type !== "milestone") continue;
    walk(milestone);
  }
  function walk(node) {
    if (node.type === "table" && /status/i.test(node.headers.join(" "))) {
      const statusIdx = node.headers.findIndex((h) => /status/i.test(h));
      if (statusIdx < 0) return;
      for (const row of node.rows) {
        const s = (row[statusIdx] ?? "").toLowerCase();
        counts.total++;
        if (s === "complete" || s === "completed") counts.complete++;
        else if (s === "pending") counts.pending++;
        else counts.other++;
      }
    }
    if (node.children) node.children.forEach(walk);
  }
  return counts;
}

// ── Rendering ───────────────────────────────────────────────────────────────

function renderNode(node) {
  if (node.type === "paragraph") return `<p>${renderInline(node.content)}</p>`;
  if (node.type === "list") {
    const items = node.items.map((i) => `<li>${renderInline(i)}</li>`).join("");
    return `<ul>${items}</ul>`;
  }
  if (node.type === "code") {
    return `<pre><code>${escapeHtml(node.content)}</code></pre>`;
  }
  if (node.type === "table") {
    return renderFeatureTable(node.headers, node.rows);
  }
  if (node.type === "section") {
    const body = node.children.map(renderNode).join("\n");
    return `<section id="${node.id}" class="phase ${node.isFeaturePhase ? "phase-features" : ""}">
  <h3>${renderInline(node.title)}</h3>
  ${body}
</section>`;
  }
  if (node.type === "milestone") {
    const body = node.children.map(renderNode).join("\n");
    return `<section id="${node.id}" class="milestone">
  <h2>${renderInline(node.title)}</h2>
  ${body}
</section>`;
  }
  return "";
}

function renderNav(doc) {
  const items = doc.children
    .filter((n) => n.type === "milestone")
    .map((m) => {
      const phases = m.children
        .filter((c) => c.type === "section")
        .map((p) => `<li><a href="#${p.id}">${renderInline(p.title)}</a></li>`)
        .join("");
      return `<li>
  <a href="#${m.id}" class="nav-milestone">${renderInline(m.title)}</a>
  ${phases ? `<ul class="nav-phases">${phases}</ul>` : ""}
</li>`;
    })
    .join("");
  return `<nav class="sidebar" aria-label="Board navigation">
  <strong class="sidebar-title">Milestones</strong>
  <ul>${items}</ul>
</nav>`;
}

function renderDocument(doc, stats, lastUpdated) {
  const title = doc.title ?? "RedDwarf Feature Board";
  const intro = doc.children
    .filter((n) => n.type === "paragraph")
    .map((n) => renderNode(n))
    .join("\n");
  const milestones = doc.children
    .filter((n) => n.type === "milestone")
    .map(renderNode)
    .join("\n");
  const nav = renderNav(doc);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root {
  --bg: #0f1115;
  --bg-soft: #161a21;
  --bg-card: #1c2029;
  --bg-hover: #242935;
  --border: #2a3140;
  --fg: #e6e8ec;
  --fg-dim: #a8adb8;
  --fg-muted: #6d7380;
  --accent: #d7263d;
  --accent-soft: #ff5a6e;
  --status-pending: #f2a93b;
  --status-complete: #4ade80;
  --status-blocked: #ef4444;
  --status-inprogress: #60a5fa;
  --radius: 10px;
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif;
  font-size: 15px;
  line-height: 1.55;
}
a { color: var(--accent-soft); text-decoration: none; }
a:hover { text-decoration: underline; }
code {
  font-family: "JetBrains Mono", "SF Mono", Consolas, monospace;
  font-size: 0.88em;
  background: rgba(215, 38, 61, 0.12);
  color: var(--accent-soft);
  padding: 0.12em 0.35em;
  border-radius: 4px;
}
pre {
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
  overflow-x: auto;
}
pre code { background: none; color: var(--fg); padding: 0; }
.page {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: 40px;
  max-width: 1400px;
  margin: 0 auto;
  padding: 40px 32px 80px;
}
.sidebar {
  position: sticky;
  top: 24px;
  align-self: start;
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  padding-right: 8px;
  font-size: 13.5px;
}
.sidebar-title {
  display: block;
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--fg-muted);
  margin-bottom: 12px;
}
.sidebar ul { list-style: none; padding-left: 0; margin: 0; }
.sidebar li { margin: 4px 0; }
.sidebar a { color: var(--fg-dim); display: block; padding: 4px 8px; border-radius: 6px; }
.sidebar a:hover { background: var(--bg-soft); color: var(--fg); text-decoration: none; }
.sidebar .nav-milestone { color: var(--fg); font-weight: 600; }
.nav-phases { padding-left: 12px; margin-top: 2px; border-left: 1px solid var(--border); }
.nav-phases a { font-size: 13px; }
main { min-width: 0; }
.header {
  padding-bottom: 24px;
  margin-bottom: 32px;
  border-bottom: 1px solid var(--border);
}
.header h1 {
  margin: 0 0 6px;
  font-size: 28px;
  letter-spacing: -0.01em;
}
.header .subtitle { color: var(--fg-dim); margin: 0 0 18px; font-size: 14px; }
.stats { display: flex; gap: 12px; flex-wrap: wrap; }
.stat {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 16px;
  min-width: 100px;
}
.stat-value { font-size: 20px; font-weight: 600; }
.stat-label { font-size: 11px; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.1em; margin-top: 2px; }
.stat-pending .stat-value { color: var(--status-pending); }
.stat-complete .stat-value { color: var(--status-complete); }
.milestone {
  margin-top: 48px;
  padding-top: 20px;
  border-top: 2px solid var(--border);
}
.milestone:first-of-type { border-top: none; margin-top: 0; padding-top: 0; }
.milestone > h2 {
  font-size: 22px;
  margin: 0 0 16px;
  color: var(--fg);
}
.phase {
  margin-top: 32px;
}
.phase h3 {
  font-size: 15px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--fg-dim);
  margin: 0 0 16px;
  font-weight: 600;
}
.phase-features h3::before {
  content: "";
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  margin-right: 10px;
  vertical-align: middle;
}
.feature-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 14px;
}
.feature.card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 18px 20px;
  transition: border-color 0.15s, background 0.15s;
}
.feature.card:hover { border-color: var(--accent); background: var(--bg-hover); }
.feature.feature-complete { opacity: 0.78; }
.feature-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.feature-num {
  font-family: "JetBrains Mono", "SF Mono", Consolas, monospace;
  font-size: 12px;
  color: var(--fg-muted);
  background: var(--bg-soft);
  padding: 3px 8px;
  border-radius: 6px;
}
.feature-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--fg);
  flex: 1;
  min-width: 0;
}
.badge {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid currentColor;
}
.badge-pending { color: var(--status-pending); }
.badge-complete { color: var(--status-complete); }
.badge-blocked { color: var(--status-blocked); }
.badge-in-progress { color: var(--status-inprogress); }
.feature-body {
  margin: 0 0 14px;
  color: var(--fg-dim);
  font-size: 14px;
}
.feature-meta {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 8px 20px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  font-size: 13px;
}
.feature-meta > div { display: flex; gap: 8px; min-width: 0; }
.feature-meta dt {
  color: var(--fg-muted);
  text-transform: uppercase;
  font-size: 10.5px;
  letter-spacing: 0.1em;
  font-weight: 600;
  margin: 3px 0 0;
  white-space: nowrap;
}
.feature-meta dd { margin: 0; color: var(--fg-dim); min-width: 0; }
.table-wrap { overflow-x: auto; margin: 14px 0; }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
th, td {
  text-align: left;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
th { color: var(--fg-muted); text-transform: uppercase; font-size: 11px; letter-spacing: 0.1em; }
ul, ol { padding-left: 22px; }
li { margin: 4px 0; color: var(--fg-dim); }
p { margin: 10px 0; }
main > p:first-child, main > ul:first-of-type { color: var(--fg-dim); }
@media (max-width: 960px) {
  .page { grid-template-columns: 1fr; }
  .sidebar { position: static; max-height: none; }
}
</style>
</head>
<body>
<div class="page">
  ${nav}
  <main>
    <header class="header">
      <h1>${escapeHtml(title)}</h1>
      <p class="subtitle">Rendered from FEATURE_BOARD.md · last updated ${escapeHtml(lastUpdated)}</p>
      <div class="stats">
        <div class="stat stat-total"><div class="stat-value">${stats.total}</div><div class="stat-label">Active features</div></div>
        <div class="stat stat-pending"><div class="stat-value">${stats.pending}</div><div class="stat-label">Pending</div></div>
        <div class="stat stat-complete"><div class="stat-value">${stats.complete}</div><div class="stat-label">Complete (not yet archived)</div></div>
        ${stats.other > 0 ? `<div class="stat stat-other"><div class="stat-value">${stats.other}</div><div class="stat-label">Other</div></div>` : ""}
      </div>
    </header>
    ${intro}
    ${milestones}
  </main>
</div>
</body>
</html>`;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const markdown = await readFile(inputPath, "utf8");
  const doc = parse(markdown);
  const stats = collectStats(doc);
  const lastUpdated = new Date().toISOString().slice(0, 10);
  const html = renderDocument(doc, stats, lastUpdated);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, "utf8");
  console.log(`Wrote ${outputPath}`);
  console.log(`  Features: ${stats.total} (${stats.pending} pending, ${stats.complete} complete, ${stats.other} other)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
