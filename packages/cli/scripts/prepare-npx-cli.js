import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function copyDirectory(sourcePath, targetPath) {
  const stats = fs.statSync(sourcePath);

  if (!stats.isDirectory()) {
    throw new Error(`expected directory: ${sourcePath}`);
  }

  ensureDirectory(targetPath);

  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    const sourceEntryPath = path.join(sourcePath, entry.name);
    const targetEntryPath = path.join(targetPath, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(sourceEntryPath, targetEntryPath);
      continue;
    }

    if (entry.isFile()) {
      fs.copyFileSync(sourceEntryPath, targetEntryPath);
    }
  }
}

function writeJson(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function buildNpxPackageManifest({
  rootManifest,
  cliManifest,
  coreManifest,
  bundledDependencyVersions,
}) {
  return {
    name: "@niis/cli",
    version: cliManifest.version,
    description: "Self-contained Niis CLI bundle for reproducible npx bootstrap.",
    private: true,
    license: "UNLICENSED",
    type: "module",
    main: "packages/cli/src/main.js",
    bin: {
      niis: "packages/cli/bin/niis.js",
    },
    engines: rootManifest.engines ?? { node: ">=20" },
    bundleDependencies: Object.keys(bundledDependencyVersions),
    bundledDependencies: Object.keys(bundledDependencyVersions),
    dependencies: bundledDependencyVersions,
    files: [
      "LICENSE",
      "README.md",
      "THIRD_PARTY_NOTICES.md",
      "config",
      "package.json",
      "packages",
      "node_modules",
    ],
    niis_bundle: {
      bundled_packages: [
        "packages/cli",
        "packages/core",
        "packages/adapters",
        "packages/validators",
        "packages/ui",
      ],
      core_version: coreManifest.version,
    },
  };
}

function prepareNpxCliBundle({ outputRoot = null } = {}) {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const sourceRoot = path.resolve(scriptDirectory, "..", "..", "..");
  const resolvedOutputRoot = outputRoot
    ? path.resolve(outputRoot)
    : path.join(sourceRoot, ".dist", "npx-cli");
  const rootManifest = readJson(path.join(sourceRoot, "package.json"));
  const cliManifest = readJson(path.join(sourceRoot, "packages", "cli", "package.json"));
  const coreManifest = readJson(path.join(sourceRoot, "packages", "core", "package.json"));
  const bundledDependencyVersions = {
    "better-sqlite3": coreManifest.dependencies["better-sqlite3"],
    bindings: readJson(path.join(sourceRoot, "node_modules", "bindings", "package.json")).version,
    "file-uri-to-path": readJson(
      path.join(sourceRoot, "node_modules", "file-uri-to-path", "package.json"),
    ).version,
    "prism-themes": cliManifest.dependencies["prism-themes"],
    prismjs: cliManifest.dependencies.prismjs,
  };

  fs.rmSync(resolvedOutputRoot, { force: true, recursive: true });
  ensureDirectory(resolvedOutputRoot);

  for (const relativeDirectory of [
    "packages/cli",
    "packages/core",
    "packages/adapters",
    "packages/validators",
    "packages/ui",
  ]) {
    copyDirectory(
      path.join(sourceRoot, relativeDirectory),
      path.join(resolvedOutputRoot, relativeDirectory),
    );
  }

  for (const relativeDirectory of ["config/role-manifests"]) {
    copyDirectory(
      path.join(sourceRoot, relativeDirectory),
      path.join(resolvedOutputRoot, relativeDirectory),
    );
  }
  fs.copyFileSync(
    path.join(sourceRoot, "config", "pricing.json"),
    path.join(resolvedOutputRoot, "config", "pricing.json"),
  );
  for (const fileName of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    const overlayPath = path.join(sourceRoot, "oss", "root", fileName);
    fs.copyFileSync(
      fs.existsSync(overlayPath) ? overlayPath : path.join(sourceRoot, fileName),
      path.join(resolvedOutputRoot, fileName),
    );
  }

  for (const dependencyName of Object.keys(bundledDependencyVersions)) {
    if (["prismjs", "prism-themes"].includes(dependencyName)) continue;
    copyDirectory(
      path.join(sourceRoot, "node_modules", dependencyName),
      path.join(resolvedOutputRoot, "node_modules", dependencyName),
    );
  }
  for (const fileName of ["LICENSE", "package.json", "prism.js"]) {
    const sourcePath = path.join(sourceRoot, "node_modules", "prismjs", fileName);
    const targetPath = path.join(resolvedOutputRoot, "node_modules", "prismjs", fileName);
    ensureDirectory(path.dirname(targetPath));
    fs.copyFileSync(sourcePath, targetPath);
  }
  for (const fileName of ["LICENSE", "package.json"]) {
    const sourcePath = path.join(sourceRoot, "node_modules", "prism-themes", fileName);
    const targetPath = path.join(resolvedOutputRoot, "node_modules", "prism-themes", fileName);
    ensureDirectory(path.dirname(targetPath));
    fs.copyFileSync(sourcePath, targetPath);
  }
  copyDirectory(
    path.join(sourceRoot, "node_modules", "prism-themes", "themes"),
    path.join(resolvedOutputRoot, "node_modules", "prism-themes", "themes"),
  );

  writeJson(
    path.join(resolvedOutputRoot, "package.json"),
    buildNpxPackageManifest({
      bundledDependencyVersions,
      cliManifest,
      coreManifest,
      rootManifest,
    }),
  );

  fs.writeFileSync(
    path.join(resolvedOutputRoot, "README.md"),
    [
      "# @niis/cli",
      "",
      "Self-contained CLI bundle used for reproducible local npx bootstrap proofs.",
      "",
    ].join("\n"),
  );

  return resolvedOutputRoot;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputRoot = prepareNpxCliBundle({
    outputRoot: process.env.NIIS_NPX_BUNDLE_OUT ?? null,
  });
  console.log(outputRoot);
}

export {
  prepareNpxCliBundle,
};
