// Instagram/Meta token diagnostic. Validates the configured access token against the correct Graph API
// host WITHOUT ever printing the token. No post is published.
//   npx tsx scripts/check-instagram.ts
import { env } from "../src/config/env.js";
import {
  sanitizeToken,
  describeTokenHygiene,
  detectFlow,
  graphVersion,
} from "../src/modules/social/providers/meta.util.js";

interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number; fbtrace_id?: string };
}

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

/** Identity probe using only non-deprecated fields per host. */
async function probe(host: string, token: string, label: string) {
  const version = graphVersion();
  // `username` is valid on graph.instagram.com; graph.facebook.com uses `name`.
  const fields = host.includes('graph.instagram.com') ? 'id,username' : 'id,name';
  const r = await graphGet(`${host}/${version}/me?fields=${fields}`, token);
  if (!r.ok) return { host: label, ...r };
  return { host: label, ok: true, status: r.status, id: r.body?.id, name: r.body?.username ?? r.body?.name };
}

async function main() {
  const raw = env.INSTAGRAM_ACCESS_TOKEN;
  const accountId = env.INSTAGRAM_ACCOUNT_ID;
  const token = sanitizeToken(raw);

  const hygiene = describeTokenHygiene(raw);
  const flow = detectFlow(token);

  console.log("=== Instagram token diagnostic ===");
  console.log(JSON.stringify({
    tokenPresent: token.length > 0,
    tokenLength: token.length,
    tokenPrefix: token.slice(0, 4) || null, // IGAA / EAA — not secret
    detectedFlow: flow,
    graphVersion: graphVersion(),
    accountIdConfigured: accountId ?? null,
    hygieneIssues: hygiene,
  }, null, 2));

  if (!token) {
    console.error("\n✗ INSTAGRAM_ACCESS_TOKEN is missing. Set it in the environment and retry.");
    process.exit(1);
  }

  // Probe both hosts so a mismatch is obvious; the one matching the token prefix is expected to pass.
  const ig = await probe("https://graph.instagram.com", token, "graph.instagram.com (Instagram Login)");
  const fb = await probe("https://graph.facebook.com", token, "graph.facebook.com (Facebook Login)");
  console.log("\nIdentity probes:");
  console.log(JSON.stringify([ig, fb], null, 2));

  const working = ig.ok ? ig : fb.ok ? fb : null;
  if (!working) {
    console.error("\n✗ Token rejected by BOTH hosts. It is invalid/expired or malformed.");
    console.error("  code 190 = 'Cannot parse access token' → regenerate the token in the Meta dashboard.");
    console.error(`  Detected flow from prefix: ${flow}. For Instagram Login generate an IGAA… token; for Facebook Login a Page token (EAA…).`);
    process.exit(1);
  }

  console.log(`\n✓ Token accepted by ${working.host} as "${working.name ?? "?"}" (id ${working.id ?? "?"}).`);

  // Publish-readiness: can this token actually see the IG Business account node?
  if (accountId) {
    const host = ig.ok ? "https://graph.instagram.com" : "https://graph.facebook.com";
    const igNode = await graphGet(`${host}/${graphVersion()}/${accountId}?fields=username`, token);
    console.log("\nIG Business account access:");
    console.log(JSON.stringify(igNode, null, 2));
    if (igNode.ok) {
      console.log(`\n✓ Token can access IG Business account @${(igNode.body as any)?.username ?? "?"} — publishing should work.`);
    } else {
      console.error(`\n✗ Token authenticates but CANNOT access IG Business account ${accountId} directly (code ${(igNode as any).code}).`);

      // Facebook-Login flow: resolve the IG Business account THROUGH the linked Page.
      const host = "https://graph.facebook.com";
      const pages = await graphGet(`${host}/${graphVersion()}/me/accounts?fields=id,name,instagram_business_account{id,username}`, token);
      console.log("\nPages this token can manage (and their linked IG account):");
      console.log(JSON.stringify(pages, null, 2));
      if (pages.ok && Array.isArray((pages.body as any)?.data) && (pages.body as any).data.length === 0) {
        console.error("\n⚠ This token manages ZERO Pages (no Page/IG assets assigned to it).");
        console.error("  RECOMMENDED: your dashboard uses 'Instagram API with Instagram Login (Unified Login)'.");
        console.error("  Generate an Instagram User token (prefix IGAA…) via that flow with scopes");
        console.error("  instagram_business_basic + instagram_business_content_publish, and set it as INSTAGRAM_ACCESS_TOKEN.");
        console.error(`  Keep INSTAGRAM_ACCOUNT_ID=${accountId} (correct for the Instagram Login flow).`);
      }

      const pageId = env.FACEBOOK_PAGE_ID;
      if (pageId) {
        const page = await graphGet(`${host}/${graphVersion()}/${pageId}?fields=name,instagram_business_account{id,username}`, token);
        console.log(`\nConfigured Page ${pageId}:`);
        console.log(JSON.stringify(page, null, 2));
        const linkedId = (page.body as any)?.instagram_business_account?.id;
        if (page.ok && linkedId) {
          console.log(`\n➜ The Page's linked IG Business account id is ${linkedId}.`);
          if (linkedId !== accountId) {
            console.error(`  ✗ This does NOT match INSTAGRAM_ACCOUNT_ID (${accountId}).`);
            console.error(`  FIX: set INSTAGRAM_ACCOUNT_ID=${linkedId} in the backend env.`);
          } else {
            console.error("  The id matches, so the token is missing instagram_content_publish / instagram_basic permissions,");
            console.error("  or the IG asset is not assigned to this System User in Business settings.");
          }
        }
      }
      console.error("\nRequired for Facebook-Login publishing: a Page access token (or System User with the Page+IG assets assigned)");
      console.error("holding instagram_content_publish, instagram_basic, pages_show_list, pages_read_engagement.");
      process.exit(1);
    }
  }

  console.log("\nDiagnosis complete. No post was published.");
  process.exit(0);
}

void main();
