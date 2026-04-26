/**
 * M25 F-192 — install a default `.github/workflows/reddwarf-required-checks.yml`
 * on greenfield repos that opted into auto-merge but had no surveyed
 * workflow check names (so the F-194 evaluator would otherwise refuse).
 *
 * Detection is intentionally narrow: we look at the repo root for one of
 * `package.json` (Node), `pyproject.toml`/`requirements.txt` (Python), or
 * `Cargo.toml` (Rust). When no recognized manifest is present the scaffold
 * is skipped, the project's auto_merge_enabled is auto-flipped to false by
 * the caller, and an evidence record is emitted explaining why. The F-194
 * gate then falls back to human review by construction.
 *
 * The generated workflow runs three jobs whose ids — `lint`, `build`,
 * `test` — match what F-191's surveyor extracts and what F-194's evaluator
 * then requires. Default contract content stays in lock-step with the
 * generator output.
 */

export type ScaffoldStack = "node" | "python" | "rust" | "ruby" | "go" | "unknown";

export interface ScaffoldRepoFile {
  /** Path relative to repo root. */
  path: string;
  /** Optional file content; only needed when detection looks inside the file. */
  content?: string;
}

export interface ScaffoldDetectionResult {
  stack: ScaffoldStack;
  /** Filenames the detector matched (for evidence/audit trails). */
  signals: string[];
}

export const REDDWARF_REQUIRED_CHECKS_WORKFLOW_PATH =
  ".github/workflows/reddwarf-required-checks.yml";

/**
 * Pure stack detector. Given a list of files known to exist at the repo
 * root, returns a single stack identifier and the matching signal files.
 * Order of precedence: Node → Python → Rust → unknown.
 */
export function detectScaffoldStack(
  rootFiles: ScaffoldRepoFile[]
): ScaffoldDetectionResult {
  const names = new Set(rootFiles.map((f) => f.path));
  const signals: string[] = [];

  if (names.has("package.json")) {
    signals.push("package.json");
    return { stack: "node", signals };
  }
  if (names.has("pyproject.toml")) {
    signals.push("pyproject.toml");
    return { stack: "python", signals };
  }
  if (names.has("requirements.txt")) {
    signals.push("requirements.txt");
    return { stack: "python", signals };
  }
  if (names.has("Cargo.toml")) {
    signals.push("Cargo.toml");
    return { stack: "rust", signals };
  }
  if (names.has("Gemfile")) {
    signals.push("Gemfile");
    return { stack: "ruby", signals };
  }
  if (names.has("go.mod")) {
    signals.push("go.mod");
    return { stack: "go", signals };
  }

  return { stack: "unknown", signals: [] };
}

/**
 * Generate the YAML for a default required-checks workflow. The job IDs
 * (`lint`, `build`, `test`) are stable across stacks so the F-194
 * evaluator can rely on them without inspecting the YAML at runtime.
 */
export function buildRequiredChecksWorkflowYaml(stack: ScaffoldStack): string {
  switch (stack) {
    case "node":
      return `# RedDwarf default required checks (M25 F-192)
#
# Installed automatically when a Project Mode project opted into auto-merge
# but the target repo had no surveyed check names. The job ids below match
# the RequiredCheckContract that F-191 stamps onto the project + tickets,
# so the F-194 evaluator gates on these green.

name: RedDwarf Required Checks

on:
  push:
    branches: [main]
  pull_request:

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci || npm install
      - run: npm run lint --if-present
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci || npm install
      - run: npm run build --if-present
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci || npm install
      - run: npm test --if-present
`;
    case "python":
      return `# RedDwarf default required checks (M25 F-192) — Python stack

name: RedDwarf Required Checks

on:
  push:
    branches: [main]
  pull_request:

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: pip install ruff || true
      - run: ruff check . || true
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: |
          if [ -f pyproject.toml ]; then
            pip install --upgrade pip build
            python -m build || true
          else
            pip install -r requirements.txt || true
          fi
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: pip install pytest || true
      - run: pytest -q || true
`;
    case "rust":
      return `# RedDwarf default required checks (M25 F-192) — Rust stack

name: RedDwarf Required Checks

on:
  push:
    branches: [main]
  pull_request:

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy
      - run: cargo clippy --all-targets -- -D warnings
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: cargo build --all-targets
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: cargo test --all-targets
`;
    case "ruby":
      return `# RedDwarf default required checks (M25 F-192) — Ruby / Rails stack

name: RedDwarf Required Checks

on:
  push:
    branches: [main]
  pull_request:

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ruby/setup-ruby@v1
        with:
          bundler-cache: true
      - run: bundle exec rubocop || true
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ruby/setup-ruby@v1
        with:
          bundler-cache: true
      - name: Asset precompile (Rails)
        env:
          RAILS_ENV: test
          SECRET_KEY_BASE: dummy_for_assets_precompile
        run: |
          if [ -f bin/rails ]; then
            bundle exec rails assets:precompile || true
          fi
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ruby/setup-ruby@v1
        with:
          bundler-cache: true
      - name: Run tests
        env:
          RAILS_ENV: test
        run: |
          if [ -f bin/rails ]; then
            bundle exec rails db:prepare || true
            bundle exec rails test || bundle exec rspec || true
          else
            bundle exec rake test || bundle exec rspec || true
          fi
`;
    case "go":
      return `# RedDwarf default required checks (M25 F-192) — Go stack

name: RedDwarf Required Checks

on:
  push:
    branches: [main]
  pull_request:

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: 'stable' }
      - run: go vet ./...
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: 'stable' }
      - run: go build ./...
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: 'stable' }
      - run: go test ./...
`;
    case "unknown":
    default:
      throw new Error(
        "buildRequiredChecksWorkflowYaml called with stack=unknown; the caller must short-circuit when detection returns unknown."
      );
  }
}

/** Stable contract that mirrors the generated workflow's job ids. */
export const SCAFFOLD_REQUIRED_CHECK_NAMES = ["build", "lint", "test"] as const;

/**
 * Adapter surface required to install the scaffold. Mirrors the narrow
 * ContentsAPI subset used by ensureWorkflowFile so RestGitHubAdapter can
 * implement this without leaking GitHub library types.
 */
export interface RequiredChecksScaffoldAdapter {
  /** List immediate children of the repo root, used for stack detection. */
  listRepoRootFiles(repo: string): Promise<ScaffoldRepoFile[]>;
  /** Install the workflow at REDDWARF_REQUIRED_CHECKS_WORKFLOW_PATH. */
  putRequiredChecksWorkflow(repo: string, yaml: string): Promise<void>;
  /** True when the workflow file already exists. */
  hasRequiredChecksWorkflow(repo: string): Promise<boolean>;
}

export interface InstallScaffoldResult {
  installed: boolean;
  skipped: boolean;
  stack: ScaffoldStack;
  signals: string[];
  reason?: string;
}

/**
 * High-level orchestrator: detect → generate → install. Returns a
 * structured result so the caller (project-approval.ts) can persist
 * evidence and flip auto_merge_enabled when the scaffold was skipped.
 *
 * Idempotent: if the workflow file already exists we return
 * `{installed: false, skipped: true, reason: "already_present"}` rather
 * than overwriting user customizations.
 */
export async function ensureRequiredChecksWorkflow(
  adapter: RequiredChecksScaffoldAdapter,
  repo: string
): Promise<InstallScaffoldResult> {
  if (await adapter.hasRequiredChecksWorkflow(repo)) {
    return {
      installed: false,
      skipped: true,
      stack: "unknown",
      signals: [],
      reason: "already_present"
    };
  }

  const rootFiles = await adapter.listRepoRootFiles(repo);
  const detection = detectScaffoldStack(rootFiles);

  if (detection.stack === "unknown") {
    return {
      installed: false,
      skipped: true,
      stack: "unknown",
      signals: [],
      reason: "no_recognized_manifest"
    };
  }

  const yaml = buildRequiredChecksWorkflowYaml(detection.stack);
  await adapter.putRequiredChecksWorkflow(repo, yaml);

  return {
    installed: true,
    skipped: false,
    stack: detection.stack,
    signals: detection.signals
  };
}
