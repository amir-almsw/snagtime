import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentDatabaseContext, databaseContext, enterDatabaseAction, enterDatabaseContext, updateDatabaseContext } from "@/server/db-context";

// The proxy in db.ts wraps every model call in databaseContext.run(), so any context refined after
// an await resumes inside that child scope. These tests pin the behaviour that made every
// workspace-scoped route read an empty tenant: enterWith is discarded when a function returns, so a
// refinement has to mutate the stored object instead of replacing it.
beforeEach(() => { vi.stubEnv("DATABASE_PROVIDER", "postgresql"); vi.stubEnv("NODE_ENV", "production"); });
afterEach(() => { vi.unstubAllEnvs(); });

async function proxiedCall<T>(value: T) {
  const stored = currentDatabaseContext();
  return databaseContext.run({ ...stored!, transaction: {} }, async () => value);
}

describe("database context propagation", () => {
  it("keeps a post-await refinement visible to the caller that awaited it", async () => {
    async function loadSession() {
      enterDatabaseContext({ mode: "session", userId: "usr_1", sessionHash: "hash_1", subject: "usr_1" });
      const record = await proxiedCall({ activeWorkspaceId: "ws_1", role: "OWNER" });
      updateDatabaseContext({ mode: "workspace", workspaceId: record.activeWorkspaceId, subject: record.role, action: "workspace_read" });
      return record;
    }
    async function route() {
      await loadSession();
      enterDatabaseAction("event_write");
      return currentDatabaseContext();
    }
    expect(await route()).toMatchObject({ mode: "workspace", workspaceId: "ws_1", userId: "usr_1", action: "event_write" });
  });

  it("never leaves a workspace write with an empty workspace id", async () => {
    async function loadSession() {
      enterDatabaseContext({ mode: "session", userId: "usr_1", sessionHash: "hash_1", subject: "usr_1" });
      await proxiedCall(null);
      updateDatabaseContext({ mode: "workspace", workspaceId: "ws_1" });
    }
    await loadSession();
    expect(currentDatabaseContext()?.workspaceId).toBe("ws_1");
  });

  it("isolates concurrent requests from each other", async () => {
    async function request(id: string) {
      enterDatabaseContext({ mode: "session", userId: `usr_${id}`, subject: `usr_${id}` });
      await proxiedCall(null);
      updateDatabaseContext({ mode: "workspace", workspaceId: `ws_${id}` });
      await new Promise((resolve) => setTimeout(resolve, 5));
      return currentDatabaseContext();
    }
    const [left, right] = await Promise.all([request("a"), request("b")]);
    expect([left?.workspaceId, right?.workspaceId]).toEqual(["ws_a", "ws_b"]);
  });

  it("does nothing outside the production PostgreSQL topology", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await databaseContext.run(undefined as never, async () => {
      enterDatabaseContext({ mode: "session", userId: "usr_1" });
      updateDatabaseContext({ mode: "workspace", workspaceId: "ws_1" });
      expect(currentDatabaseContext()).toBeUndefined();
    });
  });
});
