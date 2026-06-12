import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

describe("loadConfig", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("loads an emulate.config.ts file with a custom plugin", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "emulate-config-"));
    const configPath = join(tempDir, "emulate.config.ts");
    writeFileSync(
      configPath,
      `
        export default {
          port: 14100,
          tokens: { test_token: { login: 'tester', scopes: ['read'] } },
          services: {
            custom: {
              port: 14101,
              seed: { message: 'hello' },
              plugin: {
                name: 'custom',
                register(app) {
                  app.get('/ping', (c) => c.json({ ok: true }))
                },
              },
            },
          },
        }
      `,
      "utf-8",
    );

    const loaded = await loadConfig({ configPath });

    expect(loaded?.runtimeConfig?.port).toBe(14100);
    expect(loaded?.runtimeConfig?.services?.custom?.port).toBe(14101);
    expect(loaded?.runtimeConfig?.services?.custom?.plugin?.name).toBe("custom");
    expect(loaded?.seedConfig.tokens?.test_token.login).toBe("tester");
  });
});
