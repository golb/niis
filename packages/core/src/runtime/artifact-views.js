







function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}




const EXTENSION_LANGUAGE = {
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".jsx": "javascript", ".ts": "typescript", ".tsx": "typescript",
  ".py": "python", ".rb": "ruby", ".go": "go", ".rs": "rust",
  ".java": "java", ".kt": "kotlin", ".swift": "swift", ".m": "objective-c",
  ".c": "c", ".h": "c", ".cpp": "c++", ".cc": "c++", ".hpp": "c++",
  ".cs": "c#", ".php": "php", ".scala": "scala", ".clj": "clojure",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell", ".fish": "shell",
  ".md": "markdown", ".mdx": "markdown", ".rst": "rst",
  ".json": "json", ".jsonc": "json", ".yml": "yaml", ".yaml": "yaml",
  ".toml": "toml", ".ini": "ini", ".xml": "xml", ".html": "html",
  ".htm": "html", ".css": "css", ".scss": "scss", ".sass": "sass",
  ".less": "less", ".sql": "sql", ".graphql": "graphql", ".gql": "graphql",
  ".vue": "vue", ".svelte": "svelte", ".dockerfile": "dockerfile",
  ".lock": "lockfile", ".env": "env",
};

function languageOf(entry) {
  if (entry.language) return entry.language;
  const p = entry.path || "";
  const slash = p.lastIndexOf("/");
  const file = slash >= 0 ? p.slice(slash + 1) : p;

  if (file === "Dockerfile" || file.startsWith("Dockerfile.")) return "dockerfile";
  if (file === "Makefile") return "makefile";
  const dot = file.lastIndexOf(".");
  if (dot < 0) return "unknown";
  const ext = file.slice(dot).toLowerCase();
  return EXTENSION_LANGUAGE[ext] || "unknown";
}

function summarizeCodemap(codemap) {
  const entries = Array.isArray(codemap?.entries) ? codemap.entries : [];
  const stats = codemap?.stats ?? {};
  const langCounts = new Map();
  const kindCounts = new Map();
  let totalBytes = 0;
  for (const entry of entries) {
    const lang = languageOf(entry);
    langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
    const kind = entry.kind || "unknown";
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
    if (Number.isFinite(entry.size_bytes)) totalBytes += entry.size_bytes;
  }
  const languages = [...langCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([language, count]) => ({ language, count }));
  const kinds = [...kindCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => ({ kind, count }));
  return { entries, stats, languages, kinds, totalBytes };
}



function buildPathTree(entries) {
  const root = { name: "", children: new Map(), fileCount: 0, dirCount: 0 };
  for (const entry of entries) {
    if (!entry.path) continue;
    const parts = entry.path.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLeaf = i === parts.length - 1;
      if (isLeaf) {
        node.children.set(part, { name: part, kind: "file", entry });
        node.fileCount += 1;
      } else {
        let child = node.children.get(part);
        if (!child || child.kind === "file") {
          child = { name: part, kind: "dir", children: new Map(), fileCount: 0, dirCount: 0 };
          node.children.set(part, child);
          node.dirCount += 1;
        }
        node = child;
      }
    }
  }

  function rollup(n) {
    if (n.kind === "file") return 1;
    let total = 0;
    for (const child of n.children.values()) total += rollup(child);
    n.totalFiles = total;
    return total;
  }
  rollup(root);
  return root;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function renderTreeNode(node, depth = 0) {
  if (node.kind === "file") {
    const e = node.entry;
    const lang = languageOf(e);
    const kind = e.kind || "—";
    const size = formatBytes(e.size_bytes);
    return `<a class="cv-row cv-file" href="#" title="Open ${escapeHtml(e.path)}" data-cv-source="${escapeHtml(e.path)}" data-lang="${escapeHtml(lang)}" data-kind="${escapeHtml(kind)}" data-path="${escapeHtml(e.path)}" style="--depth:${depth}">
      <span class="cv-icon">·</span>
      <span class="cv-name">${escapeHtml(node.name)}</span>
      <span class="cv-meta">${escapeHtml(lang)} · ${escapeHtml(kind)} · ${escapeHtml(size)}</span>
    </a>`;
  }

  const childrenHtml = [...node.children.values()]
    .sort((a, b) => {

      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((c) => renderTreeNode(c, depth + 1))
    .join("");

  const open = depth <= 1 ? " open" : "";
  return `<details class="cv-dir"${open} style="--depth:${depth}">
    <summary class="cv-row">
      <span class="cv-icon">▸</span>
      <span class="cv-name">${escapeHtml(node.name || "/")}</span>
      <span class="cv-meta">${node.totalFiles} files</span>
    </summary>
    <div class="cv-dir-children">${childrenHtml}</div>
  </details>`;
}






export function renderCodemapHtml(codemap) {
  const { entries, stats, languages, kinds, totalBytes } = summarizeCodemap(codemap);
  const tree = buildPathTree(entries);
  const treeHtml = [...tree.children.values()]
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((c) => renderTreeNode(c, 0))
    .join("");

  const langChips = languages
    .map((l) => `<button type="button" class="cv-chip" data-filter-lang="${escapeHtml(l.language)}">${escapeHtml(l.language)} <span class="cv-chip-count">${l.count}</span></button>`)
    .join("");
  const kindChips = kinds
    .map((k) => `<button type="button" class="cv-chip" data-filter-kind="${escapeHtml(k.kind)}">${escapeHtml(k.kind)} <span class="cv-chip-count">${k.count}</span></button>`)
    .join("");

  const filesIndexed = Number.isFinite(stats.files_indexed) ? stats.files_indexed : entries.length;
  const sourceCount = Number.isFinite(stats.source_count) ? stats.source_count : (kinds.find((k) => k.kind === "source")?.count ?? 0);
  const docsCount = Number.isFinite(stats.docs_count) ? stats.docs_count : (kinds.find((k) => k.kind === "documentation")?.count ?? 0);

  return `<div class="codemap-view">
  <div class="cv-stats">
    <div><span class="cv-stat-label">Files indexed</span><span class="cv-stat-value">${filesIndexed}</span></div>
    <div><span class="cv-stat-label">Source</span><span class="cv-stat-value">${sourceCount}</span></div>
    <div><span class="cv-stat-label">Docs</span><span class="cv-stat-value">${docsCount}</span></div>
    <div><span class="cv-stat-label">Total size</span><span class="cv-stat-value">${formatBytes(totalBytes)}</span></div>
  </div>
  <div class="cv-section">
    <span class="cv-section-label">Languages — click to filter</span>
    <div class="cv-chips" data-filter-group="lang">${langChips}</div>
  </div>
  <div class="cv-section">
    <span class="cv-section-label">Kinds — click to filter</span>
    <div class="cv-chips" data-filter-group="kind">${kindChips}</div>
  </div>
  <input type="text" class="cv-search" placeholder="Search path…" data-cv-search />
  <div class="cv-tree" data-cv-tree>${treeHtml}</div>
  <div class="cv-totals">Root: <code>${escapeHtml(codemap?.root || "—")}</code></div>
</div>`;
}


export function getArtifactView(fileId, viewKind, parsedContent) {
  if (fileId === "codemap") {
    if (viewKind === "html") return { contentType: "text/html; charset=utf-8", body: renderCodemapHtml(parsedContent) };
  }
  return null;
}





export function listArtifactViews(fileId, { hasGeneratedHtml = false, canGenerateHtml = false } = {}) {
  if (hasGeneratedHtml || canGenerateHtml || fileId === "codemap") return ["html"];
  return [];
}
