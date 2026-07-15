import { describe, expect, it } from "vitest";

import { Language } from "../packages/core/src/index.js";

describe("test framework", () => {
  it("runs a hello world smoke test", () => {
    expect(Object.values(Language)).toContain(Language.English);
  });
});
