import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveRuntimeDatabaseUrl, describeDatabaseUrl } from "./prisma.js";

describe("describeDatabaseUrl", () => {
  it("never includes credentials or the api key", () => {
    const pooled = describeDatabaseUrl("prisma+postgres://accelerate.example.net/?api_key=SECRETKEY");
    assert.equal(pooled, "pooled (prisma+postgres://accelerate.example.net)");
    const direct = describeDatabaseUrl("postgres://user:SECRETPW@db.example.com:5432/postgres?connection_limit=2");
    assert.equal(direct, "direct (postgres://db.example.com:5432, connection_limit=2)");
    assert.ok(!/SECRET|user/.test(pooled + direct));
  });
});

const DIRECT = "postgres://user:pw@db.example.com:5432/postgres?sslmode=require";

describe("resolveRuntimeDatabaseUrl", () => {
  it("prefers the pooled APP_PRISMA_DATABASE_URL when set", () => {
    const pooled = "prisma+postgres://accelerate.example.net/?api_key=k";
    assert.equal(resolveRuntimeDatabaseUrl({ APP_PRISMA_DATABASE_URL: pooled, APP_DATABASE_URL: DIRECT }), pooled);
  });

  it("still caps APP_PRISMA_DATABASE_URL when it is a plain postgres:// address", () => {
    const url = new URL(resolveRuntimeDatabaseUrl({ APP_PRISMA_DATABASE_URL: DIRECT, VERCEL: "1" })!);
    assert.equal(url.host, "db.example.com:5432");
    assert.equal(url.searchParams.get("connection_limit"), "2");
  });

  it("caps a direct URL at 5 connections locally and 2 on Vercel, keeping other params", () => {
    const local = new URL(resolveRuntimeDatabaseUrl({ APP_DATABASE_URL: DIRECT })!);
    assert.equal(local.searchParams.get("connection_limit"), "5");
    assert.equal(local.searchParams.get("sslmode"), "require");
    const vercel = new URL(resolveRuntimeDatabaseUrl({ APP_DATABASE_URL: DIRECT, VERCEL: "1" })!);
    assert.equal(vercel.searchParams.get("connection_limit"), "2");
  });

  it("respects DB_CONNECTION_LIMIT and a limit already in the URL", () => {
    const custom = new URL(resolveRuntimeDatabaseUrl({ APP_DATABASE_URL: DIRECT, DB_CONNECTION_LIMIT: "3" })!);
    assert.equal(custom.searchParams.get("connection_limit"), "3");
    const preset = `${DIRECT}&connection_limit=9`;
    assert.equal(new URL(resolveRuntimeDatabaseUrl({ APP_DATABASE_URL: preset })!).searchParams.get("connection_limit"), "9");
  });

  it("returns undefined without any database URL (Prisma then uses schema.prisma's env)", () => {
    assert.equal(resolveRuntimeDatabaseUrl({}), undefined);
  });
});
