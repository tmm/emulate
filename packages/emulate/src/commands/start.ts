import { createServer, serve, type AppKeyResolver, type Store } from "@emulators/core";
import { SERVICE_REGISTRY, SERVICE_NAMES, type LoadedService, type ServiceEntry, type ServiceName } from "../registry.js";
import pc from "picocolors";
import { ensurePortless, registerAliases, removeAliases, portlessBaseUrl, type PortlessAlias } from "../portless.js";
import { resolveBaseUrl } from "../base-url.js";
import { loadConfig, type EmulateConfig, type EmulateServiceConfig, type SeedConfig } from "../config.js";

declare const PKG_VERSION: string;
const pkg = { version: PKG_VERSION };

export interface StartOptions {
  port: number;
  service?: string;
  config?: string;
  seed?: string;
  baseUrl?: string;
  portless?: boolean;
}

function inferServicesFromConfig(config: SeedConfig): ServiceName[] | null {
  const found = SERVICE_NAMES.filter((k) => k in config);
  return found.length > 0 ? [...found] : null;
}

function fallbackEntry(name: string, plugin: EmulateServiceConfig["plugin"]): ServiceEntry {
  return {
    label: `${name} custom emulator`,
    endpoints: "custom",
    async load() {
      if (!plugin) {
        throw new Error(`Service "${name}" must define a plugin in emulate.config.ts`);
      }
      return { plugin };
    },
    defaultFallback() {
      return { login: "admin", id: 1, scopes: [] };
    },
    initConfig: {},
  };
}

async function loadService(
  name: string,
  entry: ServiceEntry,
  serviceConfig: EmulateServiceConfig | undefined,
): Promise<LoadedService> {
  const builtIn = name in SERVICE_REGISTRY ? await entry.load() : null;
  if (!serviceConfig?.plugin) return builtIn ?? (await entry.load());

  return {
    plugin: serviceConfig.plugin,
    seedFromConfig: serviceConfig.seedFromConfig ?? builtIn?.seedFromConfig,
    createAppKeyResolver: serviceConfig.createAppKeyResolver ?? builtIn?.createAppKeyResolver,
  };
}

function serviceSeedConfig(
  seedConfig: SeedConfig | null,
  runtimeConfig: EmulateConfig | undefined,
  service: string,
): Record<string, unknown> | undefined {
  return runtimeConfig?.services?.[service]?.seed ?? (seedConfig?.[service] as Record<string, unknown> | undefined);
}

export async function startCommand(options: StartOptions): Promise<void> {
  let loaded;
  try {
    loaded = await loadConfig({ configPath: options.config, seedPath: options.seed });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const runtimeConfig = loaded?.runtimeConfig;
  const basePort = runtimeConfig?.port ?? options.port;
  const configBaseUrl = runtimeConfig?.baseUrl;

  if (options.portless && (options.baseUrl || configBaseUrl)) {
    console.error("--portless and --base-url are mutually exclusive.");
    process.exit(1);
  }

  const seedConfig = loaded?.seedConfig ?? null;
  const configSource = loaded?.source ?? null;
  const runtimeServices = runtimeConfig?.services ?? {};

  let services: string[];
  if (options.service) {
    services = options.service.split(",").map((s) => s.trim());
  } else if (Object.keys(runtimeServices).length > 0) {
    services = Object.keys(runtimeServices);
  } else if (seedConfig) {
    services = inferServicesFromConfig(seedConfig) ?? [...SERVICE_NAMES];
  } else {
    services = [...SERVICE_NAMES];
  }

  for (const svc of services) {
    if (!SERVICE_REGISTRY[svc as ServiceName] && !runtimeServices[svc]?.plugin) {
      console.error(`Unknown service: ${svc}`);
      process.exit(1);
    }
  }

  const tokens: Record<string, { login: string; id: number; scopes?: string[] }> = {};
  if (seedConfig?.tokens) {
    let tokenId = 100;
    for (const [token, user] of Object.entries(seedConfig.tokens)) {
      tokens[token] = { login: user.login, id: tokenId++, scopes: user.scopes };
    }
  } else {
    tokens["test_token_admin"] = { login: "admin", id: 2, scopes: ["repo", "user", "admin:org", "admin:repo_hook"] };
  }

  if (options.portless) {
    await ensurePortless();
  }

  interface PreparedService {
    svc: string;
    entry: ServiceEntry;
    serviceConfig: EmulateServiceConfig | undefined;
    loadedSvc: LoadedService;
    svcSeedConfig: Record<string, unknown> | undefined;
    port: number;
    baseUrl: string;
  }

  const portlessAliases: PortlessAlias[] = [];
  const prepared: PreparedService[] = [];

  for (let i = 0; i < services.length; i++) {
    const svc = services[i];
    const serviceConfig = runtimeServices[svc];
    const entry = SERVICE_REGISTRY[svc as ServiceName] ?? fallbackEntry(svc, serviceConfig?.plugin);
    const loadedSvc = await loadService(svc, entry, serviceConfig);

    const svcSeedConfig = serviceSeedConfig(seedConfig, runtimeConfig, svc);
    const port = serviceConfig?.port ?? (svcSeedConfig?.port as number | undefined) ?? basePort + i;

    if (options.portless) {
      portlessAliases.push({ name: `${svc}.emulate`, port });
    }

    const seedBaseUrl =
      typeof serviceConfig?.baseUrl === "string" && serviceConfig.baseUrl.length > 0
        ? serviceConfig.baseUrl
        : typeof svcSeedConfig?.baseUrl === "string" && svcSeedConfig.baseUrl.length > 0
          ? svcSeedConfig.baseUrl
          : undefined;
    const effectiveBaseUrl = options.portless ? portlessBaseUrl(svc) : (options.baseUrl ?? configBaseUrl);
    const baseUrl = resolveBaseUrl({ service: svc, port, baseUrl: effectiveBaseUrl, seedBaseUrl });

    prepared.push({ svc, entry, serviceConfig, loadedSvc, svcSeedConfig, port, baseUrl });
  }

  if (portlessAliases.length > 0) {
    registerAliases(portlessAliases);
  }

  const serviceUrls: Array<{ name: string; url: string }> = [];
  const stores: Store[] = [];
  const httpServers: ReturnType<typeof serve>[] = [];

  for (const { svc, entry, serviceConfig, loadedSvc, svcSeedConfig, port, baseUrl } of prepared) {
    serviceUrls.push({ name: svc, url: baseUrl });

    // eslint-disable-next-line prefer-const -- reassigned after closure captures it
    let cachedResolver: AppKeyResolver | undefined;
    const appKeyResolver: AppKeyResolver | undefined = loadedSvc.createAppKeyResolver
      ? (appId) => cachedResolver!(appId)
      : undefined;

    const fallbackUser = serviceConfig?.defaultFallback?.(svcSeedConfig) ?? entry.defaultFallback(svcSeedConfig);

    const { app, store, webhooks } = createServer(loadedSvc.plugin, {
      port,
      baseUrl,
      tokens,
      appKeyResolver,
      fallbackUser,
    });
    cachedResolver = loadedSvc.createAppKeyResolver?.(store);
    stores.push(store);

    loadedSvc.plugin.seed?.(store, baseUrl);

    if (svcSeedConfig && loadedSvc.seedFromConfig) {
      loadedSvc.seedFromConfig(store, baseUrl, svcSeedConfig, webhooks);
    }

    const httpServer = serve({ fetch: app.fetch, port });
    httpServers.push(httpServer);
  }

  printBanner(serviceUrls, tokens, configSource);

  const shutdown = () => {
    console.log(`\n${pc.dim("Shutting down...")}`);
    if (portlessAliases.length > 0) {
      removeAliases(portlessAliases);
    }
    for (const store of stores) {
      store.reset();
    }
    for (const srv of httpServers) {
      srv.close();
    }
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function printBanner(
  services: Array<{ name: string; url: string }>,
  tokens: Record<string, { login: string; id: number; scopes?: string[] }>,
  configSource: string | null,
): void {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  ${pc.bold("emulate")} ${pc.dim(`v${pkg.version}`)}`);
  lines.push("");

  const maxNameLen = Math.max(...services.map((s) => s.name.length));
  for (const { name, url } of services) {
    lines.push(`  ${pc.cyan(name.padEnd(maxNameLen + 2))}${pc.bold(url)}`);
  }
  lines.push("");

  const tokenEntries = Object.entries(tokens);
  if (tokenEntries.length > 0) {
    lines.push(`  ${pc.dim("Tokens")}`);
    for (const [token, user] of tokenEntries) {
      lines.push(`  ${pc.dim(token)} ${pc.dim("->")} ${user.login}`);
    }
    lines.push("");
  }

  if (configSource) {
    lines.push(`  ${pc.dim("Config:")} ${configSource}`);
  } else {
    lines.push(`  ${pc.dim("Config:")} defaults ${pc.dim("(run")} npx emulate init ${pc.dim("to customize)")}`);
  }
  lines.push("");

  console.log(lines.join("\n"));
}
