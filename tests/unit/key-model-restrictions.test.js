// Fork feature: per-API-key model restrictions — pruning matcher.
// Semantics: exact model ids only (no implicit provider-prefix matching) so a
// pattern can never grant access through a provider it was not written for.
// A trailing "*" is an explicit opt-in glob.
import { describe, it, expect } from "vitest";
import { modelMatchesPattern, modelAllowed } from "@/lib/db/repos/keyModelRestrictionsRepo.js";

describe("key model restriction patterns", () => {
  it("matches an exact model id", () => {
    expect(modelMatchesPattern("sm/gpt-4.1-nano", "sm/gpt-4.1-nano")).toBe(true);
    expect(modelMatchesPattern("sm/gpt-4.1-nano", "sm/gpt-4.1-mini")).toBe(false);
  });

  it("does NOT match the same model served through another alias", () => {
    // restricting to sm/... must not silently allow trx/...
    expect(modelMatchesPattern("sm/gpt-4.1-nano", "trx/gpt-4.1-nano")).toBe(false);
    expect(modelMatchesPattern("gpt-4.1-nano", "sm/gpt-4.1-nano")).toBe(false);
  });

  it("supports an explicit trailing-star glob", () => {
    expect(modelMatchesPattern("sm/gpt-4.1-*", "sm/gpt-4.1-nano")).toBe(true);
    expect(modelMatchesPattern("sm/gpt-4.1-*", "sm/gpt-4.1-mini")).toBe(true);
    expect(modelMatchesPattern("sm/gpt-4.1-*", "sm/gpt-4.2-nano")).toBe(false);
    expect(modelMatchesPattern("om/claude-sonnet-*", "om/claude-sonnet-4.5")).toBe(true);
    expect(modelMatchesPattern("om/claude-sonnet-*", "sm/claude-sonnet-4.5")).toBe(false);
  });

  it("treats an empty pattern list as unrestricted", () => {
    expect(modelAllowed([], "anything/at-all")).toBe(true);
    expect(modelAllowed(null, "anything/at-all")).toBe(true);
  });

  it("requires at least one pattern to match when restricted", () => {
    const patterns = ["sm/gpt-4.1-*", "om/claude-opus-4.7"];
    expect(modelAllowed(patterns, "sm/gpt-4.1-nano")).toBe(true);
    expect(modelAllowed(patterns, "om/claude-opus-4.7")).toBe(true);
    expect(modelAllowed(patterns, "zm/google/gemini-3.8-flash")).toBe(false);
  });
});
