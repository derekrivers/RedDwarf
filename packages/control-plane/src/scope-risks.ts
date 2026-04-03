const testFilePattern = /^(?:tests|test)\/.+\.(?:test|spec)\.[^/]+$/i;
const testSetupFilePattern = /^(?:tests|test)\/setup\.[^/]+$/i;
const viteConfigPattern = /^(?:vite|vitest)\.config\.[^/]+$/i;

export function detectPreDispatchScopeRisks(
  allowedPaths: readonly string[]
): string[] {
  const hasApprovedTestFile = allowedPaths.some((path) => testFilePattern.test(path));
  const hasApprovedTestSetupFile = allowedPaths.some((path) =>
    testSetupFilePattern.test(path)
  );
  const hasApprovedViteConfig = allowedPaths.some((path) => viteConfigPattern.test(path));

  const warnings: string[] = [];

  if (hasApprovedTestFile && hasApprovedViteConfig && !hasApprovedTestSetupFile) {
    warnings.push(
      "No standalone test setup helper file is approved. If test setup is needed, keep it inside the approved test file instead of creating tests/setup.ts or test/setup.ts."
    );
  }

  return warnings;
}
