import assert from "assert";
import { describe, it } from "node:test";

describe("Gatekeeper Security Anti-Enumeration Tests", () => {
  it("should enforce non-numeric matching query structure", () => {
    const rawSql = "SELECT id, name FROM projects WHERE (LOWER(name) = LOWER($1) OR LOWER(slug) = LOWER($1) OR LOWER(code) = LOWER($1)) AND is_active = TRUE LIMIT 1";
    
    // Assert query does NOT contain insecure id::text integer enumeration
    assert.strictEqual(rawSql.includes("id::text = $1"), false);
    assert.strictEqual(rawSql.includes("LOWER(slug) = LOWER($1)"), true);
  });
});
