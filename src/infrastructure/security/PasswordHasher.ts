import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "crypto";
import { promisify } from "util";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number
) => Promise<Buffer>;

/**
 * scrypt password hashing on node:crypto — no new dependency.
 *
 * Stored format: scrypt$N$<salt-hex>$<hash-hex>
 * The version prefix lets the parameters change later without invalidating
 * existing hashes.
 */

const KEYLEN = 64;
const PREFIX = "scrypt$1";

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN);
  return `${PREFIX}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/**
 * Constant-time verification. Returns false for any malformed or
 * unrecognised stored value rather than throwing, so a bad row in the
 * database cannot turn into a 500 on the login path.
 */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;

  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;

  const salt = Buffer.from(parts[2], "hex");
  const expected = Buffer.from(parts[3], "hex");
  if (salt.length === 0 || expected.length !== KEYLEN) return false;

  let actual: Buffer;
  try {
    actual = await scrypt(password, salt, KEYLEN);
  } catch {
    return false;
  }

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
