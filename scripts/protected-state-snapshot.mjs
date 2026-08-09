import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function readEntryKind(stat) {
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isBlockDevice()) return "block-device";
  if (stat.isCharacterDevice()) return "character-device";
  if (stat.isFIFO()) return "fifo";
  if (stat.isSocket()) return "socket";
  return "unknown";
}

function readStatMetadata(stat) {
  return {
    gid: stat.gid.toString(),
    kind: readEntryKind(stat),
    mode: (stat.mode & 0o7777n).toString(8).padStart(4, "0"),
    mtime_ns: stat.mtimeNs.toString(),
    size: stat.size.toString(),
    uid: stat.uid.toString(),
  };
}

function tryLstat(targetPath) {
  try {
    return fs.lstatSync(targetPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return null;
    }
    throw error;
  }
}

function createProtectedStateSnapshot(stateRoot) {
  const resolvedRoot = path.resolve(stateRoot);
  const rootStat = tryLstat(resolvedRoot);

  if (!rootStat) {
    const sha256 = crypto
      .createHash("sha256")
      .update(JSON.stringify({ exists: false }))
      .digest("hex");
    return Object.freeze({
      entry_count: 0,
      exists: false,
      file_count: 0,
      root: resolvedRoot,
      root_kind: "missing",
      sha256,
    });
  }

  const entries = [];
  let fileCount = 0;

  function visit(absolutePath, relativePath, stat) {
    const metadata = {
      path: relativePath,
      ...readStatMetadata(stat),
    };

    if (stat.isFile()) {
      metadata.content_sha256 = crypto
        .createHash("sha256")
        .update(fs.readFileSync(absolutePath))
        .digest("hex");
      fileCount += 1;
    } else if (stat.isSymbolicLink()) {
      metadata.target = fs.readlinkSync(absolutePath);
    }

    entries.push(metadata);

    if (!stat.isDirectory()) {
      return;
    }

    const childNames = fs.readdirSync(absolutePath).sort((left, right) =>
      left.localeCompare(right));
    for (const childName of childNames) {
      const childPath = path.join(absolutePath, childName);
      const childRelativePath = relativePath === "."
        ? childName
        : `${relativePath}/${childName}`;
      const childStat = tryLstat(childPath);
      if (!childStat) {
        throw new Error("protected state changed while it was being captured");
      }
      visit(childPath, childRelativePath, childStat);
    }
  }

  visit(resolvedRoot, ".", rootStat);
  const sha256 = crypto
    .createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");

  return Object.freeze({
    entry_count: entries.length,
    exists: true,
    file_count: fileCount,
    root: resolvedRoot,
    root_kind: readEntryKind(rootStat),
    sha256,
  });
}

function compareProtectedStateSnapshots(before, after) {
  return Object.freeze({
    after,
    before,
    changed:
      before.exists !== after.exists
      || before.root_kind !== after.root_kind
      || before.entry_count !== after.entry_count
      || before.file_count !== after.file_count
      || before.sha256 !== after.sha256,
  });
}

export {
  compareProtectedStateSnapshots,
  createProtectedStateSnapshot,
};
