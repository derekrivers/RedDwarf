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
      // npm run --if-present is the right semantic here: it exits 0 only if
      // the script is missing OR it succeeds. Real script failures surface.
      return `# RedDwarf default required checks (M25 F-192) — Node stack
#
# Each job (lint / build / test) succeeds iff its underlying npm script
# either does not exist (--if-present) or exits 0. Real failures surface
# so the F-194 auto-merge gate's "check is green" signal is meaningful.

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
        with: { node-version: '20' }
      - name: install
        run: |
          if [ -f package-lock.json ]; then npm ci; else npm install; fi
      - run: npm run lint --if-present
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - name: install
        run: |
          if [ -f package-lock.json ]; then npm ci; else npm install; fi
      - run: npm run build --if-present
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - name: install
        run: |
          if [ -f package-lock.json ]; then npm ci; else npm install; fi
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
        with: { python-version: '3.12' }
      - name: install ruff
        run: pip install ruff
      - name: ruff check
        run: ruff check .
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
      - name: detect manifest
        id: detect
        run: |
          if [ -f pyproject.toml ]; then echo "kind=pyproject" >> "$GITHUB_OUTPUT"
          elif [ -f setup.py ]; then echo "kind=setup-py" >> "$GITHUB_OUTPUT"
          elif [ -f requirements.txt ]; then echo "kind=requirements" >> "$GITHUB_OUTPUT"
          else echo "kind=none" >> "$GITHUB_OUTPUT"
          fi
      - name: build (pyproject)
        if: steps.detect.outputs.kind == 'pyproject'
        run: |
          pip install --upgrade pip build
          python -m build
      - name: build (setup.py)
        if: steps.detect.outputs.kind == 'setup-py'
        run: pip install .
      - name: install requirements
        if: steps.detect.outputs.kind == 'requirements'
        run: pip install -r requirements.txt
      - name: no manifest (failing intentionally)
        if: steps.detect.outputs.kind == 'none'
        run: |
          echo "::error::No Python build manifest detected. Add pyproject.toml or setup.py."
          exit 1
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
      - name: install pytest
        run: pip install pytest
      - name: pytest
        run: pytest -q
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
      // Conservative Ruby/Rails scaffold. Three rules:
      //   - Steps either run their command and surface its real exit code,
      //     OR they don't run at all (controlled by an `if:` predicate).
      //     No "command || true" anywhere — that defeats M25's gate 6.
      //   - bundler-cache=false so this doesn't fail on first-commit Rails
      //     apps that don't yet have a Gemfile.lock.
      //   - "detect" prep step exposes per-tool booleans so each subsequent
      //     step decides cleanly whether to execute.
      return `# RedDwarf default required checks (M25 F-192) — Ruby / Rails stack
#
# Each job (lint, build, test) succeeds iff its underlying command
# succeeds. Steps that depend on tooling not present in this repo
# (no rubocop, no rails, no rspec) are skipped via if:, not silently
# swallowed — so the F-194 auto-merge gate's "check is green" signal
# means the relevant command actually passed.

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
          bundler-cache: false
      - name: bundle install
        run: bundle install --jobs 4 --retry 3
      - name: detect rubocop
        id: detect
        run: |
          if bundle show rubocop >/dev/null 2>&1; then
            echo "rubocop=true" >> "$GITHUB_OUTPUT"
          else
            echo "rubocop=false" >> "$GITHUB_OUTPUT"
          fi
      - name: rubocop
        if: steps.detect.outputs.rubocop == 'true'
        run: bundle exec rubocop --parallel
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ruby/setup-ruby@v1
        with:
          bundler-cache: false
      - name: bundle install
        run: bundle install --jobs 4 --retry 3
      - name: detect rails
        id: detect
        run: |
          if [ -x bin/rails ]; then
            echo "rails=true" >> "$GITHUB_OUTPUT"
          else
            echo "rails=false" >> "$GITHUB_OUTPUT"
          fi
      - name: assets:precompile
        if: steps.detect.outputs.rails == 'true'
        env:
          RAILS_ENV: test
          SECRET_KEY_BASE: dummy_for_assets_precompile
        run: bundle exec rails assets:precompile
  test:
    runs-on: ubuntu-latest
    env:
      RAILS_ENV: test
    steps:
      - uses: actions/checkout@v4
      - uses: ruby/setup-ruby@v1
        with:
          bundler-cache: false
      - name: bundle install
        run: bundle install --jobs 4 --retry 3
      - name: detect runner
        id: detect
        run: |
          if [ -x bin/rails ]; then
            echo "runner=rails" >> "$GITHUB_OUTPUT"
          elif bundle show rspec-core >/dev/null 2>&1; then
            echo "runner=rspec" >> "$GITHUB_OUTPUT"
          elif [ -f Rakefile ] && bundle exec rake -T test >/dev/null 2>&1; then
            echo "runner=rake" >> "$GITHUB_OUTPUT"
          else
            echo "runner=none" >> "$GITHUB_OUTPUT"
          fi
      - name: rails test
        if: steps.detect.outputs.runner == 'rails'
        run: |
          bundle exec rails db:prepare
          bundle exec rails test
      - name: rspec
        if: steps.detect.outputs.runner == 'rspec'
        run: bundle exec rspec
      - name: rake test
        if: steps.detect.outputs.runner == 'rake'
        run: bundle exec rake test
      - name: no test runner detected (failing intentionally)
        if: steps.detect.outputs.runner == 'none'
        run: |
          echo "::error::No test runner found (rails / rspec / rake test). Add one or remove the 'test' check from the project's RequiredCheckContract."
          exit 1
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
