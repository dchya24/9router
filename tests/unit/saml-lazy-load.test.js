import { afterEach, describe, expect, it, vi } from "vitest";

const samlModuleLoad = vi.hoisted(() => vi.fn());

vi.mock("@node-saml/node-saml", () => {
  samlModuleLoad();
  return {
    SAML: class {
      generateServiceProviderMetadata() {
        return "<EntityDescriptor />";
      }
    },
  };
});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("lazy SAML dependency", () => {
  it("does not load the SAML package for configuration checks", async () => {
    const saml = await import("../../src/lib/auth/saml.js");

    expect(saml.isSamlConfigured({})).toBe(false);
    expect(samlModuleLoad).not.toHaveBeenCalled();
  });

  it("loads the SAML package when metadata generation is requested", async () => {
    const saml = await import("../../src/lib/auth/saml.js");

    await expect(saml.generateSamlMetadata("https://example.com", {})).resolves.toBe("<EntityDescriptor />");
    expect(samlModuleLoad).toHaveBeenCalledTimes(1);
  });
});
