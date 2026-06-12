import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { createJiti } from "jiti";
import { parse as parseYaml } from "yaml";
import type { AppKeyResolver, AuthFallback, ServicePlugin, Store, WebhookDispatcher } from "@emulators/core";

export interface SeedConfig {
  tokens?: Record<string, { login: string; scopes?: string[] }>;
  [service: string]: unknown;
}

export interface EmulateServiceConfig {
  plugin?: ServicePlugin;
  port?: number;
  baseUrl?: string;
  seed?: Record<string, unknown>;
  seedFromConfig?(store: Store, baseUrl: string, config: unknown, webhooks?: WebhookDispatcher): void;
  createAppKeyResolver?(store: Store): AppKeyResolver;
  defaultFallback?(svcSeedConfig?: Record<string, unknown>): AuthFallback;
}

export interface EmulateConfig {
  port?: number;
  baseUrl?: string;
  tokens?: Record<string, { login: string; scopes?: string[] }>;
  seed?: SeedConfig;
  services?: Record<string, EmulateServiceConfig>;
}

export interface LoadedConfig {
  source: string;
  seedConfig: SeedConfig;
  runtimeConfig?: EmulateConfig;
}

export function defineConfig<const T extends EmulateConfig>(config: T): T {
  return config;
}

export async function loadConfig(options: { configPath?: string; seedPath?: string } = {}): Promise<LoadedConfig | null> {
  if (options.configPath && options.seedPath) {
    throw new Error("--config and --seed are mutually exclusive");
  }

  if (options.configPath) {
    return loadConfigFile(options.configPath);
  }

  if (options.seedPath) {
    return loadSeedFile(options.seedPath);
  }

  const autoFiles = [
    "emulate.config.ts",
    "emulate.config.mts",
    "emulate.config.js",
    "emulate.config.mjs",
    "emulate.config.yaml",
    "emulate.config.yml",
    "emulate.config.json",
    "service-emulator.config.yaml",
    "service-emulator.config.yml",
    "service-emulator.config.json",
  ];

  for (const file of autoFiles) {
    if (!existsSync(resolve(file))) continue;
    return isCodeConfig(file) ? loadConfigFile(file) : loadSeedFile(file);
  }

  return null;
}

async function loadConfigFile(configPath: string): Promise<LoadedConfig> {
  const fullPath = resolve(configPath);
  if (!existsSync(fullPath)) {
    throw new Error(`Config file not found: ${fullPath}`);
  }

  if (!isCodeConfig(fullPath)) {
    return loadSeedFile(configPath);
  }

  try {
    const jiti = createJiti(import.meta.url);
    const config = await jiti.import<EmulateConfig>(fullPath, { default: true });
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("config must export an object");
    }

    return {
      source: configPath,
      seedConfig: normalizeRuntimeSeedConfig(config),
      runtimeConfig: config,
    };
  } catch (err) {
    throw new Error(`Failed to load ${configPath}: ${err instanceof Error ? err.message : err}`);
  }
}

function loadSeedFile(seedPath: string): LoadedConfig {
  const fullPath = resolve(seedPath);
  if (!existsSync(fullPath)) {
    throw new Error(`Seed file not found: ${fullPath}`);
  }

  try {
    const content = readFileSync(fullPath, "utf-8");
    const config = fullPath.endsWith(".json") ? JSON.parse(content) : parseYaml(content);
    return { seedConfig: config, source: seedPath };
  } catch (err) {
    throw new Error(`Failed to parse ${seedPath}: ${err instanceof Error ? err.message : err}`);
  }
}

function normalizeRuntimeSeedConfig(config: EmulateConfig): SeedConfig {
  const seedConfig: SeedConfig = { ...(config.seed ?? {}) };
  if (config.tokens) {
    seedConfig.tokens = config.tokens;
  }
  return seedConfig;
}

function isCodeConfig(file: string): boolean {
  return /\.m?[jt]s$/.test(file);
}
