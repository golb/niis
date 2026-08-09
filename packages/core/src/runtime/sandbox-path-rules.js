import fs from "node:fs";
import path from "node:path";















function isPathWithin(rootPath, candidatePath, { allowRoot = true } = {}) {
  const relative = path.relative(rootPath, candidatePath);
  return (allowRoot && relative === "")
    || (
      relative !== ""
      && relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    );
}

function escapeSandboxLiteral(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function pathDepth(value) {
  return value.split(path.sep).filter((segment) => segment !== "").length;
}



function listNestedAncestorPaths(parentPath, childPath) {
  if (!isPathWithin(parentPath, childPath, { allowRoot: false })) return [];
  const paths = [];
  let current = parentPath;
  for (const segment of path.relative(parentPath, childPath).split(path.sep)) {
    current = path.join(current, segment);
    paths.push(current);
  }
  return paths;
}





function orderPathScopedRules(entries) {
  return entries
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) =>
      pathDepth(a.path) - pathDepth(b.path)
      || a.rank - b.rank
      || a.index - b.index)
    .flatMap((entry) => entry.lines);
}







function createSeatbeltTraversalEntries(deniedReadRoots, targetPaths) {
  const literals = new Set();
  for (const root of deniedReadRoots) {
    for (const target of targetPaths) {
      if (!isPathWithin(root, target, { allowRoot: false })) continue;
      literals.add(root);
      for (const ancestor of listNestedAncestorPaths(root, target)) {
        if (ancestor !== target) literals.add(ancestor);
      }
    }
  }
  return [...literals].sort().map((entry) => ({
    lines: [`(allow file-read-metadata (literal "${escapeSandboxLiteral(entry)}"))`],
    path: entry,
    rank: 1,
  }));
}

function createBubblewrapMaskEntries(deniedReadRoots, targetPaths) {
  const entries = [];
  const seen = new Set();
  for (const root of deniedReadRoots) {
    if (!fs.existsSync(root)) continue;
    entries.push({
      lines: fs.statSync(root).isDirectory()
        ? ["--tmpfs", root]
        : ["--ro-bind", "/dev/null", root],
      path: root,
      rank: 0,
    });
    for (const target of targetPaths) {
      for (const mountpoint of listNestedAncestorPaths(root, target)) {
        if (seen.has(mountpoint)) continue;
        seen.add(mountpoint);
        entries.push({ lines: ["--dir", mountpoint], path: mountpoint, rank: 1 });
      }
    }
  }
  return entries;
}

export {
  createBubblewrapMaskEntries,
  createSeatbeltTraversalEntries,
  escapeSandboxLiteral,
  isPathWithin,
  listNestedAncestorPaths,
  orderPathScopedRules,
  pathDepth,
};
