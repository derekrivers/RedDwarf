import { createPolicyPackPackage } from "./lib/policy-packaging.mjs";

const packaged = await createPolicyPackPackage();
console.log(
  JSON.stringify(
    {
      artifactDir: packaged.artifactDir,
      packageRoot: packaged.packageRoot,
      manifestPath: packaged.manifestPath,
      policyPackVersion: packaged.manifest.policyPackVersion,
      contentHash: packaged.manifest.contentHash
    },
    null,
    2
  )
);
