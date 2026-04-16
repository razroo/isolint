#!/usr/bin/env node
import { mkdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Planner } from "../planner/index.js";
import { createProvider, type ProviderSpec } from "../providers/factory.js";
import { Runtime } from "../runtime/index.js";
import { assertPlan } from "../schema/validate.js";
import { createLogger, type LogLevel } from "../util/logger.js";
import { flagBool, flagString, parseArgs } from "./args.js";
import { loadDotEnv } from "./env.js";

const HELP = `isomodel - capability transfer system

Usage:
  isomodel plan  --task <text> [--hints <text>] --out <file.json> [provider flags]
  isomodel run   --plan <file.json> --input <file.json|->  [--out <file.json>] [provider flags]
  isomodel validate --plan <file.json>

Provider flags:
  --large <model>       Model slug for the planner   (env: ISOMODEL_LARGE)
  --small <model>       Model slug for the runtime   (env: ISOMODEL_SMALL)
  --provider <name>     openrouter | openai | ollama | custom
  --base-url <url>      Override base URL for provider
  --api-key <key>       Override API key

Other flags:
  --verbose, -v         Debug logging
  --quiet               Silent logging
  --help, -h            Show this help
`;

async function main(): Promise<void> {
  loadDotEnv();

  const { command, flags } = parseArgs(process.argv.slice(2));

  if (!command || flagBool(flags, "help", "h")) {
    process.stdout.write(HELP);
    return;
  }

  const level: LogLevel = flagBool(flags, "verbose", "v")
    ? "debug"
    : flagBool(flags, "quiet")
      ? "silent"
      : "info";
  const log = createLogger(level);

  switch (command) {
    case "plan":
      await cmdPlan(flags, log);
      return;
    case "run":
      await cmdRun(flags, log);
      return;
    case "validate":
      cmdValidate(flags);
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      process.exit(2);
  }
}

async function cmdPlan(flags: Record<string, string | boolean>, log: ReturnType<typeof createLogger>): Promise<void> {
  const task = flagString(flags, "task");
  const outPath = flagString(flags, "out", "o");
  if (!task) throw new Error("--task is required");
  if (!outPath) throw new Error("--out is required");

  const spec = resolveLargeSpec(flags);
  log.info("planner", { model: spec.model, provider: spec.provider ?? "auto" });

  const planner = new Planner(createProvider(spec));
  const { plan, attempts } = await planner.generate({
    task,
    hints: flagString(flags, "hints"),
  });

  const abs = resolve(process.cwd(), outPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(plan, null, 2) + "\n", "utf8");
  log.info("plan written", { path: abs, attempts, steps: plan.steps.length });
}

async function cmdRun(flags: Record<string, string | boolean>, log: ReturnType<typeof createLogger>): Promise<void> {
  const planPath = flagString(flags, "plan");
  const inputPath = flagString(flags, "input", "i");
  const outPath = flagString(flags, "out", "o");
  if (!planPath) throw new Error("--plan is required");
  if (!inputPath) throw new Error("--input is required");

  const plan = JSON.parse(readFileSync(resolve(process.cwd(), planPath), "utf8"));
  assertPlan(plan);

  const inputRaw = inputPath === "-"
    ? readStdin()
    : readFileSync(resolve(process.cwd(), inputPath), "utf8");
  const input = JSON.parse(inputRaw);

  const spec = resolveSmallSpec(flags);
  log.info("runtime", { model: spec.model, provider: spec.provider ?? "auto" });

  const runtime = new Runtime(createProvider(spec), { logger: log });
  const result = await runtime.run(plan, input);

  const payload = JSON.stringify(result, null, 2);
  if (outPath) {
    const abs = resolve(process.cwd(), outPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, payload + "\n", "utf8");
    log.info("result written", { path: abs, ok: result.ok });
  } else {
    process.stdout.write(payload + "\n");
  }
  if (!result.ok) process.exit(1);
}

function cmdValidate(flags: Record<string, string | boolean>): void {
  const planPath = flagString(flags, "plan");
  if (!planPath) throw new Error("--plan is required");
  const plan = JSON.parse(readFileSync(resolve(process.cwd(), planPath), "utf8"));
  assertPlan(plan);
  process.stdout.write(`plan "${plan.name}" is valid (${plan.steps.length} steps)\n`);
}

function resolveLargeSpec(flags: Record<string, string | boolean>): ProviderSpec {
  const model = flagString(flags, "large") ?? process.env.ISOMODEL_LARGE;
  if (!model) throw new Error("Set --large or ISOMODEL_LARGE");
  return {
    model,
    provider: flagString(flags, "provider"),
    baseUrl: flagString(flags, "base-url"),
    apiKey: flagString(flags, "api-key"),
  };
}

function resolveSmallSpec(flags: Record<string, string | boolean>): ProviderSpec {
  const model = flagString(flags, "small") ?? process.env.ISOMODEL_SMALL;
  if (!model) throw new Error("Set --small or ISOMODEL_SMALL");
  return {
    model,
    provider: flagString(flags, "provider"),
    baseUrl: flagString(flags, "base-url"),
    apiKey: flagString(flags, "api-key"),
  };
}

function readStdin(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);
  while (true) {
    let bytes = 0;
    try {
      bytes = readSync(0, buf, 0, buf.length, null);
    } catch {
      break;
    }
    if (bytes <= 0) break;
    chunks.push(Buffer.from(buf.subarray(0, bytes)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

main().catch((err) => {
  process.stderr.write(`[isomodel] error: ${(err as Error).message}\n`);
  process.exit(1);
});
