import { PrismaClient } from "@prisma/client";
// Loads backend/.env (dotenv) before the URL is resolved below, whatever order the modules are imported in.
import "../config/env.js";

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

// Which address the running API connects with. Migrations keep using APP_DATABASE_URL (schema.prisma) because they need
// a direct connection; the API itself should not, because on Prisma Postgres direct connections are few and every
// serverless instance opens its own pool ("too many connections for role ..." on login).
//  1. APP_PRISMA_DATABASE_URL (prisma+postgres://, added by the Prisma Postgres integration) goes through Prisma's
//     connection pooler, so instances share pooled connections. Preferred whenever it is set.
//  2. Otherwise the direct APP_DATABASE_URL, with a small connection_limit unless the URL already sets one. Prisma's
//     default is (CPU cores x 2 + 1) per process, which on a dev machine alone can use up a hosted database's limit.
export function resolveRuntimeDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pooled = env.APP_PRISMA_DATABASE_URL?.trim();
  if (pooled) return pooled;

  const direct = env.APP_DATABASE_URL?.trim();
  if (!direct) return undefined;
  try {
    const url = new URL(direct);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return direct;
    if (!url.searchParams.has("connection_limit")) {
      const limit = Number(env.DB_CONNECTION_LIMIT) > 0 ? String(Number(env.DB_CONNECTION_LIMIT)) : env.VERCEL ? "2" : "5";
      url.searchParams.set("connection_limit", limit);
    }
    return url.toString();
  } catch {
    return direct;
  }
}

export const prisma =
  global.__prisma ||
  new PrismaClient({
    datasourceUrl: resolveRuntimeDatabaseUrl(),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  global.__prisma = prisma;
}
