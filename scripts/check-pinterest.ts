// Pinterest diagnostic. Resolves an access token the same way the adapter does — directly from
// PINTEREST_ACCESS_TOKEN if set, otherwise minted from PINTEREST_APP_ID + PINTEREST_APP_SECRET +
// PINTEREST_REFRESH_TOKEN — then validates the user account and the configured board.
// Never prints any token. No pin is created.
//   npx tsx scripts/check-pinterest.ts
import { env } from "../src/config/env.js";
import { sanitizeToken, describeTokenHygiene } from "../src/modules/social/providers/meta.util.js";
import { getPinterestAccessToken, DIRECT_TOKEN_PREFIX } from "../src/modules/social/providers/pinterest-oauth.js";

interface PinterestError { code?: number; message?: string; }

async function apiGet(url: string, token: string) {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const text = await res.text();
    let body: unknown;
    try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
    if (!res.ok) {
      const e = body as PinterestError | undefined;
      return { ok: false, status: res.status, error: e?.message ?? text.slice(0, 200), code: e?.code };
    }
    return { ok: true, status: res.status, body: body as Record<string, unknown> };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  const directToken = sanitizeToken(env.PINTEREST_ACCESS_TOKEN);
  const rawRefresh = env.PINTEREST_REFRESH_TOKEN;
  const refresh = sanitizeToken(rawRefresh);
  const boardId = env.PINTEREST_BOARD_ID;
  const host = (env.PINTEREST_API_BASE?.trim() || "https://api.pinterest.com").replace(/\/+$/, "");
  const base = `${host}/v5`;
  const mode = directToken ? "direct access token" : "refresh-token flow";

  console.log("=== Pinterest diagnostic ===");
  console.log(JSON.stringify({
    mode,
    directAccessTokenPresent: directToken.length > 0,
    directAccessTokenLength: directToken.length || null,
    directAccessTokenHygiene: directToken ? describeTokenHygiene(env.PINTEREST_ACCESS_TOKEN) : undefined,
    appIdConfigured: Boolean(env.PINTEREST_APP_ID?.trim()),
    appSecretConfigured: Boolean(env.PINTEREST_APP_SECRET?.trim()),
    refreshTokenPresent: refresh.length > 0,
    refreshTokenLength: refresh.length || null,
    refreshTokenHygiene: refresh ? describeTokenHygiene(rawRefresh) : undefined,
    boardIdConfigured: boardId ?? null,
    apiBase: base,
  }, null, 2));

  let credential: string;
  if (directToken) {
    credential = `${DIRECT_TOKEN_PREFIX}${directToken}`;
  } else if (refresh) {
    if (!env.PINTEREST_APP_ID?.trim() || !env.PINTEREST_APP_SECRET?.trim()) {
      console.error("\n✗ PINTEREST_APP_ID / PINTEREST_APP_SECRET missing (required with PINTEREST_REFRESH_TOKEN).");
      process.exit(1);
    }
    credential = refresh;
  } else {
    console.error("\n✗ Neither PINTEREST_ACCESS_TOKEN nor PINTEREST_REFRESH_TOKEN is set.");
    process.exit(1);
  }

  // Resolve an access token the same way the adapter does (never printed).
  let accessToken: string;
  try {
    accessToken = await getPinterestAccessToken(credential);
    console.log(`\n✓ Access token resolved (${mode}).`);
  } catch (err: any) {
    console.error(`\n✗ Token resolution failed: ${err?.message ?? err}`);
    process.exit(1);
  }

  const me = await apiGet(`${base}/user_account`, accessToken);
  console.log("\nIdentity (/user_account):");
  console.log(JSON.stringify(me, null, 2));
  if (!me.ok) {
    console.error("\n✗ Access token rejected (invalid/expired or missing scopes). Needs pins:write + boards:read.");
    process.exit(1);
  }
  console.log(`\n✓ Authenticated as @${(me.body as any)?.username ?? "?"}.`);

  if (boardId) {
    const board = await apiGet(`${base}/boards/${boardId}`, accessToken);
    console.log(`\nConfigured board ${boardId}:`);
    console.log(JSON.stringify(board, null, 2));
    if (board.ok) {
      console.log(`\n✓ Can read board "${(board.body as any)?.name ?? "?"}". Pinterest pin publishing should work.`);
    } else {
      console.error(`\n✗ Authenticated but cannot read board ${boardId} (code ${(board as any).code}).`);
      console.error("  Confirm PINTEREST_BOARD_ID is a board owned by this account.");
      process.exit(1);
    }
  } else {
    console.error("\n✗ PINTEREST_BOARD_ID is not set — a pin cannot be created without a target board.");
    process.exit(1);
  }

  console.log("\nDiagnosis complete. No pin was created.");
  process.exit(0);
}

void main();
