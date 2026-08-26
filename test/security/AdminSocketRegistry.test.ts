import assert from "assert";
import { describe, it } from "node:test";
import { AdminSocketRegistry } from "../../src/api/AdminSocketRegistry";
import { AuthPrincipal } from "../../src/infrastructure/security/SessionTokenService";

/** Minimal stand-in for a ws WebSocket. */
function fakeSocket(readyState = 1) {
  const received: string[] = [];
  return {
    readyState,
    received,
    send(payload: string) {
      received.push(payload);
    },
  };
}

const principal = (role: string): AuthPrincipal => ({
  kind: "operator",
  subject: "op",
  role,
  orgId: role === "super_admin" ? null : "org_default",
  projectIds: null,
});

describe("AdminSocketRegistry.broadcastToProject", () => {
  it("WS-003: an event for one project does not reach another project's socket", () => {
    const registry = new AdminSocketRegistry();
    const projectOne = fakeSocket();
    const projectExcise = fakeSocket();

    registry.add(projectOne, { principal: principal("admin"), projectIds: [1, 2, 8] });
    registry.add(projectExcise, { principal: principal("admin"), projectIds: [101] });

    const delivered = registry.broadcastToProject(101, "excise-event");

    assert.strictEqual(delivered, 1);
    assert.deepStrictEqual(projectExcise.received, ["excise-event"]);
    assert.deepStrictEqual(projectOne.received, [], "must not leak across projects");
  });

  it("delivers to unrestricted sockets regardless of project", () => {
    const registry = new AdminSocketRegistry();
    const superAdmin = fakeSocket();
    const scoped = fakeSocket();

    registry.add(superAdmin, { principal: principal("super_admin"), projectIds: null });
    registry.add(scoped, { principal: principal("admin"), projectIds: [1] });

    assert.strictEqual(registry.broadcastToProject(101, "e"), 1);
    assert.deepStrictEqual(superAdmin.received, ["e"]);
    assert.deepStrictEqual(scoped.received, []);
  });

  it("withholds an event with no resolvable project from scoped sockets", () => {
    // The old code broadcast to everyone. An event whose project cannot be
    // determined must not be treated as "send to all".
    const registry = new AdminSocketRegistry();
    const scoped = fakeSocket();
    const superAdmin = fakeSocket();
    registry.add(scoped, { principal: principal("admin"), projectIds: [1] });
    registry.add(superAdmin, { principal: principal("super_admin"), projectIds: null });

    for (const missing of [null, undefined, "", "not-a-number"]) {
      registry.broadcastToProject(missing as any, "orphan");
    }

    assert.deepStrictEqual(scoped.received, []);
    assert.strictEqual(superAdmin.received.length, 4);
  });

  it("skips sockets that are not open", () => {
    const registry = new AdminSocketRegistry();
    const closing = fakeSocket(2);
    registry.add(closing, { principal: principal("admin"), projectIds: [1] });
    assert.strictEqual(registry.broadcastToProject(1, "e"), 0);
    assert.deepStrictEqual(closing.received, []);
  });

  it("one failing socket does not stop delivery to the rest", () => {
    const registry = new AdminSocketRegistry();
    const broken: any = { readyState: 1, send() { throw new Error("EPIPE"); } };
    const healthy = fakeSocket();
    registry.add(broken, { principal: principal("admin"), projectIds: [1] });
    registry.add(healthy, { principal: principal("admin"), projectIds: [1] });

    assert.strictEqual(registry.broadcastToProject(1, "e"), 1);
    assert.deepStrictEqual(healthy.received, ["e"]);
  });

  it("stops delivering once a socket is removed", () => {
    const registry = new AdminSocketRegistry();
    const socket = fakeSocket();
    registry.add(socket, { principal: principal("admin"), projectIds: [1] });
    registry.remove(socket);
    assert.strictEqual(registry.size, 0);
    assert.strictEqual(registry.broadcastToProject(1, "e"), 0);
  });

  it("matches project ids supplied as strings", () => {
    const registry = new AdminSocketRegistry();
    const socket = fakeSocket();
    registry.add(socket, { principal: principal("admin"), projectIds: [8] });
    assert.strictEqual(registry.broadcastToProject("8", "e"), 1);
  });
});
