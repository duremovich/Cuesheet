// Password hashing with scrypt (@noble/hashes: pure JS, runs on Workers and Node).
// Stored format: scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>, so parameters can change later
// without invalidating existing hashes.
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { base64ToBytes, bytesToBase64, timingSafeEqual } from "./bytes";

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** OWASP minimum for scrypt. ~16 MiB memory; tens of ms of CPU per hash on Workers. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 14, r: 8, p: 1 };
const KEY_LEN = 32;

export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await scryptAsync(password.normalize("NFKC"), salt, { ...params, dkLen: KEY_LEN });
  return ["scrypt", params.N, params.r, params.p, bytesToBase64(salt), bytesToBase64(hash)].join(
    "$",
  );
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  if (![N, R, P].every((x) => Number.isInteger(x) && x > 0)) return false;
  const expected = base64ToBytes(hashB64);
  const actual = await scryptAsync(password.normalize("NFKC"), base64ToBytes(saltB64), {
    N,
    r: R,
    p: P,
    dkLen: expected.length,
  });
  return timingSafeEqual(actual, expected);
}
