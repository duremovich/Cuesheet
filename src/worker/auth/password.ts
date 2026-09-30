// Password hashing with PBKDF2-HMAC-SHA256 via WebCrypto (native on Workers and Node).
// Stored format: pbkdf2$<iterations>$<salt b64>$<hash b64>. The prefix and iteration count
// travel with each hash so we can raise the cost or change algorithm later and rehash on
// the next successful login.
import { base64ToBytes, bytesToBase64, timingSafeEqual } from "./bytes";

/** OWASP 2023 minimum for PBKDF2-HMAC-SHA256. */
export const DEFAULT_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;
/** Refuse absurd counts from a corrupted/hostile stored string (CPU exhaustion). */
const MAX_ITERATIONS = 10_000_000;

async function derive(password: string, salt: Uint8Array, iterations: number, bits: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password.normalize("NFKC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const out = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    bits,
  );
  return new Uint8Array(out);
}

export async function hashPassword(
  password: string,
  iterations: number = DEFAULT_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, iterations, KEY_BITS);
  return ["pbkdf2", iterations, bytesToBase64(salt), bytesToBase64(hash)].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const [, iter, saltB64, hashB64] = parts as [string, string, string, string];
  const iterations = Number(iter);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) {
    return false;
  }
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = base64ToBytes(saltB64);
    expected = base64ToBytes(hashB64);
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = await derive(password, salt, iterations, expected.length * 8);
  return timingSafeEqual(actual, expected);
}
