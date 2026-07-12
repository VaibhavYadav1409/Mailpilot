import { describe, it, expect, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { writeReport, readReport } from "../src/lib/reportStorage";

const REPORTS_DIR = path.resolve(process.cwd(), "generated-reports");

describe("reportStorage (local driver)", () => {
  it("writes and reads back a CSV report by id", async () => {
    const id = "test-report-id";
    const csv = "employee,emailsReceived\nJane Doe,42\n";
    await writeReport(id, csv);
    const readBack = await readReport(id);
    expect(readBack.toString("utf-8")).toEqual(csv);
  });

  it("rejects reading a report that was never written", async () => {
    await expect(readReport("does-not-exist")).rejects.toThrow();
  });

  afterAll(async () => {
    await fs.rm(REPORTS_DIR, { recursive: true, force: true });
  });
});
