import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

export const config = {
  root: ROOT,
  sampleMode: env("SAMPLE_MODE").toLowerCase() === "true",
  sampleScenario: env("SAMPLE_SCENARIO", "monday-morning"),
  zetaris: {
    restUrl: env("ZETARIS_REST_URL", "http://127.0.0.1:8888/api/v1.0"),
    orgId: env("ZETARIS_ORG_ID", "1"),
    apiKey: env("ZETARIS_API_KEY"),
  },
  llm: {
    provider: env("LLM_PROVIDER", "meterless") as "meterless" | "nvidia",
    meterlessBaseUrl: env("METERLESS_BASE_URL", "http://127.0.0.1:8088/v1"),
    meterlessToken: env("METERLESS_RUNTIME_TOKEN"),
    modelFast: env("METERLESS_MODEL_FAST", "meterless/fast"),
    modelDeep: env("METERLESS_MODEL_DEEP", "meterless/deep"),
    nvidiaApiKey: env("NVIDIA_API_KEY"),
    nvidiaModelFast: env("NVIDIA_MODEL_FAST", "nvidia/nemotron-3.5-lightning-30b-a3b"),
    nvidiaModelDeep: env("NVIDIA_MODEL_DEEP", "nvidia/nemotron-3-ultra-550b-a55b"),
  },
  hospitalDbPassword: env("HOSPITAL_DB_PASSWORD"),
  logsDir: path.join(ROOT, "logs"),
  samplesDir: path.join(ROOT, "samples"),
};
