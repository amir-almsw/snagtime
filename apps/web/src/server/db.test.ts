import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { contextualModelNames } from "@/server/db";

// The production proxy only installs the signed tenant context for delegates it knows by name. SQLite never
// goes through the proxy, so a model left off the list passes every local test and then, in production,
// reads as empty and refuses every write under row-level security.
describe("production database proxy", () => {
  it("signs a tenant context for every model Prisma defines", () => {
    const delegates = Object.values(Prisma.ModelName).map((model) => `${model.charAt(0).toLowerCase()}${model.slice(1)}`);
    expect(delegates.filter((delegate) => !contextualModelNames.has(delegate))).toEqual([]);
  });
});
