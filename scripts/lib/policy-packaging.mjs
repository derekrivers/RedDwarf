import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const runtimeAssetPaths = ["agents", "prompts", "schemas", "standards"];
const runtimePackageNames = ["contracts", "policy", "control-plane", "execution-plane", "evidence", "integrations"];
const runtimeDependencyNames = ["drizzle-orm", "pg", "pino", "zod"];

function toBuildStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1z").toLowerCase();
}

function sortEntries(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export async function validatePolicyPackRoot(root = process.cwd()) {
  const policyRoot = resolve(root);
  const liveWorkspaceEntries = [
    ...runtimeAssetPaths,
    ...runtimePackageNames.map((name) => `packages/${name}`)
  ];
  const packagedEntries = [
    ...runtimeAssetPaths,
    ...runtimePackageNames.map((name) => `packages/${name}/dist`),
    ...runtimePackageNames.map((name) => `packages/${name}/package.json`),
    ...runtimeDependencyNames.map((name) => `node_modules/${name}`),
    ...runtimePackageNames.map((name) => `node_modules/@reddwarf/${name}/package.json`),
    "policy-pack.manifest.json"
  ];

  try {
    await access(resolve(policyRoot, "policy-pack.manifest.json"));
    await Promise.all(packagedEntries.map((entry) => access(resolve(policyRoot, entry))));
  } catch {
    await Promise.all(liveWorkspaceEntries.map((entry) => access(resolve(policyRoot, entry))));
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function copyDirectory(source, destination) {
  await ensureDir(resolve(destination, ".."));
  await cp(source, destination, {
    recursive: true,
    force: true,
    dereference: true,
    verbatimSymlinks: false
  });
}

async function hashFile(path) {
  const buffer = await readFile(path);
  return createHash("sha256").update(buffer).digest("hex");
}

async function walkFiles(root) {
  const queue = [resolve(root)];
  const files = [];

  while (queue.length > 0) {
    const current = queue.pop();
    const dirEntries = await readdir(current, { withFileTypes: true });

    for (const entry of dirEntries) {
      const fullPath = join(current, entry.name);

      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  return sortEntries(files);
}

async function computeContentHash(packageRoot) {
  const hash = createHash("sha256");
  const files = await walkFiles(packageRoot);

  for (const file of files) {
    hash.update(relative(packageRoot, file).replace(/\\/g, "/"));
    hash.update(":");
    hash.update(await hashFile(file));
    hash.update("\n");
  }

  return hash.digest("hex");
}

function createManifestEntries() {
  return [
    ...runtimeAssetPaths.map((path) => ({ path, kind: "directory", requiredAtRuntime: true })),
    ...runtimePackageNames.flatMap((name) => [
      { path: `packages/${name}/dist`, kind: "directory", requiredAtRuntime: true },
      { path: `packages/${name}/package.json`, kind: "file", requiredAtRuntime: true },
      { path: `node_modules/@reddwarf/${name}/package.json`, kind: "file", requiredAtRuntime: true }
    ]),
    ...runtimeDependencyNames.map((name) => ({
      path: `node_modules/${name}`,
      kind: "directory",
      requiredAtRuntime: true
    }))
  ];
}

async function loadPolicyPackManifestSchema(repoRoot) {
  const contractsModule = await import(
    pathToFileURL(resolve(repoRoot, "packages/contracts/dist/index.js")).href
  );
  return contractsModule.policyPackManifestSchema;
}

async function loadResolvedRuntimeDependencyVersions(repoRoot) {
  const entries = await Promise.all(
    runtimeDependencyNames.map(async (dependencyName) => {
      const dependencyPackageJson = await readJson(resolve(repoRoot, `node_modules/${dependencyName}/package.json`));
      return [dependencyName, dependencyPackageJson.version];
    })
  );

  return Object.fromEntries(entries);
}

async function materializeRuntimeNodeModules(repoRoot, packageRoot) {
  const sourceNodeModulesRoot = resolve(repoRoot, "node_modules");
  const destinationNodeModulesRoot = resolve(packageRoot, "node_modules");
  const destinationWorkspaceScopeRoot = resolve(destinationNodeModulesRoot, "@reddwarf");
  const sourceVirtualStoreRoot = resolve(sourceNodeModulesRoot, ".pnpm");

  await ensureDir(destinationNodeModulesRoot);
  await ensureDir(destinationWorkspaceScopeRoot);

  for (const dependencyName of runtimeDependencyNames) {
    await copyDirectory(resolve(sourceNodeModulesRoot, dependencyName), resolve(destinationNodeModulesRoot, dependencyName));
  }

  for (const packageName of runtimePackageNames) {
    await copyDirectory(resolve(packageRoot, `packages/${packageName}`), resolve(destinationWorkspaceScopeRoot, packageName));
  }

  const virtualStoreEntries = await readdir(sourceVirtualStoreRoot, { withFileTypes: true });

  for (const storeEntry of virtualStoreEntries) {
    if (!storeEntry.isDirectory() || storeEntry.name === "node_modules") {
      continue;
    }

    const packageNodeModulesRoot = resolve(sourceVirtualStoreRoot, storeEntry.name, "node_modules");

    try {
      const packageEntries = await readdir(packageNodeModulesRoot, { withFileTypes: true });

      for (const packageEntry of packageEntries) {
        if (packageEntry.name.startsWith(".")) {
          continue;
        }

        if (packageEntry.isDirectory() && packageEntry.name.startsWith("@")) {
          const scopedRoot = resolve(packageNodeModulesRoot, packageEntry.name);
          const scopedEntries = await readdir(scopedRoot, { withFileTypes: true });

          for (const scopedEntry of scopedEntries) {
            if (!scopedEntry.isDirectory()) {
              continue;
            }

            const sourcePath = resolve(scopedRoot, scopedEntry.name);
            const destinationPath = resolve(destinationNodeModulesRoot, packageEntry.name, scopedEntry.name);

            try {
              await access(destinationPath);
            } catch {
              await copyDirectory(sourcePath, destinationPath);
            }
          }

          continue;
        }

        if (!packageEntry.isDirectory()) {
          continue;
        }

        const sourcePath = resolve(packageNodeModulesRoot, packageEntry.name);
        const destinationPath = resolve(destinationNodeModulesRoot, packageEntry.name);

        try {
          await access(destinationPath);
        } catch {
          await copyDirectory(sourcePath, destinationPath);
        }
      }
    } catch {
      // Skip entries that do not expose a node_modules subtree.
    }
  }
}

function createPackagedWorkspacePackageJson(packageJson, resolvedRuntimeDependencyVersions) {
  const dependencies = Object.fromEntries(
    Object.entries(packageJson.dependencies ?? {}).map(([dependencyName, version]) => {
      if (version === "workspace:*" && dependencyName.startsWith("@reddwarf/")) {
        const dependencyPackageName = dependencyName.split("/")[1];
        return [dependencyName, `file:../${dependencyPackageName}`];
      }

      return [dependencyName, resolvedRuntimeDependencyVersions[dependencyName] ?? version];
    })
  );

  return {
    ...packageJson,
    dependencies: Object.keys(dependencies).length > 0 ? dependencies : undefined
  };
}

function createPackagedRootPackageJson(rootPackageJson, resolvedRuntimeDependencyVersions) {
  return {
    name: "@reddwarf/policy-pack-runtime",
    version: rootPackageJson.version,
    private: true,
    type: "module",
    dependencies: {
      ...Object.fromEntries(runtimePackageNames.map((name) => [`@reddwarf/${name}`, `file:./packages/${name}`])),
      ...Object.fromEntries(runtimeDependencyNames.map((name) => [name, resolvedRuntimeDependencyVersions[name] ?? rootPackageJson.dependencies[name]]))
    }
  };
}

async function stagePolicyPackRoot(repoRoot, stageRoot, resolvedRuntimeDependencyVersions) {
  await ensureDir(stageRoot);
  await ensureDir(resolve(stageRoot, "packages"));

  for (const assetPath of runtimeAssetPaths) {
    await copyDirectory(resolve(repoRoot, assetPath), resolve(stageRoot, assetPath));
  }

  for (const packageName of runtimePackageNames) {
    const sourcePackageRoot = resolve(repoRoot, `packages/${packageName}`);
    const stagedPackageRoot = resolve(stageRoot, `packages/${packageName}`);

    await ensureDir(stagedPackageRoot);
    await copyDirectory(resolve(sourcePackageRoot, "dist"), resolve(stagedPackageRoot, "dist"));
    const sourcePackageJson = await readJson(resolve(sourcePackageRoot, "package.json"));
    const packagedPackageJson = createPackagedWorkspacePackageJson(sourcePackageJson, resolvedRuntimeDependencyVersions);
    await writeFile(resolve(stagedPackageRoot, "package.json"), `${JSON.stringify(packagedPackageJson, null, 2)}\n`, "utf8");
  }
}

export async function createPolicyPackPackage(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const outputRoot = resolve(options.outputRoot ?? join(repoRoot, "artifacts/policy-packs"));
  const now = options.now ?? new Date();
  const rootPackageJson = await readJson(resolve(repoRoot, "package.json"));
  const resolvedRuntimeDependencyVersions = await loadResolvedRuntimeDependencyVersions(repoRoot);
  const buildStamp = toBuildStamp(now);
  const policyPackVersion = options.policyPackVersion ?? `${rootPackageJson.version}+${buildStamp}`;
  const artifactDir = resolve(outputRoot, `reddwarf-policy-pack-${policyPackVersion}`);
  const stagingParent = await mkdtemp(join(tmpdir(), "reddwarf-policy-pack-"));
  const stagingRoot = resolve(stagingParent, "policy-root");

  try {
    await stagePolicyPackRoot(repoRoot, stagingRoot, resolvedRuntimeDependencyVersions);
    const packagedRootPackageJson = createPackagedRootPackageJson(rootPackageJson, resolvedRuntimeDependencyVersions);
    await writeFile(resolve(stagingRoot, "package.json"), `${JSON.stringify(packagedRootPackageJson, null, 2)}\n`, "utf8");
    await materializeRuntimeNodeModules(repoRoot, stagingRoot);

    const contentHash = await computeContentHash(stagingRoot);
    const packageRoot = resolve(artifactDir, "policy-root");
    const manifestSchema = await loadPolicyPackManifestSchema(repoRoot);
    const manifest = manifestSchema.parse({
      policyPackId: "reddwarf-policy-pack",
      policyPackVersion,
      rootPackageVersion: rootPackageJson.version,
      createdAt: now.toISOString(),
      sourceRoot: repoRoot,
      packageRoot,
      composePolicySourceRoot: packageRoot,
      contentHash,
      runtimeDependenciesBundled: true,
      includedEntries: createManifestEntries(),
      notes: [
        "This package is intended for immutable Docker mounts into OpenClaw.",
        "Bind mounts remain available for live development, but packaged mounts are preferred for versioned runtime promotion."
      ]
    });

    await writeFile(resolve(stagingRoot, "policy-pack.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await rm(artifactDir, { recursive: true, force: true });
    await copyDirectory(stagingRoot, packageRoot);

    return {
      artifactDir,
      packageRoot,
      manifestPath: resolve(packageRoot, "policy-pack.manifest.json"),
      manifest
    };
  } finally {
    await rm(stagingParent, { recursive: true, force: true });
  }
}
