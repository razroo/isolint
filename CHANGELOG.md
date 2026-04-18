# Changelog

## 1.2.0

### Added
- **`isolint cost [path]`** — new command. Buckets harness files into
  shared-prefix (loaded every turn), per-mode, and per-agent, then reports
  approximate per-turn prompt-token cost with section-level breakdown for
  the always-loaded files. Same `chars ÷ 4` heuristic as
  `perf-shared-prefix-budget` so numbers line up with lint findings.
  - `--budget N` — exits non-zero when the shared-prefix total exceeds `N`
    tokens (CI guard for always-loaded context cost).
  - `--no-sections` — skip per-section breakdown.
  - `--format json` — machine-readable output.
- **Six new performance rules**:
  - `perf-rationale-in-shared-prefix` — `Why:` / `Historical note:` /
    dated incident narratives in always-loaded files.
  - `perf-emphasis-inflation` — saturated `MUST` / `NEVER` / `CRITICAL`
    density (≥8 all-caps intensifiers per 100 words).
  - `perf-cross-file-duplicate-block` — 20+ word paragraphs copy-pasted
    verbatim across ≥2 harness files; reported once on the last file
    alphabetically.
  - `perf-dense-prohibition-list` — 3+ consecutive
    `Do not X. Never Y. Must not Z.` sentences that should be a bullet
    list.
  - `perf-conditional-mode-branch-in-shared-prefix` — `if/when`
    sentences in shared prefixes that name a discovered `modes/*.md`
    mode. Tight matching: backtick-wrapped mode names,
    `<mode> mode/flow/task`, or `dispatches an <mode>` — plain noun
    collisions don't trigger.
  - `perf-nested-conditional-chain` — sentences chaining ≥3
    `if/when/unless/whenever` conditions.

### Changed
- **Scanner honors `.gitignore` by default** when run inside a git repo.
  Uses `git ls-files --cached --others --exclude-standard` as an
  allowlist so build output (generated `CLAUDE.md`, `AGENTS.md`,
  `.cursor/rules/`, `.opencode/{agents,skills}/` in iso-built repos)
  isn't linted as first-class harness content. `--no-gitignore` opts
  out. Single-file targets bypass the allowlist.
- Extracted `src/lint/paths.ts` as the single source of truth for
  harness path classification (shared prefix / mode / agent). Both
  `cost` and performance rules import from there.

### Fixed
- macOS path canonicalization via `realpathSync` so `/var` vs.
  `/private/var` doesn't break gitignore membership checks.

## 1.1.0

- Planner performance loop and harness performance tooling.

## 1.0.0

- LLM rules rework and `isolint verify`.
