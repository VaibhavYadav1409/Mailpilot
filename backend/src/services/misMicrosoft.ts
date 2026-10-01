/**
 * Microsoft Graph access for the MIS auto-check.
 *
 * A company admin signs in ONCE with the Microsoft 365 account that owns (or
 * can open) the MIS spreadsheets — e.g. contactus@. We ask for read-only file
 * access (Files.Read.All) and keep only the refresh token, AES-GCM encrypted.
 * No password is ever seen or stored by MailPilot.
 *
 * Uses the same Azure app registration and redirect URI as the Outlook
 * connect flow (MS_CLIENT_ID / MS_CLIENT_SECRET / MS_REDIRECT_URI); the
 * callback tells the two flows apart by the `purpose` in the signed state.
 */
import { prisma } from "../lib/db";
import { decryptToken, encryptToken } from "../lib/crypto";
import { sheetsWorthReading, type MisSheetInput } from "./misSheet";

const REDIRECT_URI = process.env.MS_REDIRECT_URI ?? "http://localhost:4000/api/outlook/callback";
const AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES = [
  "https://graph.microsoft.com/Files.Read.All",
  "https://graph.microsoft.com/User.Read",
  "offline_access",
  "openid",
].join(" ");

export class MisGraphError extends Error {
  constructor(
    public status: number,
    message: string,
    public reconnect = false,
  ) {
    super(message);
  }
}

function credentials() {
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new MisGraphError(500, "Microsoft sign-in is not configured on the server (MS_CLIENT_ID / MS_CLIENT_SECRET).");
  return { clientId, clientSecret };
}

export function buildMisAuthUrl(state: string): string {
  const { clientId } = credentials();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    response_mode: "query",
    scope: SCOPES,
    state,
    prompt: "select_account",
  });
  return `${AUTHORITY}/authorize?${params}`;
}

async function tokenRequest(body: Record<string, string>) {
  const { clientId, clientSecret } = credentials();
  const res = await fetch(`${AUTHORITY}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: SCOPES, ...body }),
  });
  const text = await res.text();
  if (!res.ok) {
    const invalid = res.status === 400 && /invalid_grant|AADSTS/.test(text);
    throw new MisGraphError(res.status, `Microsoft sign-in failed: ${text.slice(0, 300)}`, invalid);
  }
  return JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in: number };
}

/** Code -> tokens + the signed-in account's email. */
export async function exchangeMisCode(code: string) {
  const t = await tokenRequest({ code, redirect_uri: REDIRECT_URI, grant_type: "authorization_code" });
  if (!t.refresh_token) throw new MisGraphError(400, "Microsoft did not return a refresh token. Please try connecting again.");
  const me = await graphJson<{ mail?: string | null; userPrincipalName?: string | null }>(
    t.access_token,
    "/me?$select=mail,userPrincipalName",
  ).catch(() => null);
  const email = (me?.mail || me?.userPrincipalName || "").toLowerCase() || "unknown";
  return { refreshToken: t.refresh_token, accessToken: t.access_token, expiresIn: t.expires_in, email };
}

// Access tokens live ~1h; cache per company so a check round does one refresh.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function forgetMisToken(companyId: string) {
  tokenCache.delete(companyId);
}

export function cacheMisToken(companyId: string, token: string, expiresIn: number) {
  tokenCache.set(companyId, { token, expiresAt: Date.now() + (expiresIn - 120) * 1000 });
}

/** A valid Graph access token for the company's MIS connection, refreshing (and rotating) as needed. */
export async function getMisAccessToken(companyId: string): Promise<string> {
  const cached = tokenCache.get(companyId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const conn = await prisma.misConnection.findUnique({ where: { companyId } });
  if (!conn) throw new MisGraphError(409, "No Microsoft account is connected for MIS yet.", true);
  if (conn.status === "NEEDS_RECONNECT") throw new MisGraphError(409, "The Microsoft account needs to be connected again.", true);

  try {
    const t = await tokenRequest({ refresh_token: decryptToken(conn.refreshTokenEnc), grant_type: "refresh_token" });
    if (t.refresh_token) {
      await prisma.misConnection.update({
        where: { companyId },
        data: { refreshTokenEnc: encryptToken(t.refresh_token), lastError: null },
      });
    }
    cacheMisToken(companyId, t.access_token, t.expires_in);
    return t.access_token;
  } catch (e) {
    if (e instanceof MisGraphError && e.reconnect) {
      await prisma.misConnection.update({
        where: { companyId },
        data: { status: "NEEDS_RECONNECT", lastError: e.message.slice(0, 1000) },
      });
    }
    throw e;
  }
}

async function graphJson<T>(token: string, path: string, attempt = 0): Promise<T> {
  const res = await fetch(`${GRAPH}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < 2) {
    const wait = Math.min(Number(res.headers.get("retry-after")) || 2 * (attempt + 1), 10);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return graphJson<T>(token, path, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text();
    let msg = body.slice(0, 300);
    try {
      msg = JSON.parse(body)?.error?.message ?? msg;
    } catch {
      /* not JSON */
    }
    if (res.status === 401) throw new MisGraphError(401, "Microsoft rejected the connection. Please reconnect the account.", true);
    if (res.status === 403) throw new MisGraphError(403, `No permission to open this file with the connected account (${msg}).`);
    if (res.status === 404) throw new MisGraphError(404, "File not found — the link may have changed or the file was moved/deleted.");
    throw new MisGraphError(res.status, `Microsoft Graph error ${res.status}: ${msg}`);
  }
  return (await res.json()) as T;
}

type DriveItemLite = {
  id: string;
  name: string;
  webUrl: string;
  parentReference?: { driveId?: string };
  sharepointIds?: { listItemUniqueId?: string };
};

const ITEM_SELECT = "id,name,webUrl,parentReference,sharepointIds";

function toResolved(item: DriveItemLite) {
  if (!item.parentReference?.driveId) throw new MisGraphError(400, "Could not resolve this link to a file.");
  if (!/\.xls[xmb]?$/i.test(item.name)) throw new MisGraphError(400, `"${item.name}" is not an Excel workbook.`);
  return { driveId: item.parentReference.driveId, itemId: item.id, fileName: item.name, webUrl: item.webUrl };
}

/**
 * SharePoint/OneDrive link -> the drive item it points at.
 *
 * Proper sharing links resolve through /shares. Links copied from the browser
 * while the file is open ("…/_layouts/15/Doc.aspx?sourcedoc={GUID}&file=…")
 * aren't sharing links, so for those we search the connected account's
 * OneDrive (and files shared with it) for that file name and match the GUID.
 */
export async function resolveShareLink(token: string, shareUrl: string) {
  const encoded = "u!" + Buffer.from(shareUrl, "utf8").toString("base64").replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
  let shareError: unknown = null;
  try {
    const item = await graphJson<DriveItemLite>(token, `/shares/${encoded}/driveItem?$select=${ITEM_SELECT}`);
    return toResolved(item);
  } catch (e) {
    shareError = e;
    if (e instanceof MisGraphError && e.reconnect) throw e;
  }

  const url = new URL(shareUrl);
  const guid = (url.searchParams.get("sourcedoc") ?? "").replace(/[{}]/g, "").toLowerCase();
  const fileName = url.searchParams.get("file") ?? decodeURIComponent(url.pathname.split("/").pop() ?? "");
  if (!fileName || !/\.xls[xmb]?$/i.test(fileName)) throw shareError;

  const q = encodeURIComponent(fileName.replace(/'/g, "''").replace(/\.xls[xmb]?$/i, ""));
  const candidates: DriveItemLite[] = [];
  const own = await graphJson<{ value: DriveItemLite[] }>(token, `/me/drive/root/search(q='${q}')?$select=${ITEM_SELECT}&$top=50`).catch(() => ({ value: [] }));
  candidates.push(...own.value);
  const shared = await graphJson<{ value: (DriveItemLite & { remoteItem?: DriveItemLite })[] }>(token, `/me/drive/sharedWithMe?$top=200`).catch(() => ({ value: [] }));
  candidates.push(...shared.value.map((v) => v.remoteItem ?? v));

  const match =
    (guid && candidates.find((c) => c.sharepointIds?.listItemUniqueId?.toLowerCase() === guid)) ||
    candidates.find((c) => c.name.toLowerCase() === fileName.toLowerCase());
  if (!match) {
    throw new MisGraphError(
      404,
      `Couldn't find "${fileName}" in the connected account's OneDrive. In Excel use Share → Copy link, and paste that link instead.`,
    );
  }
  return toResolved(match);
}

/** Current version of a file — changes whenever someone edits it. */
export async function getItemVersion(token: string, driveId: string, itemId: string): Promise<string | null> {
  const item = await graphJson<{ eTag?: string; lastModifiedDateTime?: string }>(
    token,
    `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}?$select=eTag,lastModifiedDateTime`,
  );
  return item.eTag ?? item.lastModifiedDateTime ?? null;
}

/** Top-left cell of an A1 address like "'Sep 26'!B3:K40" -> { firstRow: 3, firstCol: 2 }. */
export function topLeftOf(address: string | undefined): { firstRow: number; firstCol: number } {
  const m = /!\$?([A-Z]+)\$?(\d+)/i.exec(address ?? "");
  if (!m) return { firstRow: 1, firstCol: 1 };
  const firstCol = m[1].toUpperCase().split("").reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
  return { firstRow: Number(m[2]), firstCol };
}

/** How much of each sheet is read to find its dates before deciding whether to download it all. */
const PROBE_RANGE = "A1:EZ40";

/**
 * Reads the worksheets that matter for `dates`: every visible sheet's first
 * 40 rows are probed, and only the sheets holding those dates (plus a couple
 * of months of history) are downloaded in full. Dates arrive as Excel serials.
 */
export async function readWorkbook(
  token: string,
  driveId: string,
  itemId: string,
  dates: string[],
  sheetName?: string | null,
): Promise<MisSheetInput[]> {
  const base = `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/workbook/worksheets`;
  const list = await graphJson<{ value: { id: string; name: string; visibility?: string }[] }>(
    token,
    `${base}?$select=id,name,visibility`,
  );
  const visible = list.value.filter((ws) => !ws.visibility || ws.visibility === "Visible");

  const probes: (MisSheetInput & { id: string })[] = [];
  for (const ws of visible) {
    const r = await graphJson<{ values?: unknown[][] }>(
      token,
      `${base}/${encodeURIComponent(ws.id)}/range(address='${PROBE_RANGE}')?$select=values`,
    );
    probes.push({ id: ws.id, name: ws.name, values: r.values ?? [] });
  }

  const wanted = new Set(sheetsWorthReading(probes, dates, sheetName));
  const sheets: MisSheetInput[] = [];
  for (const p of probes) {
    if (!wanted.has(p.name)) continue;
    const range = await graphJson<{ address?: string; values?: unknown[][] }>(
      token,
      `${base}/${encodeURIComponent(p.id)}/usedRange(valuesOnly=true)?$select=address,values`,
    );
    sheets.push({ name: p.name, values: range.values ?? [], ...topLeftOf(range.address) });
  }
  return sheets;
}
