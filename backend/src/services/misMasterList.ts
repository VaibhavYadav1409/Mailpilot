/**
 * "Import master list" — the company's Excel list of every employee's MIS file
 * ("All MIS Spreadsheet Link": Employee Name | MIS Links | Email Using by
 * Employee | Off for employee, plus a "Left" sheet of people who left).
 *
 * Upload it → MailPilot shows exactly what would change (preview) → Apply.
 * For each person in the active list it:
 *   - finds the person (by the file already linked, their username or name;
 *     creates new MIS staff for a new name),
 *   - links their MIS file(s) and, if chosen, removes their old files that are
 *     no longer in the list,
 *   - sets where their MIS emails go (the emails in the list, in that order:
 *     the first one is the one that has to reply),
 *   - sets their Saturday rule (2nd Saturday / 2 Saturdays a month). "Every
 *     Saturday off" set by HR is never lowered by the list — it is flagged.
 * People in the "left" sheet who are still active, and MIS staff not in the
 * list at all, are only reported — nobody is removed automatically.
 */
import { prisma } from "../lib/db";
import { readXlsx, XlsxError, type XlsxSheet } from "../lib/xlsxRead";
import { emitToCompany } from "../sockets";
import { isEmail, parseEmailList } from "./misEmail";
import { saturdayRuleOf, type SaturdayRule } from "./misLeave";
import { deleteMisSource, docGuid, matchExistingStaff, MisError, runMisChecks, splitImportName, validateShareUrl } from "./misService";
import { upsertMsiStaff } from "./msiStaff";

export interface MasterRow {
  /** Row number in the sheet (1-based, as Excel shows it). */
  line: number;
  name: string;
  url: string;
  emails: string[];
  saturday: SaturdayRule | null;
  offText: string;
}

export interface MasterList {
  active: MasterRow[];
  left: { line: number; name: string }[];
  sheetNames: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** "2nd Saturday Off in every month" -> SECOND; "…2 Saturdays off every month…" -> TWO; "every Saturday off" -> ALL. */
export function saturdayRuleFrom(text: string): SaturdayRule | null {
  const t = norm(text);
  if (!t) return null;
  if (/\b(all|every|each)\s+saturdays?\s+(is\s+|are\s+)?off\b|\ball\s+saturdays\b/.test(t)) return "ALL";
  if (/\b(2|two)\s+saturdays\b|\bsecond\s+and\s+(another|one)|\badditional\s+saturday\b/.test(t)) return "TWO";
  if (/\b(2nd|second)\s+saturday\b/.test(t)) return "SECOND";
  return null;
}

/** Finds the header row and the columns by their titles (works if columns are moved or renamed slightly). */
function columns(sheet: XlsxSheet) {
  for (let r = 0; r < Math.min(10, sheet.rows.length); r++) {
    const row = (sheet.rows[r] ?? []).map(norm);
    const name = row.findIndex((c) => /\bname\b/.test(c) || c === "employee");
    const link = row.findIndex((c) => /\blinks?\b|\burl\b|spreadsheet/.test(c));
    if (name < 0 || link < 0) continue;
    return {
      header: r,
      name,
      link,
      email: row.findIndex((c) => /e-?mail/.test(c)),
      off: row.findIndex((c) => /\boff\b|saturday|holiday|weekly/.test(c)),
    };
  }
  return null;
}

const cellText = (sheet: XlsxSheet, r: number, c: number) => (c < 0 ? "" : (sheet.rows[r]?.[c] ?? "").replace(/ /g, " ").trim());

export function parseMasterList(buf: Buffer): MasterList {
  let sheets: XlsxSheet[];
  try {
    sheets = readXlsx(buf);
  } catch (e) {
    throw new MisError(400, e instanceof XlsxError ? e.message : "Could not read the Excel file.");
  }
  const isLeftSheet = (s: XlsxSheet) => /\bleft\b|former|ex[- ]?emp|resign/i.test(s.name);
  const activeSheet = sheets.find((s) => !isLeftSheet(s) && columns(s)) ?? null;
  if (!activeSheet) throw new MisError(400, 'No sheet with "Employee Name" and "MIS Links" columns was found.');
  const col = columns(activeSheet)!;
  const active: MasterRow[] = [];
  for (let r = col.header + 1; r < activeSheet.rows.length; r++) {
    const name = cellText(activeSheet, r, col.name);
    if (!name) continue;
    const linkText = cellText(activeSheet, r, col.link);
    const url = /^https?:\/\//i.test(linkText) ? linkText : activeSheet.links.get(`${r},${col.link}`) ?? linkText;
    const offText = cellText(activeSheet, r, col.off);
    active.push({
      line: r + 1,
      name,
      url,
      emails: [...new Set(parseEmailList(cellText(activeSheet, r, col.email)).map((e) => e.toLowerCase()).filter(isEmail))],
      saturday: saturdayRuleFrom(offText),
      offText,
    });
  }
  const left: MasterList["left"] = [];
  for (const s of sheets.filter(isLeftSheet)) {
    // Name column: the first column whose cells are mostly words (not numbers or links).
    const rows = s.rows;
    const width = Math.max(0, ...rows.map((r) => r.length));
    let nameCol = -1;
    let best = 0;
    for (let c = 0; c < width; c++) {
      const n = rows.filter((r) => /^[a-z][a-z .'-]+$/i.test((r[c] ?? "").replace(/\([^)]*\)/g, "").trim()) && !/job left|left|name/i.test(r[c] ?? "")).length;
      if (n > best) {
        best = n;
        nameCol = c;
      }
    }
    if (nameCol < 0) continue;
    rows.forEach((r, i) => {
      const name = (r[nameCol] ?? "").trim();
      const bare = name.replace(/\([^)]*\)/g, "").trim(); // "AJIT KUMAR JHA (225)"
      if (/^[a-z][a-z .'-]+$/i.test(bare) && !/^(job left|left|name|employee name)$/i.test(bare)) left.push({ line: i + 1, name });
    });
  }
  return { active, left, sheetNames: sheets.map((s) => s.name) };
}

// ---------------------------------------------------------------------------
// Matching people
// ---------------------------------------------------------------------------

interface Staff {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  contactEmail: string | null;
  misSaturdaysOff: boolean;
  misExtraSaturdayOff: boolean;
  misWeeklySince: Date | null;
  status: string;
}

const letters = (s: string) => s.toUpperCase().replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();
const fullName = (s: Staff) => letters(`${s.firstName} ${s.lastName}`);

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/**
 * The person a name in the list means: their username, their full name, a
 * login that is the start of the name ("anjali" for "ANJALI JHA"), or the same
 * name with a small spelling difference ("BHUPINDER" / "BHUPENDER"). Null when
 * unsure — never a guess between two people.
 */
export function matchPerson<T extends Staff>(staff: T[], rawName: string): T | null {
  const person = letters(splitImportName(rawName).person);
  if (!person) return null;
  const exact = staff.filter((s) => letters(s.email) === person || fullName(s) === person);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return exact.find((s) => s.status !== "SUSPENDED") ?? null;
  const prefix = matchExistingStaff(staff, person);
  if (prefix) return prefix;
  const close = staff.filter((s) => {
    const n = fullName(s);
    return person.length >= 8 && n.length >= 8 && lev(n, person) <= 2 && n[0] === person[0];
  });
  return close.length === 1 ? close[0] : null;
}

// ---------------------------------------------------------------------------
// Preview / apply
// ---------------------------------------------------------------------------

export interface PlanFile {
  label: string;
  fileName: string | null;
  url: string;
  state: "already linked" | "new" | "invalid";
  problem?: string;
}

export interface PlanPerson {
  lines: number[];
  listName: string;
  employeeId: string | null;
  name: string;
  username: string | null;
  isNew: boolean;
  weekly: boolean;
  files: PlanFile[];
  oldFiles: { id: string; label: string; fileName: string | null }[];
  emails: { now: string[]; list: string[]; change: boolean };
  saturday: { now: SaturdayRule; list: SaturdayRule | null; change: boolean; kept: boolean };
  notes: string[];
}

export interface MasterPlan {
  people: PlanPerson[];
  /** MIS staff with a file who are not in the list. */
  notInList: { employeeId: string; name: string; files: number }[];
  /** People in the "left" sheet who are still active in MailPilot. */
  leftButActive: { employeeId: string; name: string; listName: string }[];
  counts: { people: number; newPeople: number; newFiles: number; oldFiles: number; emailChanges: number; saturdayChanges: number; problems: number };
}

const fileNameOf = (url: string) => {
  try {
    const f = new URL(url).searchParams.get("file");
    return f ? decodeURIComponent(f.replace(/\+/g, " ")) : null;
  } catch {
    return null;
  }
};

export async function planMasterList(companyId: string, list: MasterList): Promise<MasterPlan> {
  const [staff, sources] = await Promise.all([
    prisma.employee.findMany({
      where: { companyId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        contactEmail: true,
        misSaturdaysOff: true,
        misExtraSaturdayOff: true,
        misWeeklySince: true,
        status: true,
      },
    }),
    prisma.misSource.findMany({ where: { companyId }, select: { id: true, employeeId: true, label: true, shareUrl: true, fileName: true } }),
  ]);
  const ownerOfFile = new Map(sources.map((s) => [docGuid(s.shareUrl) ?? s.shareUrl, s.employeeId]));
  const misStaff = staff.filter((s) => !s.email.includes("@"));
  const byKey = new Map<string, PlanPerson>();

  for (const row of list.active) {
    const { person: upper, label } = splitImportName(row.name);
    let url: string | null = null;
    let problem: string | undefined;
    try {
      url = validateShareUrl(row.url);
    } catch (e) {
      problem = /docs\.google\.com/.test(row.url)
        ? "Google Sheets link — only Excel files in SharePoint/OneDrive can be checked."
        : row.url
        ? (e as Error).message
        : "No link.";
    }
    const owner = url ? ownerOfFile.get(docGuid(url) ?? url) : undefined;
    const emp = (owner ? staff.find((s) => s.id === owner) : null) ?? matchPerson(misStaff, row.name) ?? matchPerson(staff, row.name);
    const key = emp?.id ?? `new:${upper}`;
    let p = byKey.get(key);
    if (!p) {
      p = {
        lines: [],
        listName: row.name.trim(),
        employeeId: emp?.id ?? null,
        name: emp ? `${emp.firstName} ${emp.lastName}`.trim() : upper,
        username: emp ? emp.email.toUpperCase() : upper,
        isNew: !emp,
        weekly: !!emp?.misWeeklySince,
        files: [],
        oldFiles: [],
        emails: { now: emp ? parseEmailList(emp.contactEmail) : [], list: [], change: false },
        saturday: { now: emp ? saturdayRuleOf(emp) : "SECOND", list: null, change: false, kept: false },
        notes: [],
      };
      if (emp?.status === "SUSPENDED") p.notes.push("This person was removed earlier — applying brings them back.");
      byKey.set(key, p);
    }
    p.lines.push(row.line);
    if (url) {
      const linked = sources.some((s) => s.employeeId === emp?.id && (docGuid(s.shareUrl) ?? s.shareUrl) === (docGuid(url!) ?? url));
      p.files.push({ label: label === "MIS" && p.files.length ? `MIS ${p.files.length + 1}` : label, fileName: fileNameOf(url), url, state: linked ? "already linked" : "new" });
    } else if (!(p.weekly && !row.url.startsWith("http"))) {
      p.files.push({ label, fileName: null, url: row.url, state: "invalid", problem });
    } else {
      p.notes.push("Weekly reporter — no MIS file needed.");
    }
    for (const e of row.emails) if (!p.emails.list.includes(e)) p.emails.list.push(e);
    if (row.saturday && (!p.saturday.list || row.saturday === "TWO" || row.saturday === "ALL")) p.saturday.list = row.saturday;
  }

  for (const p of byKey.values()) {
    const keep = new Set(p.files.filter((f) => f.state !== "invalid").map((f) => docGuid(f.url) ?? f.url));
    if (p.employeeId && keep.size)
      p.oldFiles = sources
        .filter((s) => s.employeeId === p.employeeId && !keep.has(docGuid(s.shareUrl) ?? s.shareUrl))
        .map((s) => ({ id: s.id, label: s.label, fileName: s.fileName ?? fileNameOf(s.shareUrl) }));
    p.emails.change = p.emails.list.length > 0 && p.emails.list.join(",") !== p.emails.now.map((e) => e.toLowerCase()).join(",");
    const want = p.saturday.list;
    if (want && want !== p.saturday.now) {
      if (p.saturday.now === "ALL" && want !== "ALL") {
        p.saturday.kept = true;
        p.notes.push(`Kept "Every Saturday off" (set in MailPilot); the list says ${want === "TWO" ? "2 Saturdays a month" : "2nd Saturday"}. Change it on Leave Records if the list is right.`);
      } else p.saturday.change = true;
    }
  }

  const people = [...byKey.values()];
  const inList = new Set(people.map((p) => p.employeeId).filter(Boolean));
  const notInList = misStaff
    .filter((s) => s.status !== "SUSPENDED" && !inList.has(s.id) && !s.misWeeklySince && sources.some((x) => x.employeeId === s.id))
    .map((s) => ({ employeeId: s.id, name: `${s.firstName} ${s.lastName}`.trim(), files: sources.filter((x) => x.employeeId === s.id).length }));
  const leftButActive: MasterPlan["leftButActive"] = [];
  for (const l of list.left) {
    const e = matchPerson(
      staff.filter((s) => s.status !== "SUSPENDED" && !inList.has(s.id)),
      l.name,
    );
    if (e && !leftButActive.some((x) => x.employeeId === e.id)) leftButActive.push({ employeeId: e.id, name: `${e.firstName} ${e.lastName}`.trim(), listName: l.name });
  }
  return {
    people,
    notInList,
    leftButActive,
    counts: {
      people: people.length,
      newPeople: people.filter((p) => p.isNew && p.files.some((f) => f.state === "new")).length,
      newFiles: people.reduce((n, p) => n + p.files.filter((f) => f.state === "new").length, 0),
      oldFiles: people.reduce((n, p) => n + p.oldFiles.length, 0),
      emailChanges: people.filter((p) => p.emails.change).length,
      saturdayChanges: people.filter((p) => p.saturday.change).length,
      problems: people.reduce((n, p) => n + p.files.filter((f) => f.state === "invalid").length, 0),
    },
  };
}

export interface ApplyResult {
  plan: MasterPlan;
  done: { name: string; actions: string[]; error?: string }[];
}

/** Applies the plan (re-made from the same file, so it is never stale). */
export async function applyMasterList(companyId: string, actorId: string, list: MasterList, opts: { removeOldFiles: boolean }): Promise<ApplyResult> {
  const plan = await planMasterList(companyId, list);
  const done: ApplyResult["done"] = [];
  let linkedAny = false;
  for (const p of plan.people) {
    const actions: string[] = [];
    try {
      let employeeId = p.employeeId;
      if (!employeeId) {
        if (!p.files.some((f) => f.state === "new")) {
          done.push({ name: p.listName, actions: [], error: "Not added — no valid MIS link." });
          continue;
        }
        const r = await upsertMsiStaff(companyId, p.name, { keepPassword: true });
        employeeId = r.employee.id;
        actions.push(`Added as MIS staff (username ${r.username}, password ${r.username})`);
      } else if (p.notes.some((n) => n.startsWith("This person was removed"))) {
        await prisma.employee.update({ where: { id: employeeId }, data: { status: "OFFLINE" } });
        actions.push("Brought back (was removed)");
      }
      for (const f of p.files.filter((x) => x.state === "new")) {
        await prisma.misSource.create({ data: { companyId, employeeId, label: f.label.slice(0, 80) || "MIS", shareUrl: f.url } });
        actions.push(`Linked ${f.fileName ?? "MIS file"}`);
        linkedAny = true;
      }
      if (opts.removeOldFiles) {
        for (const o of p.oldFiles) {
          await deleteMisSource(companyId, o.id).catch(() => undefined);
          actions.push(`Removed old file ${o.fileName ?? o.label}`);
        }
      }
      const data: Record<string, unknown> = {};
      if (p.emails.change || (p.isNew && p.emails.list.length)) {
        data.contactEmail = p.emails.list.join(", ");
        actions.push(`MIS emails to ${p.emails.list.join(", ")}`);
      }
      const rule = p.saturday.change || (p.isNew && p.saturday.list && p.saturday.list !== "SECOND") ? p.saturday.list : null;
      if (rule) {
        data.misSaturdaysOff = rule === "ALL";
        data.misExtraSaturdayOff = rule === "TWO";
        actions.push(rule === "TWO" ? "2 Saturdays off a month" : rule === "ALL" ? "Every Saturday off" : "2nd Saturday off");
      }
      if (Object.keys(data).length) await prisma.employee.update({ where: { id: employeeId }, data });
      done.push({ name: p.name, actions });
    } catch (e) {
      done.push({ name: p.listName, actions, error: e instanceof Error ? e.message : String(e) });
    }
  }
  await prisma.auditLog
    .create({ data: { companyId, employeeId: actorId, action: "MIS_MASTER_LIST", metadata: { people: plan.counts.people, removeOldFiles: opts.removeOldFiles, done: done.filter((d) => d.actions.length || d.error) } as object } })
    .catch(() => undefined);
  if (linkedAny) void runMisChecks(companyId).catch((e) => console.error("[MIS] check after master list failed:", e));
  emitToCompany(companyId, "msi:updated", { source: "mis-master-list" });
  return { plan, done };
}
