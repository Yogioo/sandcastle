import { describe, expect, it } from "vitest";
import { listSandboxProviders, getSandboxProvider } from "./InitService.js";

describe("Sandbox provider registry", () => {
  it("listSandboxProviders returns docker, podman, and no-sandbox", () => {
    const providers = listSandboxProviders();
    expect(providers.some((p) => p.name === "docker")).toBe(true);
    expect(providers.some((p) => p.name === "podman")).toBe(true);
    expect(providers.some((p) => p.name === "no-sandbox")).toBe(true);
  });

  it("getSandboxProvider returns docker entry", () => {
    const provider = getSandboxProvider("docker");
    expect(provider).toBeDefined();
    expect(provider!.containerfileName).toBe("Dockerfile");
    expect(provider!.cliNamespace).toBe("docker");
  });

  it("getSandboxProvider returns podman entry", () => {
    const provider = getSandboxProvider("podman");
    expect(provider).toBeDefined();
    expect(provider!.containerfileName).toBe("Containerfile");
    expect(provider!.cliNamespace).toBe("podman");
  });

  it("getSandboxProvider returns a host-only no-sandbox entry", () => {
    const provider = getSandboxProvider("no-sandbox");
    expect(provider).toBeDefined();
    expect(provider!.factoryName).toBe("noSandbox");
    expect(provider!.importSubpath).toBe("no-sandbox");
    expect(provider!.containerfileName).toBeNull();
    expect(provider!.cliNamespace).toBeNull();
  });

  it("getSandboxProvider returns undefined for unknown provider", () => {
    expect(getSandboxProvider("nonexistent")).toBeUndefined();
  });
});
