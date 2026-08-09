













import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";




export const ILLUSTRATOR_ARTIFACTS = {
  "project-profile":        { rel: "exports/project-profile.md",        kind: "md"   },
  "workflow":               { rel: "exports/workflow.md",               kind: "md"   },
  "codemap":                { rel: "exports/codemap.json",              kind: "json" },
  "attached-repository":    { rel: "exports/attached-repository.json",  kind: "json" },
  "task-sources":           { rel: "exports/task-sources.json",         kind: "json" },
  "reference-bundle-seeds": { rel: "exports/reference-bundle-seeds.json", kind: "json" },
  "bootstrap-pack":         { rel: "exports/bootstrap-pack.json",       kind: "json" },
  "scaffold-plan":          { rel: "exports/scaffold-plan.json",        kind: "json" },
  "install-state":          { rel: "install-state.json",                kind: "json" },
};

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function resolveArtifactPaths(workspaceRoot, artifactId) {
  const entry = ILLUSTRATOR_ARTIFACTS[artifactId];
  if (!entry) throw new Error(`unknown artifact id: ${artifactId}`);
  const sourcePath = path.join(workspaceRoot, ".niis", entry.rel);
  const htmlDir = path.join(workspaceRoot, ".niis", "exports", "html");
  const outputPath = path.join(htmlDir, `${artifactId}.html`);
  const sidecarPath = path.join(htmlDir, `${artifactId}.html.meta.json`);
  return { entry, sourcePath, htmlDir, outputPath, sidecarPath };
}

function readSidecar(sidecarPath) {
  if (!fs.existsSync(sidecarPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
  } catch {
    return null;
  }
}





function loadManifestBody(manifestPath, { extraFiles = [] } = {}) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`role-manifest not found: ${manifestPath}`);
  }
  const raw = fs.readFileSync(manifestPath, "utf8");
  let body;
  if (!raw.startsWith("---")) body = raw.trim();
  else {
    const endIdx = raw.indexOf("\n---", 3);
    body = endIdx < 0 ? raw.trim() : raw.slice(endIdx + 4).trim();
  }
  for (const extra of extraFiles) {
    if (!fs.existsSync(extra)) continue;
    body += "\n\n" + fs.readFileSync(extra, "utf8").trim();
  }
  return body;
}




function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:html)?\s*\n([\s\S]*?)\n```\s*$/);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function isHtmlDocument(text) {
  const head = String(text || "").trimStart().slice(0, 50).toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html");
}



function buildIllustratorPrompt({ manifestBody, artifactId, kind, sourcePath, sourceBytes }) {
  return [
    manifestBody,
    "",
    "---",
    "",
    `Artifact id: ${artifactId}`,
    `Artifact kind: ${kind}`,
    `Artifact source path: ${sourcePath}`,
    "",
    "Artifact content follows. Produce the HTML document now.",
    "",
    sourceBytes.toString("utf8"),
  ].join("\n");
}










export function createLlmRenderer({ commandPath, runtimeId, exec, manifestBody, workspaceRoot }) {
  if (typeof exec !== "function") throw new Error("createLlmRenderer: exec must be a function");
  if (!commandPath) throw new Error("createLlmRenderer: commandPath required");
  if (!manifestBody) throw new Error("createLlmRenderer: manifestBody required");
  return async function llmRenderer({ artifactId, sourcePath, sourceBytes }) {
    const kind = sourcePath.endsWith(".json") ? "json" : "md";
    const prompt = buildIllustratorPrompt({
      manifestBody, artifactId, kind, sourcePath, sourceBytes,
    });
    const result = await exec({ commandPath, prompt, workspaceRoot });
    const raw = result?.summary ?? "";
    const html = stripCodeFence(raw);
    if (!isHtmlDocument(html)) {



      const exitCode = result?.raw?.exit_code;
      const stderr = (result?.raw?.stderr || "").trim();
      const stderrTail = stderr.length > 400 ? `…${stderr.slice(-400)}` : stderr;
      const stdoutTail = (result?.raw?.stdout || "").trim().slice(-200);
      throw new Error(
        `${runtimeId} did not return a valid HTML document ` +
        `(exit=${exitCode}, summary=${html.length} chars head: ${html.slice(0, 80).replace(/\s+/g, " ")})` +
        (stderrTail ? `\n  stderr: ${stderrTail}` : "") +
        (stdoutTail ? `\n  stdout tail: ${stdoutTail.replace(/\s+/g, " ")}` : ""),
      );
    }
    return html;
  };
}




function renderLocalPreviewHtml({ artifactId, sourcePath, sourceBytes }) {
  const sizeKb = (sourceBytes.length / 1024).toFixed(1);
  const preview = sourceBytes.toString("utf8").slice(0, 400)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${artifactId}</title>
<style>
  html, body { margin: 0; padding: 0; background: #f7f5f0; color: #1a1a1a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  body { padding: 2rem 2.5rem; line-height: 1.55; }
  .badge { display: inline-block; padding: 0.2rem 0.6rem; border-radius: 999px; background: #ffe5b4; color: #6b3a00; font-size: 0.7rem; letter-spacing: 0.06em; text-transform: uppercase; }
  h1 { margin: 0.75rem 0 0.25rem; font-weight: 700; }
  .meta { font-family: ui-monospace, Menlo, monospace; font-size: 0.75rem; color: rgba(0,0,0,0.55); word-break: break-all; }
  pre { background: rgba(255,255,255,0.6); border: 1px solid rgba(0,0,0,0.08); border-radius: 6px; padding: 1rem; overflow: auto; font-size: 0.75rem; }
  p { max-width: 65ch; }
</style></head>
<body>
  <span class="badge">Local preview</span>
  <h1>${artifactId}</h1>
  <p class="meta">${sourcePath} · ${sizeKb} KB</p>
  <p>Raw preview (first 400 bytes):</p>
  <pre>${preview}</pre>
</body>
</html>`;
}




export async function renderArtifact({ workspaceRoot, artifactId, force = false, renderer = renderLocalPreviewHtml, generator = "stub-v1", model = null }) {
  const { sourcePath, htmlDir, outputPath, sidecarPath } = resolveArtifactPaths(workspaceRoot, artifactId);
  if (!fs.existsSync(sourcePath)) {
    return { artifactId, status: "missing", reason: `source not found: ${sourcePath}` };
  }
  const sourceBytes = fs.readFileSync(sourcePath);
  const sourceHash = sha256Hex(sourceBytes);
  const prev = readSidecar(sidecarPath);
  if (!force && prev && prev.source_sha256 === sourceHash && prev.generator === generator && fs.existsSync(outputPath)) {
    return { artifactId, status: "skipped", reason: "unchanged", sourceHash, outputPath };
  }
  let html;
  const startedAt = Date.now();
  try {
    html = await renderer({ artifactId, sourcePath, sourceBytes });
  } catch (err) {
    return { artifactId, status: "failed", reason: err.message || String(err) };
  }
  const elapsedMs = Date.now() - startedAt;
  fs.mkdirSync(htmlDir, { recursive: true });
  fs.writeFileSync(outputPath, html);
  fs.writeFileSync(sidecarPath, `${JSON.stringify({
    artifact_id: artifactId,
    source_path: sourcePath,
    source_sha256: sourceHash,
    output_path: outputPath,
    generated_at: new Date().toISOString(),
    generated_in_ms: elapsedMs,
    generator,
    model,
    tokens_used: null,
  }, null, 2)}\n`);
  return { artifactId, status: "rendered", sourceHash, outputPath, sidecarPath, elapsedMs };
}




export async function renderAllArtifacts({ workspaceRoot, force = false, artifactIds = null, renderer = renderLocalPreviewHtml, generator = "stub-v1", model = null, onProgress = null }) {
  const ids = artifactIds && artifactIds.length > 0
    ? artifactIds
    : Object.keys(ILLUSTRATOR_ARTIFACTS);
  const results = [];
  for (const id of ids) {
    if (!ILLUSTRATOR_ARTIFACTS[id]) {
      results.push({ artifactId: id, status: "failed", reason: "unknown artifact id" });
      continue;
    }
    if (onProgress) onProgress({ artifactId: id, phase: "start" });
    const r = await renderArtifact({ workspaceRoot, artifactId: id, force, renderer, generator, model });
    results.push(r);
    if (onProgress) onProgress({ artifactId: id, phase: "end", result: r });
  }
  return results;
}


export { loadManifestBody };




export function readArtifactHtml(workspaceRoot, artifactId) {
  if (!ILLUSTRATOR_ARTIFACTS[artifactId]) return null;
  const { outputPath, sidecarPath } = resolveArtifactPaths(workspaceRoot, artifactId);
  if (!fs.existsSync(outputPath)) return null;
  const body = fs.readFileSync(outputPath, "utf8");
  const meta = readSidecar(sidecarPath);
  return { body, meta, outputPath };
}
