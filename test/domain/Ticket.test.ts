import assert from "assert";
import { describe, it } from "node:test";
import { Ticket } from "../../src/domain/entities/Ticket";

describe("Ticket Aggregate Root Invariant Unit Tests", () => {
  it("should throw error if cancellation reason is less than 10 characters", () => {
    const ticket = new Ticket({
      id: 1,
      ticketId: "TCK-2026-0001",
      conversationId: 10,
      subject: "Test Issue for Invariant Check",
      createdByType: "CUSTOMER",
    });

    assert.throws(
      () => {
        ticket.cancelTicket("Short");
      },
      (err: Error) => {
        return err.message.includes("at least 10 characters");
      }
    );
  });

  it("should successfully cancel ticket when valid reason >= 10 characters is provided", () => {
    const ticket = new Ticket({
      id: 2,
      ticketId: "TCK-2026-0002",
      conversationId: 11,
      subject: "Valid Cancellation Test Issue",
      createdByType: "CUSTOMER",
    });

    ticket.cancelTicket("Duplicate ticket submitted by customer");
    assert.strictEqual(ticket.status, "cancelled");
    assert.strictEqual(ticket.cancellationReason, "Duplicate ticket submitted by customer");
  });

  it("should successfully restore cancelled ticket to open status", () => {
    const ticket = new Ticket({
      id: 3,
      ticketId: "TCK-2026-0003",
      conversationId: 12,
      subject: "Ticket Restoration Test Issue",
      createdByType: "CUSTOMER",
      status: "cancelled",
      cancellationReason: "Accidentally closed by operator",
    });

    ticket.restore();
    assert.strictEqual(ticket.status, "open");
    assert.strictEqual(ticket.cancellationReason, undefined);
  });
});
