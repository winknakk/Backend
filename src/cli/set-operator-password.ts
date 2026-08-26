/**
 * Sets or rotates an operator's console password.
 *
 *   npx tsx src/cli/set-operator-password.ts <email> [password]
 *
 * With no password argument a strong one is generated and printed once.
 * The plaintext is never stored or logged anywhere else.
 */
import { randomBytes } from "crypto";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { hashPassword } from "../infrastructure/security/PasswordHasher";

async function main() {
  const [email, providedPassword] = process.argv.slice(2);

  if (!email) {
    console.error("Usage: npx tsx src/cli/set-operator-password.ts <email> [password]");
    process.exit(1);
  }

  const operator = await pool.query(
    `SELECT id, email, role, is_active FROM operators
      WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL LIMIT 1`,
    [email]
  );

  if (operator.rows.length === 0) {
    console.error(`No operator found with email ${email}`);
    process.exit(1);
  }

  const password = providedPassword || randomBytes(18).toString("base64url");
  if (password.length < 12) {
    console.error("Password must be at least 12 characters");
    process.exit(1);
  }

  const hash = await hashPassword(password);
  await pool.query(`UPDATE operators SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [
    hash,
    operator.rows[0].id,
  ]);

  const row = operator.rows[0];
  console.log(`Password set for ${row.email} (id=${row.id}, role=${row.role}, active=${row.is_active})`);
  if (!providedPassword) {
    console.log(`Generated password (shown once): ${password}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
