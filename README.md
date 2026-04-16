# Isolint

[![npm](https://img.shields.io/npm/v/@razroo/isolint.svg)](https://www.npmjs.com/package/@razroo/isolint)
[![CI](https://github.com/razroo/isolint/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/razroo/isolint/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@razroo/isolint.svg)](./LICENSE)

> Lint your AI harness so weak small models can actually run it.
> Finds the phrasing that breaks Minimax 2.5, Nemotron 3, Mistral 7B,
> and local models — then rewrites it with a smart model.

You author a harness (opencode modes, Claude Code agent files, Cursor rules,
plain `.md` skills) with a frontier model. You want to run it on a cheap
small model. The logic is fine — but the **prose** is full of phrases
that only a frontier model knows how to interpret:
`should`, `when relevant`, `one of the usual categories`, `the table above`,
`creative`, `leveraged`. Small models drop clauses, invent items, ignore
soft imperatives, and blow past taste words.

Isolint fixes that:

```
┌─────────────────┐           ┌─────────────────────┐           ┌─────────────────┐
│  Your harness   │  isolint  │  Lint report + diff │  --fix    │  Same harness,  │
│  (.md files)    │ ────────▶ │  of every phrase    │ ────────▶ │  small-model-   │
│                 │           │  a 7B model misses  │           │  safe prose     │
└─────────────────┘           └─────────────────────┘           └─────────────────┘
```

Isolint also ships an **Isomorphic Plan** engine (`isolint plan` / `run`) —
a large model emits a strict JSON plan; a small model executes it with
schema validation. The linter uses this engine internally for its
LLM-assisted rules. Use it directly when you want a fully-deterministic
pipeline instead of markdown prose.

## Why

Most "agent" systems push all complexity into runtime prose: long system
prompts, sprawling instructions, taste-based validation. 7B-class models
collapse under that weight — not because the logic is wrong, but because
the prose is ambiguous.

Isolint scans for **18 deterministic rule patterns + 3 LLM-assisted rules**,
each targeting one concrete small-model failure mode. Every finding is a
fixable phrase. Every fix preserves intent and markdown formatting — and
every LLM rewrite is re-linted before being applied so bad fixes never ship.

## Architecture

```
src/
├── lint/        # Markdown harness linter (deterministic + LLM-assisted)
│   ├── rules/   # Individual rules (soft-imperative, taste-word, ...)
│   ├── fix.ts   # Deterministic fix engine + LLM rewriter
│   └── ...
├── schema/      # Strict Plan schema (the contract)
├── planner/     # Large-model → Plan (JSON)
├── runtime/     # Small-model executor (validates every step)
├── providers/   # OpenAI / OpenRouter / Ollama / Mock
├── util/        # JSON extraction, logger
└── cli/         # isolint lint | plan | run | validate
```

## The Linter (the practical win)

<!-- isolint-disable-next-line long-sentence -->
If you use Claude Code / Codex / Cursor to author a harness and then run it
on minimax / nemotron / local models, the #1 failure mode is not logic — it's
**prose the small model can't parse**. The linter catches that.

### What it flags

Every rule targets a concrete failure mode in weak models. All rules run
against fenced code blocks, inline code, and HTML comments are skipped.

<!-- isolint-disable -->

| Rule | Catches | Severity |
| --- | --- | --- |
| `soft-imperative` | `should`, `could`, `might`, `consider`, `ideally` — weak models drop these | warn |
| `vague-quantifier` | `some`, `several`, `a few`, `many`, `most` without a number | warn |
| `taste-word` | `creative`, `engaging`, `passionate`, `leveraged`, `cutting-edge`, etc. | warn |
| `ambiguous-deictic` | `the table above`, `as mentioned below` — position-based refs | info |
| `double-negation` | `don't forget to not skip…` — weak models flip the sign | warn |
| `long-sentence` | Sentences > 35 words — weak models drop clauses | info |
| `pronoun-no-antecedent` | `It`, `This`, `They` at start of block after a list/heading | info |
| `enum-without-list` | `one of the usual categories` without the list inline | warn |
| `word-count-target` | `write 100 words` — weak models count tokens poorly | info |
| `implicit-conditional` | `when relevant`, `if appropriate`, `as needed` | warn |
| `trailing-etc` | `A, B, C, etc.` — unclosed set, weak models invent items | warn |
| `heading-without-imperative` | Mode headings without an action verb | info |
| `nested-conditional` | Multiple `if` / `unless` / `except` in one sentence | warn |
| `multiple-output-formats` | "return JSON and a summary" in one step | warn |
| `placeholder-leftover` | `TODO`, `FIXME`, `<insert X>`, `[INSERT X]` — weak models echo scaffolding | warn |
| `output-format-no-example` | "return JSON" with no example, schema, or field list nearby | warn |
| `numbered-step-gap` | `1. … 2. … 4. …` — weak models inherit the gap and skip the step | warn |
| `step-without-verb` | `## Step N` body that opens with a noun, not an imperative verb | info |

<!-- isolint-enable -->

Plus three **LLM-assisted** rules (opt-in via `--llm`, implemented as
Isolint Plans) for checks that need judgment:

| Rule | Catches |
| --- | --- |
| `llm-atomicity` | Instructions bundling multiple actions into one sentence |
| `llm-implicit-context` | Phrases that rely on context not present in the file |
| `llm-unexplained-schema` | Output contracts in prose with no example / schema nearby |

### Quick start

```bash
# Scan any directory of .md / .mdc / .mdx files
npx @razroo/isolint lint /path/to/harness

# Just your opencode modes / Claude Code agents / Cursor rules
npx @razroo/isolint lint .opencode/skills .opencode/agents modes .cursor/rules

# Only lint files changed since main (great for PR CI)
npx @razroo/isolint lint . --since origin/main --fail-on warn

# JSON for CI / GitHub annotations (SARIF)
npx @razroo/isolint lint ./modes --format sarif > lint.sarif

# Auto-fix everything the rules can fix deterministically + via LLM rewrites
export OPENROUTER_API_KEY=sk-or-...
npx @razroo/isolint lint ./modes --fix --llm --large anthropic/claude-3.5-sonnet

# Dry-run: see the diff, don't write files
npx @razroo/isolint lint ./modes --fix --llm --diff
```

`.md`, `.mdc` (Cursor rules), and `.mdx` are all picked up by default. YAML
(`---`) / TOML (`+++`) frontmatter at the top of any file is skipped.

### Suppressions

Any file can silence findings with HTML comments:

```markdown
<!-- isolint-disable-next-line taste-word -->
These words (leveraged, cutting-edge, passionate) are ATS red flags.

<!-- isolint-disable -->
This whole block is documentation about banned words, not an instruction.
- leveraged
- utilized
- spearheaded
<!-- isolint-enable -->
```

No rule ids = suppress all rules on the target line(s).

### Config (`.isolint.json`)

Both `.isolint.json` and the legacy `.isomodel-lint.json` are read. Shape:

```json
{
  "extends": ["recommended"],
  "rules": {
    "pronoun-no-antecedent": "off",
    "long-sentence": "warn"
  },
  "ignore": ["docs/archive/**", "*.draft.md"],
  "options": {
    "long-sentence.max_words": 40,
    "taste-word.extra": ["bespoke", "revolutionary"]
  },
  "skip_spans": {
    "quoted_strings": true,
    "quoted_strings_max_chars": 40
  },
  "custom_rules": [
    {
      "id": "no-acme-brand",
      "pattern": "\\bAcme\\s+Corp\\b",
      "severity": "warn",
      "message": "Use 'ACME Inc' instead of 'Acme Corp'"
    }
  ]
}
```

`custom_rules[]` lets a team codify its own banned phrases without patching
isolint. Each spec takes `id` (must not collide with a built-in rule),
`pattern` (regex source), optional `flags` (default `gi`), optional
`severity` (default `warn`), and `message`. Invalid specs are logged to
stderr and skipped — one bad pattern never breaks a whole run.

Presets: `recommended` (deterministic rules only, safe for CI) or `strict`
(adds the three LLM rules — requires `--llm`).

### Skip spans

Rules never fire inside these spans:

| Span | Default | Why |
| --- | --- | --- |
| Fenced code blocks | on | Example input/output, not prose |
| Inline code (`` `word` ``) | on | The word is being named |
| HTML comments | on | Author notes |
| Short double-quoted phrases (≤ 40 chars) | on | `Avoid "leveraged", "cutting-edge"` — words being named, not used. Full-sentence quoted directives (>40 chars) still lint. |
| YAML/TOML frontmatter | on | Opencode modes, Claude Code agents, Cursor `.mdc` rules — structured metadata, not prose instructions |
| `>` blockquotes | on | Usually example input/output or quoted prose, not harness instructions |

`soft-imperative` additionally skips findings inside questions (sentence
ending in `?`) — `What story should they tell?` is not an instruction.

Disable any span via `skip_spans` in config.

### Section-aware severity

Every finding is tagged with its enclosing `## Heading`. You can mute or
downgrade rules inside specific sections:

```json
{
  "section_severity": {
    "Examples": "off",
    "Notes": "info",
    "Changelog": "off"
  }
}
```

Keys are case-insensitive. Useful for docs-heavy harness files where
`## Examples` contains intentional bad prose. The text reporter groups
findings by section so CI logs stay navigable.

### Sentence context

Every finding carries its containing sentence — the tokenizer correctly
handles abbreviations, filenames, decimals, URLs, and ellipses. This
powers three things:

1. **Text reports** show `in: "<sentence>"` so you can act without opening
   the file.
2. **`--fix --llm`** coalesces multiple findings in the same sentence into
   one rewrite — no more conflicting edits.
3. **JSON/SARIF** expose `sentence` and `section` fields so downstream
   tools (Claude Code, review bots) have the full context.

### Validated rewrites

Every LLM rewrite is re-linted before being applied. A rewrite is accepted
only if:

1. The rule that triggered the fix no longer fires on the new text.
2. No *new* rules fire on the new text.
3. Markdown structure is preserved (heading, list, code-fence, inline-code,
   bold, and link counts all match).

If a rewrite fails validation, the linter retries once with explicit
feedback about what went wrong. If the retry also fails, the fix is
skipped and reported in the fix summary — no mangled prose ever lands
on disk. This is what makes `--fix --llm` safe to run in CI.

### Real-world result

Run against JobForge's `modes/` directory (19 files, 1900+ lines of
opencode harness prose):

```
$ npx @razroo/isolint lint /Users/you/JobForge/modes
...
19 files scanned — 54 warnings, 6 infos
```

Every finding points at a concrete phrase that a 7B model will handle
worse than a Claude-class model. `--fix --llm` rewrites each one
while preserving intent and markdown formatting.

### Offline demo (no API key)

```bash
npx tsx examples/lint-demo/run.ts
```

Runs lint + fix end-to-end against a sample file with a mock rewriter.

---

## Plans (the compiler mode)

### The Plan format

A `Plan` is a pure data object (see `src/schema/plan.ts`):

- `input_schema` — JSON Schema for the user input.
- `steps[]` — ordered, atomic steps. Each step has:
  - `instruction` — a single imperative task.
  - `inputs` — explicit references: `$input` or `$steps.<id>`.
  - `constraints` — machine-checkable rules (length, regex, enum).
  - `expected_output` — `text`, `enum`, `json`+schema, or `list`.
  - `failure_handling` — `retry` | `repair` | `fallback` | `fail`.
- `final_output` — which step (or composition of steps) is the result.

Every plan is validated against `src/schema/plan.ts` before execution.
Every step output is validated against its `expected_output`.
Nothing is trusted.

### The Runtime

For each step, the runtime:

1. Resolves `inputs` (`$input`, prior step outputs).
2. Builds a minimal prompt — instruction, labeled inputs, constraints,
   explicit output format. No persona preamble, no hidden reasoning.
3. Calls the small model.
4. Validates the output:
   - Output kind (text/enum/json/list) + schema.
   - Constraints (`must_match` / `must_not_match` regex).
5. On failure, follows the step's `failure_handling`:
   - `retry` — same prompt.
   - `repair` — append validator errors, ask for a fix.
   - `fallback` — return a deterministic value.
   - `fail` — abort the plan.

## Install

```bash
npm install
npm run build
```

Requires Node ≥ 18.17.

## Configure

Copy `.env.example` → `.env`:

```bash
OPENROUTER_API_KEY=sk-or-...
ISOMODEL_LARGE=anthropic/claude-3.5-sonnet
ISOMODEL_SMALL=mistralai/mistral-7b-instruct
```

Any OpenAI-compatible endpoint works: OpenRouter, OpenAI, Groq, Together,
vLLM, Ollama (`--provider ollama`), or your own via `--provider custom --base-url`.

## CLI

### `isolint plan`

Ask the large model to generate a Plan for a new task.

```bash
npx @razroo/isolint plan \
  --task "Extract purchase orders from emails into {po_number, vendor, total}" \
  --out plans/po-extract.json
```

### `isolint run`

Run an existing Plan through the small model.

```bash
npx @razroo/isolint run \
  --plan examples/multi-step-reasoning/plan.json \
  --input examples/multi-step-reasoning/input.json
```

Pipe stdin:

```bash
cat ticket.json | npx @razroo/isolint run --plan plan.json --input -
```

### `isolint validate`

Schema-check a plan without running it.

```bash
npx @razroo/isolint validate --plan examples/cold-email/plan.json
```

## Examples

Three ready-to-run plans live in `examples/`:

| Example                   | What it shows                                                   |
| ------------------------- | --------------------------------------------------------------- |
| `cold-email/`             | Structured paragraphs with regex constraints (subject/hook/value/ask) |
| `data-extraction/`        | Strict-schema JSON extraction + numeric computation over prior steps |
| `multi-step-reasoning/`   | Support-ticket triage: classify → severity → root cause → next action |

### Offline demo (no API key)

```bash
npx tsx examples/offline-demo/run.ts
```

Runs the `multi-step-reasoning` plan end-to-end against a mock small model.
Proves the full loop: input validation → per-step execution → schema
validation → final output composition.

### Real run

```bash
npx @razroo/isolint run \
  --plan examples/data-extraction/plan.json \
  --input examples/data-extraction/input.json \
  --small mistralai/mistral-7b-instruct
```

## Programmatic API

```ts
import { Planner, Runtime, createProvider, assertPlan } from "@razroo/isolint";

const plan = await new Planner(
  createProvider({ model: "anthropic/claude-3.5-sonnet" }),
).generate({ task: "Classify tickets and propose a next action" });

const result = await new Runtime(
  createProvider({ model: "mistralai/mistral-7b-instruct" }),
).run(plan.plan, { ticket: { subject: "...", body: "..." } });

console.log(result.final);
```

## Design constraints (enforced)

<!-- isolint-disable -->

- **No long runtime prompts.** All complexity lives in the Plan.
- **No vague instructions.** The planner system prompt forbids
  "be creative", "engaging", "appropriate", etc.
- **No world-knowledge dependence.** Every step must cite `$input`
  or a prior step as its fact source.
- **No taste-based validation.** Constraints must be regex, length,
  enum, or schema.
- **Deterministic by default.** Runtime temperature defaults to `0`.

<!-- isolint-enable -->

## Tests

```bash
npm test
```

34 tests covering lint rules, suppressions, fix engine, diff output, schema
validation, JSON extraction, runtime retry/repair, fallback handling, and
input-schema enforcement.

## License

MIT
