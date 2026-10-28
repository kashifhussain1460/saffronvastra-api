import { hash, verify } from "@node-rs/argon2";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export async function hashPassword(plainText: string): Promise<string> {
  return hash(plainText, {
    memoryCost: 19456, // 19 MiB
    timeCost: 2,
    outputLen: 32,
    parallelism: 1,
  });
}

export async function verifyPassword(passwordHash: string, plainText: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plainText);
  } catch {
    return false;
  }
}

export function generateOpaqueToken(numBytes = 32): string {
  return randomBytes(numBytes).toString("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateUUID(): string {
  return randomUUID();
}
