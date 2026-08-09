import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { prepareNpxCliBundle } from "./prepare-npx-cli.js";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function packNpxCliBundle({ outputRoot = null, tarballPath = null } = {}) {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const sourceRoot = path.resolve(scriptDirectory, "..", "..", "..");
  const cliManifest = readJson(path.join(sourceRoot, "packages", "cli", "package.json"));
  const resolvedOutputRoot = outputRoot
    ? path.resolve(outputRoot)
    : path.join(sourceRoot, ".dist", "npx-cli");
  const packageDirectory = path.join(resolvedOutputRoot, "package");
  const resolvedTarballPath = tarballPath
    ? path.resolve(tarballPath)
    : path.join(resolvedOutputRoot, `niis-cli-${cliManifest.version}.tgz`);

  fs.rmSync(resolvedOutputRoot, { force: true, recursive: true });
  fs.mkdirSync(resolvedOutputRoot, { recursive: true });
  prepareNpxCliBundle({
    outputRoot: packageDirectory,
  });

  const tarResult = spawnSync(
    "tar",
    ["-czf", resolvedTarballPath, "-C", resolvedOutputRoot, "package"],
    {
      stdio: "inherit",
    },
  );

  if (tarResult.status !== 0) {
    throw new Error(`failed to create npx tarball via tar (exit ${tarResult.status ?? "unknown"})`);
  }

  return {
    bundle_root: packageDirectory,
    tarball_path: resolvedTarballPath,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packed = packNpxCliBundle({
    outputRoot: process.env.NIIS_NPX_PACK_OUT ?? null,
    tarballPath: process.env.NIIS_NPX_TARBALL_OUT ?? null,
  });
  console.log(packed.tarball_path);
}

export {
  packNpxCliBundle,
};
