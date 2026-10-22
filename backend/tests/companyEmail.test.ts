import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.MIS_EMAIL_GAP_MS = "0";
process.env.MAIL_DAY_TIMEZONE ??= "Asia/Kolkata";
const db = {
  employees: [
    { id: "a", firstName: "Aman", lastName: "Nair", email: "aman nair", contactEmail: "farsight@farsightshares.com, farsightmktgroup@gmail.com" },
    { id: "m", firstName: "Mamta", lastName: "Arora", email: "mamta@farsightshares.com", contactEmail: null },
    { id: "x", firstName: "No", lastName: "Mail", email: "no mail", contactEmail: null },
  ],
  row: null as any,
  logs: [] as any[],
};
vi.mock("../src/lib/db", () => ({
  prisma: {
    employee: { findMany: vi.fn(async () => db.employees) },
    companyEmail: {
      create: vi.fn(async ({ data }: any) => (db.row = { id: "e1", status: "SCHEDULED", sent: 0, failed: 0, ...data })),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const ok = db.row && (where.OR ? where.OR.some((o: any) => o.status === db.row.status) : where.status === db.row.status);
        if (ok) Object.assign(db.row, data);
        return { count: ok ? 1 : 0 };
      }),
      findUnique: vi.fn(async () => db.row),
      update: vi.fn(async ({ data }: any) => Object.assign(db.row, data)),
    },
    misEmailLog: {
      findMany: vi.fn(async ({ where }: any) => db.logs.filter((l) => l.runId === where.runId && l.status === "SENT")),
      create: vi.fn(async ({ data }: any) => db.logs.push(data)),
    },
  },
}));
vi.mock("../src/sockets", () => ({ emitToCompany: vi.fn() }));
const sent: any[] = [];
vi.mock("../src/services/misEmail", async (orig) => ({
  ...(await orig<any>()),
  deliver: vi.fn(async (_c: string, m: any) => void sent.push(m)),
  senderStatus: vi.fn(async () => ({ canSend: true, from: "contactus@farsightshares.com" })),
}));

const ce = await import("../src/services/companyEmail");
const now = new Date("2026-10-24T05:00:00Z");

describe("custom email to everyone", () => {
  beforeEach(() => {
    sent.length = 0;
    db.logs = [];
    db.row = null;
  });
  it("everyone with an address; MIS staff use their MIS email, others their login", async () => {
    const { people, noEmail } = await ce.companyPeople("c1");
    expect(people.map((p) => [p.name, p.emails, p.group])).toEqual([
      ["Aman Nair", ["farsight@farsightshares.com", "farsightmktgroup@gmail.com"], "MIS"],
      ["Mamta Arora", ["mamta@farsightshares.com"], "MAILBOX"],
    ]);
    expect(noEmail).toEqual(["No Mail"]);
    expect(ce.pick(people, "MIS").map((p) => p.name)).toEqual(["Aman Nair"]);
    expect(ce.pick(people, "CHOSEN", ["m"]).map((p) => p.name)).toEqual(["Mamta Arora"]);
  });
  it("personal copies with {first}; plain text becomes clean HTML (escaped), no footer", () => {
    const m = ce.buildCompanyEmail("Diwali holiday — {first}", "Hi {first},\n\nOffice closed on <b>Mon</b>.\nRegards, HR", { name: "Aman Nair", first: "Aman" });
    expect(m.subject).toBe("Diwali holiday — Aman");
    expect(m.html).toContain("Hi Aman,");
    expect(m.html).toContain("Office closed on &lt;b&gt;Mon&lt;/b&gt;.<br>Regards, HR");
    expect(m.html).not.toContain("Automatic email");
  });
  it("send now: one copy each, logged, then SENT; never twice", async () => {
    const r = await ce.createCompanyEmail("c1", "admin", { subject: "Hello", body: "Hi {first}", audience: "ALL" }, now);
    expect(r).toMatchObject({ total: 2, immediate: true });
    await new Promise((res) => setTimeout(res, 20));
    expect(sent.map((m) => m.to)).toEqual([["farsight@farsightshares.com", "farsightmktgroup@gmail.com"], ["mamta@farsightshares.com"]]);
    expect(sent[0].text).toBe("Hi Aman");
    expect(db.row).toMatchObject({ status: "SENT", sent: 2, failed: 0 });
    await ce.sendCompanyEmail("e1", "SCHEDULE", now); // already sent -> nothing
    expect(sent).toHaveLength(2);
  });
  it("scheduled for later: waits; an interrupted send resumes without repeats", async () => {
    const r = await ce.createCompanyEmail("c1", "admin", { subject: "Later", body: "x", audience: "ALL", sendAt: "2026-10-25T04:30:00Z" }, now);
    expect(r.immediate).toBe(false);
    expect(sent).toHaveLength(0);
    // Pretend Aman already got it before a restart.
    db.logs.push({ runId: "e1", employeeId: "a", status: "SENT" });
    await ce.sendCompanyEmail("e1", "SCHEDULE", new Date("2026-10-25T04:31:00Z"));
    expect(sent.map((m) => m.to[0])).toEqual(["mamta@farsightshares.com"]);
    expect(db.row).toMatchObject({ status: "SENT", sent: 2 });
  });
  it("checks the input", async () => {
    await expect(ce.createCompanyEmail("c1", "a", { subject: "", body: "x", audience: "ALL" }, now)).rejects.toThrow(/subject/);
    await expect(ce.createCompanyEmail("c1", "a", { subject: "s", body: "x", audience: "ALL", sendAt: "2026-10-01T00:00:00Z" }, now)).rejects.toThrow(/already passed/);
    await expect(ce.createCompanyEmail("c1", "a", { subject: "s", body: "x", audience: "CHOSEN", employeeIds: [] }, now)).rejects.toThrow(/Pick at least one/);
  });
});
