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
    // Lifecycle vocabulary since migration 040; "cancelled" would now
    // violate tickets_status_lifecycle_check.
    assert.strictEqual(ticket.status, "CANCELLED");
    assert.strictEqual(ticket.cancellationReason, "Duplicate ticket submitted by customer");
  });

  it("should successfully restore cancelled ticket to REOPENED", () => {
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
    // restore() is a REOPENED transition, not a return to "open".
    assert.strictEqual(ticket.status, "REOPENED");
    assert.strictEqual(ticket.cancellationReason, undefined);
  });
});
