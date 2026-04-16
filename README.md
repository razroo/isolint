# Isomodel

> A large model designs the harness. A small model executes it.
> Same logic, same steps, same outputs — different capability tier.

Isomodel is a **capability transfer system**, not a prompt library.
It lets a frontier model (Claude Opus, GPT-4-class) architect a reusable,
strictly-typed execution plan once, and then hands that plan to a small,
cheap model (Mistral 7B, local models, MiniMax) that runs it deterministically.

```
┌──────────────────┐   plan.json    ┌───────────────────┐   structured output
│  LARGE MODEL     │ ─────────────▶ │  SMALL MODEL      │ ──────────────────▶
│  (the architect) │                │  (the executor)   │
└──────────────────┘                └───────────────────┘
   planning phase                     runtime phase
   pay token cost once                pay tiny cost per step
```

## Why

Most "agent" systems push all complexity into the runtime: long system
prompts, sprawling instructions, taste-based validation. Small models
collapse under that weight.

Isomodel inverts this. The frontier model spends tokens **once** to produce
a machine-checkable plan — explicit steps, machine-checkable constraints,
JSON-Schema-typed outputs. The runtime prompts are then tiny and unambiguous,
which is exactly what small models need.

## Architecture

```
src/
├── schema/      # Strict Plan schema (the contract)
├── planner/     # Large-model → Plan (JSON)
├── runtime/     # Small-model executor (validates every step)
├── providers/   # OpenAI / OpenRouter / Ollama / Mock
├── util/        # JSON extraction, logger
└── cli/         # isomodel plan | run | validate
```

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

### `isomodel plan`

Ask the large model to generate a Plan for a new task.

```bash
npx isomodel plan \
  --task "Extract purchase orders from emails into {po_number, vendor, total}" \
  --out plans/po-extract.json
```

### `isomodel run`

Run an existing Plan through the small model.

```bash
npx isomodel run \
  --plan examples/multi-step-reasoning/plan.json \
  --input examples/multi-step-reasoning/input.json
```

Pipe stdin:

```bash
cat ticket.json | npx isomodel run --plan plan.json --input -
```

### `isomodel validate`

Schema-check a plan without running it.

```bash
npx isomodel validate --plan examples/cold-email/plan.json
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
npx isomodel run \
  --plan examples/data-extraction/plan.json \
  --input examples/data-extraction/input.json \
  --small mistralai/mistral-7b-instruct
```

## Programmatic API

```ts
import { Planner, Runtime, createProvider, assertPlan } from "isomodel";

const plan = await new Planner(
  createProvider({ model: "anthropic/claude-3.5-sonnet" }),
).generate({ task: "Classify tickets and propose a next action" });

const result = await new Runtime(
  createProvider({ model: "mistralai/mistral-7b-instruct" }),
).run(plan.plan, { ticket: { subject: "...", body: "..." } });

console.log(result.final);
```

## Design constraints (enforced)

- **No long runtime prompts.** All complexity lives in the Plan.
- **No vague instructions.** The planner system prompt forbids
  "be creative", "engaging", "appropriate", etc.
- **No world-knowledge dependence.** Every step must cite `$input`
  or a prior step as its fact source.
- **No taste-based validation.** Constraints must be regex, length,
  enum, or schema.
- **Deterministic by default.** Runtime temperature defaults to `0`.

## Tests

```bash
npm test
```

13 tests covering schema validation, JSON extraction, runtime retry/repair,
fallback handling, and input-schema enforcement.

## License

MIT
