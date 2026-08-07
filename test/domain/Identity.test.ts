import assert from "assert";
import { describe, it } from "node:test";
import { Identity } from "../../src/domain/entities/Identity";

describe("Identity Aggregate Root Unit Tests", () => {
  it("should initialize unverified guest by default", () => {
    const identity = new Identity({
      id: "ident-001",
      profileId: "prof-001",
      channel: "line",
      channelRef: "U123456789",
    });

    assert.strictEqual(identity.verificationStatus, "UNVERIFIED_GUEST");
    assert.strictEqual(identity.isVerified, false);
  });

  it("should transition status to VERIFIED_CUSTOMER upon verifyCustomer()", () => {
    const identity = new Identity({
      id: "ident-002",
      profileId: "prof-002",
      channel: "line",
      channelRef: "U987654321",
    });

    identity.verifyCustomer();
    assert.strictEqual(identity.verificationStatus, "VERIFIED_CUSTOMER");
    assert.strictEqual(identity.isVerified, true);
  });
});
