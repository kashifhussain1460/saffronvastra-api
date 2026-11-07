// Facebook Page token diagnostic. Validates FACEBOOK_PAGE_ACCESS_TOKEN against the configured Page
// WITHOUT printing the token. No post is published.
//   npx tsx scripts/check-facebook.ts
import { env } from "../src/config/env.js";
import { sanitizeToken, describeTokenHygiene, detectFlow, graphVersion } from "../src/modules/social/providers/meta.util.js";

interface GraphError { error?: { message?: string; code?: number; error_subcode?: number }; }

async function graphGet(url: string, token: string) {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const text = await res.text();
    let body: unknown;
    try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
    if (!res.ok) {
      const e = (body as GraphError | undefined)?.error;
      return { ok: false, status: res.status, error: e?.message ?? text.slice(0, 200), code: e?.code };
    }
    return { ok: true, status: res.status, body: body as Record<string, unknown> };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  const raw = env.FACEBOOK_PAGE_ACCESS_TOKEN;
  const pageId = env.FACEBOOK_PAGE_ID;
  const token = sanitizeToken(raw);
  const host = "https://graph.facebook.com";
  const v = graphVersion();

  console.log("=== Facebook Page token diagnostic ===");
  console.log(JSON.stringify({
    tokenPresent: token.length > 0,
    tokenLength: token.length,
    tokenPrefix: token.slice(0, 4) || null,
    detectedFlow: detectFlow(token),
    graphVersion: v,
    pageIdConfigured: pageId ?? null,
    hygieneIssues: describeTokenHygiene(raw),
  }, null, 2));

  if (!token) { console.error("\n✗ FACEBOOK_PAGE_ACCESS_TOKEN is missing."); process.exit(1); }

  const me = await graphGet(`${host}/${v}/me?fields=id,name`, token);
  console.log("\nIdentity (/me):");
  console.log(JSON.stringify(me, null, 2));
  if (!me.ok) { console.error("\n✗ Token rejected (invalid/expired). Regenerate a Page access token."); process.exit(1); }

  if (pageId) {
    const page = await graphGet(`${host}/${v}/${pageId}?fields=name,access_token,instagram_business_account{id,username}`, token);
    console.log(`\nConfigured Page ${pageId}:`);
    const safe = page.ok ? { ...page, body: { ...page.body, access_token: page.body?.access_token ? "<present>" : undefined } } : page;
    console.log(JSON.stringify(safe, null, 2));
    if (page.ok) {
      console.log(`\n✓ Token can read Page "${page.body?.name ?? "?"}". Facebook photo publishing should work.`);
      const ig = (page.body as any)?.instagram_business_account;
      if (ig?.id) console.log(`  (Linked IG Business account: @${ig.username ?? "?"} id ${ig.id})`);
    } else {
      console.error(`\n✗ Token authenticates but cannot read Page ${pageId} (code ${(page as any).code}).`);
      console.error("  Needs a PAGE access token with pages_read_engagement, pages_manage_posts (and pages_show_list).");
      console.error("  A System User must have the Page assigned as an asset in Business Settings.");
      process.exit(1);
    }
  }

  console.log("\nDiagnosis complete. No post was published.");
  process.exit(0);
}

void main();
