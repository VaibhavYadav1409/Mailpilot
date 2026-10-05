import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { toast } from "sonner";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  ClipboardList,
  Clock,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  RefreshCw,
  History,
  Loader2,
  LogOut,
  Mail,
  Pencil,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { ModuleRail } from "@/components/ModuleRail";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, msiApi, type MisDayResult, type MsiMis, type MsiReport, type MsiToday, type MyCircle } from "@/lib/api";

// ---------------------------------------------------------------------------
// Formatting — every date/time shown here is rendered in the SERVER's
// business timezone (returned by /api/msi/reports/today), never the
// machine's local zone, so what the employee sees matches what the CEO sees.
// ---------------------------------------------------------------------------

function formatLongDate(dateStr: string) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

const NOT_FILLED_BLANKS = 20;

function dmy(date: string) {
  return date.split("-").reverse().join("-");
}

/** What a day's result means, in plain words, for the staff member. */
function explain(mis: MsiMis, date: string): { tone: "green" | "amber" | "red" | "gray"; title: string; text: string } {
  const d = dmy(date);
  switch (mis.status) {
    case "COMPLETE":
      return { tone: "green", title: "Submitted ✓", text: `Every entry you usually fill has something for ${d}.` };
    case "INCOMPLETE":
      return {
        tone: "amber",
        title: `Incomplete — ${mis.missingColumns.length} blank`,
        text: `Almost done. Fill the blank cells listed below in the ${d} column, then press "Check again".`,
      };
    case "MISSING": {
      const note = mis.sources.map((s) => s.note).find((n) => n?.startsWith("Not filled"));
      return {
        tone: "red",
        title: "Not submitted",
        text: note
          ? `${note} ${NOT_FILLED_BLANKS} or more blanks counts as not filled — please fill the ${d} column.`
          : `There is no ${d} column in your MIS yet. Add it and fill every row you normally fill.`,
      };
    }
    case "ERROR":
      return { tone: "gray", title: "Couldn't read your MIS", text: "MailPilot couldn't open your MIS file. Your admin can see why and fix the link." };
    case "OFF":
      return { tone: "gray", title: "Day off", text: "Sunday, weekly-off Saturday or holiday — no MIS needed, not counted." };
    default:
      return { tone: "gray", title: "Not checked yet", text: "Your MIS will be read within 10 minutes." };
  }
}

const TONES = {
  green: "border-green-200 bg-green-50/70 dark:bg-green-950/20 dark:border-green-900",
  amber: "border-amber-200 bg-amber-50/70 dark:bg-amber-950/20 dark:border-amber-900",
  red: "border-red-200 bg-red-50/70 dark:bg-red-950/20 dark:border-red-900",
  gray: "",
};
const TITLE_TONES = {
  green: "text-green-700 dark:text-green-400",
  amber: "text-amber-700 dark:text-amber-400",
  red: "text-red-700 dark:text-red-400",
  gray: "text-foreground",
};

/**
 * The last two working days' MIS. Staff get until 11:00 AM on the next working
 * day to fill a day, so these are the days the CEO sees. Each file shows exactly which cells are blank.
 */
function MisDaysPanel({ days, tz, onUpdate }: { days: MisDayResult[]; tz: string; onUpdate: (d: MisDayResult[]) => void }) {
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    try {
      const r = await msiApi.checkMis();
      onUpdate(r.misDays);
      if (r.misDays.every((d) => d.mis.status === "COMPLETE" || d.mis.status === "OFF")) toast.success("Your MIS is complete.");
      else toast.info("Checked — see what is still missing below.");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't check your MIS. Try again.");
    } finally {
      setChecking(false);
    }
  };
  const lastChecked = days.flatMap((d) => d.mis.sources.map((s) => s.checkedAt)).filter(Boolean).sort().at(-1);
  const files = days[0]?.mis.sources ?? [];

  return (
    <div className="space-y-3">
      <Card className="p-4 text-sm text-muted-foreground space-y-1">
        <p>
          <span className="font-medium text-foreground">How it works:</span> fill your MIS in Excel as usual. MailPilot reads it every 10
          minutes. A day counts as <span className="text-green-700 font-medium">submitted</span> when every entry you usually fill has
          something in it (nil / NA / done all count). A few blanks = <span className="text-amber-700 font-medium">incomplete</span>;{" "}
          {NOT_FILLED_BLANKS}+ blanks or no column for the day = <span className="text-red-700 font-medium">not submitted</span>.
        </p>
        <p>
          You get until 11:00 AM on the next working day to fill each day, so you are checked for the last two working days. Sundays, the 2nd
          Saturday and stock market holidays need no MIS. MailPilot also records when you last saved the Excel file.
        </p>
      </Card>

      {days.map((d) => {
        const e = explain(d.mis, d.date);
        return (
          <Card key={d.date} className={`p-5 space-y-3 ${TONES[e.tone]}`}>
            <div className="flex items-start gap-3">
              <FileSpreadsheet className={`w-6 h-6 shrink-0 ${TITLE_TONES[e.tone]}`} />
              <div className="flex-1 min-w-0">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  {d.label} · {formatLongDate(d.date)}
                </p>
                <p className={`font-semibold text-lg ${TITLE_TONES[e.tone]}`}>{e.title}</p>
                <p className="text-sm text-muted-foreground mt-0.5">{e.text}</p>
              </div>
            </div>
            {d.mis.sources.length > 1 &&
              d.mis.sources.map((s) => (
                <p key={s.id} className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{s.label}:</span>{" "}
                  {s.status === "COMPLETE" ? "complete" : s.status === "INCOMPLETE" ? `${s.missingColumns.length} blank` : s.status === "MISSING" ? "not filled" : s.status === "ERROR" ? "couldn't read" : s.status === "OFF" ? "day off" : "not checked yet"}
                </p>
              ))}
            {d.mis.sources.some((s) => s.fileSavedAt || s.completedAt) && (
              <p className="text-xs text-muted-foreground">
                {d.mis.sources
                  .map((s) =>
                    [
                      d.mis.sources.length > 1 ? `${s.label}:` : "",
                      s.fileSavedAt ? `Excel last saved ${formatWhen(s.fileSavedAt, tz)}${s.fileSavedBy ? ` by ${s.fileSavedBy}` : ""}` : "",
                      s.completedAt ? `· fully filled ${formatWhen(s.completedAt, tz)}` : "",
                    ]
                      .filter(Boolean)
                      .join(" "),
                  )
                  .join("  |  ")}
              </p>
            )}
            {d.mis.sources.some((s) => s.blanks.length > 0) && (
              <div className="rounded-lg border bg-background/70 p-3 space-y-2">
                {d.mis.sources
                  .filter((s) => s.blanks.length > 0)
                  .map((s) => (
                    <div key={s.id}>
                      <p className="text-xs font-semibold mb-1">
                        {s.label} — sheet “{s.blanks[0].sheet}”
                      </p>
                      <ul className="text-xs space-y-0.5 max-h-56 overflow-auto">
                        {s.blanks.map((b) => (
                          <li key={`${b.sheet}!${b.cell}`} className="flex gap-2">
                            <span className="font-mono text-muted-foreground w-12 shrink-0">{b.cell}</span>
                            <span>{b.field}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
              </div>
            )}
          </Card>
        );
      })}

      <div className="flex flex-wrap items-center gap-3">
        {files.map((s) => (
          <a
            key={s.id}
            href={s.webUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/5"
          >
            <ExternalLink className="w-4 h-4" /> Open {files.length > 1 ? s.label : "my MIS"}
          </a>
        ))}
        <Button size="sm" variant="outline" onClick={check} disabled={checking}>
          <RefreshCw className={`w-4 h-4 mr-2 ${checking ? "animate-spin" : ""}`} />
          {checking ? "Checking…" : "I've filled it — check again"}
        </Button>
        {lastChecked && <span className="text-xs text-muted-foreground">Last checked {formatTime(lastChecked, tz)}</span>}
      </div>
    </div>
  );
}

const CELL_TONE: Record<string, string> = {
  red: "bg-red-100 text-red-800 font-bold",
  green: "bg-green-100 text-green-800",
  amber: "bg-amber-100 text-amber-800",
  grey: "bg-muted text-muted-foreground",
  blue: "bg-sky-100 text-sky-800",
  purple: "bg-violet-100 text-violet-800",
};

/** This month's red circles (MIS not submitted) and what they cost. */
function CircleCard({ data }: { data: MyCircle }) {
  const [downloading, setDownloading] = useState(false);
  const row = data.row;
  if (!row) return null;
  const s = row.summary;
  const tone = data.codes.reduce<Record<string, string>>((m, c) => ((m[c.code] = c.tone), m), {});
  const isCircle = new Set(data.codes.filter((c) => c.isCircle).map((c) => c.code));
  const dmy = (d: string) => d.split("-").reverse().join("-");
  const ord = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
  // Every red circle in date order, numbered like the Excel sheet.
  let n = 0;
  const circles = data.days
    .filter((d) => isCircle.has(row.cells[d.date]?.code ?? ""))
    .map((d) => {
      const c = row.cells[d.date];
      if (c.pending) return { date: d.date, number: null as number | null, triggers: false, reason: c.reason, note: c.note, evidence: c.evidence ?? null };
      n++;
      return { date: d.date, number: n, triggers: n % 3 === 0, reason: c.reason, note: c.note, evidence: c.evidence ?? null };
    });
  const download = async () => {
    setDownloading(true);
    try {
      await msiApi.downloadMyCircle(data.month);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't download the Circle Report.");
    } finally {
      setDownloading(false);
    }
  };
  return (
    <Card className={`p-5 space-y-3 ${s.deductionDays ? "border-red-200 bg-red-50/60" : ""}`}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="font-semibold">Red circles this month</p>
        <p className="text-sm">
          <span className={`text-2xl font-bold ${s.circles ? "text-red-600" : "text-green-600"}`}>{s.circles}</span>
          {s.pendingCircles > 0 && <span className="text-red-500"> (+{s.pendingCircles} pending)</span>}
        </p>
        <p className={`text-sm font-medium ${s.deductionDays ? "text-red-700" : "text-muted-foreground"}`}>
          Salary deduction: {s.deductionDays} day{s.deductionDays === 1 ? "" : "s"}
        </p>
        <Button size="sm" variant="outline" className="ml-auto" onClick={download} disabled={downloading}>
          {downloading ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <FileSpreadsheet className="w-4 h-4 mr-1.5" />}
          Download my Excel
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{s.message}</p>
      {data.status && <p className={`text-xs ${data.status.final ? "text-green-700" : "text-amber-700"}`}>{data.status.text}</p>}
      <div className="flex flex-wrap gap-1">
        {data.days.map((d) => {
          const c = row.cells[d.date];
          return (
            <div
              key={d.date}
              className="text-center"
              title={c?.code ? `${dmy(d.date)}: ${c.code}${c.pending ? " (pending)" : ""}${c.reason && c.source !== "CALENDAR" ? `\nWhy: ${c.reason}` : ""}${c.note ? `\nNote: ${c.note}` : ""}` : dmy(d.date)}
            >
              <div className="text-[9px] text-muted-foreground">{d.day}</div>
              <div className={`w-7 h-6 rounded text-[9px] flex items-center justify-center ${c?.code ? CELL_TONE[tone[c.code]] ?? "" : "bg-muted/40"} ${c?.pending ? "outline-dashed outline-1 outline-red-400" : ""}`}>
                {c?.code ?? ""}
              </div>
            </div>
          );
        })}
      </div>
      {circles.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Your red circles and why</p>
          <ol className="space-y-1">
            {circles.map((c) => (
              <li key={c.date} className={`text-xs rounded-md border px-2.5 py-1.5 ${c.triggers ? "border-red-300 bg-red-100/60" : c.number === null ? "border-dashed border-red-300" : ""}`}>
                <b>{c.number === null ? "Pending" : `${ord(c.number)} circle`}</b> · {dmy(c.date)}
                {c.triggers && <span className="text-red-700 font-semibold"> → {ord(c.number! / 3)} day's salary deducted</span>}
                {c.number === null && <span className="text-red-600"> — fill this day's MIS before the deadline and it won't count</span>}
                {c.reason && <span className="block text-muted-foreground mt-0.5">Why: {c.reason}</span>}
                {c.note && <span className="block text-muted-foreground">Note: {c.note}</span>}
                {c.evidence?.lines.map((l, i) => (
                  <span key={i} className="block text-muted-foreground">
                    {l}
                  </span>
                ))}
              </li>
            ))}
          </ol>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        CM = red circle (MIS not filled by the deadline — 11:00 AM on the next working day). Every 3 red circles in a month = 1 day's salary
        deducted — they don't need to be in a row; 1 or 2 circles means no deduction yet. The count restarts on the 1st. Leave, on duty, Sundays,
        2nd Saturdays and holidays never count. Filling after the deadline is recorded as "filled late" and the circle stays.
      </p>
    </Card>
  );
}

function formatWhen(iso: string, tz: string) {
  return new Date(iso).toLocaleString("en-GB", { timeZone: tz, day: "2-digit", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
}

function formatTime(iso: string, tz: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function friendlyError(e: unknown) {
  if (e instanceof ApiError) {
    if (e.status === 0 || e.status >= 500) return "Upload failed. Please try again.";
    return e.message;
  }
  return "Upload failed. Please try again.";
}

// ---------------------------------------------------------------------------

export default function MsiDailyReport() {
  const { user, loading, isAuthenticated, logout } = useAuth({ redirectOnUnauthenticated: true });
  const queryClient = useQueryClient();

  const today = useQuery({
    queryKey: ["msi", "today"],
    queryFn: msiApi.today,
    enabled: isAuthenticated,
    refetchOnWindowFocus: false,
  });
  const recent = useQuery({
    queryKey: ["msi", "recent"],
    queryFn: msiApi.recent,
    enabled: isAuthenticated,
    refetchOnWindowFocus: false,
  });

  const [editing, setEditing] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const data = today.data;
  const report = data?.report ?? null;
  const tz = data?.timezone ?? "Asia/Kolkata";
  const rules = data?.rules;
  const showForm = !report || editing;
  const hasMis = (data?.misDays?.length ?? 0) > 0;
  const circle = useQuery({ queryKey: ["mis", "circle"], queryFn: () => msiApi.myCircle(), enabled: hasMis, staleTime: 60_000 });
  const uploading = progress !== null;

  const applyReport = (next: MsiReport | null) => {
    queryClient.setQueryData<MsiToday>(["msi", "today"], (old) => (old ? { ...old, submitted: Boolean(next), report: next } : old));
    queryClient.invalidateQueries({ queryKey: ["msi", "recent"] });
  };

  const resetForm = () => {
    setFile(null);
    setMessage("");
    setFileError(null);
    setFormError(null);
    if (fileInput.current) fileInput.current.value = "";
  };

  const pickFile = (f: File | null) => {
    setFormError(null);
    if (!f || !rules) {
      setFile(null);
      return;
    }
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    if (!f.name.includes(".") || !rules.allowedExtensions.includes(ext)) {
      setFile(null);
      setFileError("This file type is not supported.");
      return;
    }
    if (f.size > rules.maxFileBytes) {
      setFile(null);
      setFileError("File exceeds the allowed size.");
      return;
    }
    if (f.size === 0) {
      setFile(null);
      setFileError("The selected file is empty.");
      return;
    }
    setFileError(null);
    setFile(f);
  };

  const startEdit = () => {
    resetForm();
    setMessage(report?.importantMessage ?? "");
    setEditing(true);
  };

  const submit = async () => {
    setFormError(null);
    if (!editing && !file) {
      setFileError("Please select your daily report.");
      return;
    }
    if (fileError) return;
    try {
      setProgress(0);
      const filePayload = file ? { fileName: file.name, dataBase64: await readAsBase64(file) } : undefined;
      const body = { file: filePayload, importantMessage: message.trim() ? message : null };
      const saved =
        editing && report
          ? await msiApi.update(report.id, body, setProgress)
          : await msiApi.submit(body, setProgress);
      applyReport(saved);
      setEditing(false);
      resetForm();
      toast.success(editing ? "✓ Report updated" : "✓ Report Submitted Successfully");
    } catch (e) {
      const err = e as ApiError & { code?: string };
      if (err.code === "ALREADY_SUBMITTED") {
        // Submitted from another window/device — show what's on file.
        await queryClient.invalidateQueries({ queryKey: ["msi"] });
        toast.info("Today's report was already submitted. You can update it below.");
        resetForm();
      } else {
        setFormError(friendlyError(e));
      }
    } finally {
      setProgress(null);
    }
  };

  const withdraw = async () => {
    if (!report || !confirm("Withdraw today's report? You can submit a new one afterwards.")) return;
    setWithdrawing(true);
    try {
      await msiApi.withdraw(report.id);
      applyReport(null);
      setEditing(false);
      resetForm();
      toast.success("Report withdrawn");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setWithdrawing(false);
    }
  };

  const download = async (r: MsiReport) => {
    setDownloading(true);
    try {
      await msiApi.download(r);
    } catch {
      toast.error("This report file is no longer available.");
    } finally {
      setDownloading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="animate-spin w-6 h-6 text-muted-foreground" />
      </div>
    );
  }
  if (!isAuthenticated) return null;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header — same look as the mail view's header */}
      <header className="border-b bg-card shrink-0">
        <div className="max-w-full px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center">
              <Mail className="text-primary-foreground w-4 h-4" />
            </div>
            <h1 className="text-lg font-semibold">MailPilot AI</h1>
          </div>
          <div className="flex items-center gap-2">
            {user?.email.includes("@") && (
              <Link href="/" className="sm:hidden text-sm text-primary underline-offset-2 hover:underline">
                Back to Mail
              </Link>
            )}
            <span className="text-sm text-muted-foreground">{user?.name}</span>
            <Button variant="ghost" size="sm" onClick={logout} title="Sign out">
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <ModuleRail />

        <main className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-5">
            {/* Title */}
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
                <ClipboardList className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-xl font-semibold tracking-tight">My MIS</h2>
                <p className="text-sm text-muted-foreground">
                  {!data ? "Loading…" : hasMis ? "Checked automatically from your MIS spreadsheet" : <>Today's Report · {formatLongDate(data.reportDate)}</>}
                </p>
              </div>
            </div>

            {today.isError && (
              <Card className="p-4 border-destructive/40 bg-destructive/5 text-sm flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-destructive" />
                Couldn't load your report status. Please check your connection and try again.
                <Button size="sm" variant="outline" className="ml-auto" onClick={() => today.refetch()}>
                  Retry
                </Button>
              </Card>
            )}

            {today.isLoading && (
              <Card className="p-8 flex justify-center">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </Card>
            )}

            {hasMis && circle.data?.row && <CircleCard data={circle.data} />}

            {hasMis && (
              <MisDaysPanel
                days={data!.misDays!}
                tz={tz}
                onUpdate={(misDays) => {
                  queryClient.setQueryData<MsiToday>(["msi", "today"], (old) => (old ? { ...old, misDays } : old));
                  queryClient.invalidateQueries({ queryKey: ["mis", "circle"] });
                }}
              />
            )}

            {hasMis && (
              <h3 className="pt-2 font-semibold">Optional: upload a file with an important message for management</h3>
            )}

            {/* Status */}
            {data && (report || !hasMis) && (
              report ? (
                <Card className="p-5 border-green-200 bg-green-50/70 dark:bg-green-950/20 dark:border-green-900">
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-full bg-green-500 text-white flex items-center justify-center shrink-0 shadow-sm">
                      <CheckCircle className="w-7 h-7" />
                    </div>
                    <div className="flex-1 min-w-0 space-y-2">
                      <div>
                        <p className="text-lg font-semibold text-green-700 dark:text-green-400">
                          {hasMis ? "✓ Sent to management" : "✓ Daily Report Submitted"}
                        </p>
                        <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                          <Clock className="w-3.5 h-3.5" />
                          Submitted at {formatTime(report.submittedAt, tz)}
                          {report.updatedAt !== report.submittedAt &&
                            new Date(report.updatedAt).getTime() - new Date(report.submittedAt).getTime() > 1000 && (
                              <> · updated {formatTime(report.updatedAt, tz)}</>
                            )}
                        </p>
                      </div>
                      <button
                        onClick={() => download(report)}
                        disabled={downloading}
                        className="flex items-center gap-2 text-sm font-medium hover:underline text-left max-w-full"
                        title="Download your submitted file"
                      >
                        <FileText className="w-4 h-4 text-green-700 shrink-0" />
                        <span className="truncate">{report.fileName}</span>
                        <span className="text-muted-foreground font-normal shrink-0">({formatSize(report.fileSize)})</span>
                        {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5 shrink-0" />}
                      </button>
                      {report.importantMessage && (
                        <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900 px-3 py-2">
                          <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 flex items-center gap-1 mb-1">
                            <AlertTriangle className="w-3.5 h-3.5" /> Important Message
                          </p>
                          <p className="text-sm whitespace-pre-wrap break-words">"{report.importantMessage}"</p>
                        </div>
                      )}
                      {!editing && (
                        <div className="flex flex-wrap gap-2 pt-1">
                          <Button size="sm" onClick={startEdit} className="gap-1.5">
                            <Pencil className="w-3.5 h-3.5" /> Update Report
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={withdraw}
                            disabled={withdrawing}
                            className="gap-1.5 text-muted-foreground hover:text-destructive"
                          >
                            {withdrawing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                            Withdraw
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </Card>
              ) : (
                <Card className="p-5 border-red-200 bg-red-50/70 dark:bg-red-950/20 dark:border-red-900">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-full bg-red-500 text-white flex items-center justify-center shrink-0 shadow-sm">
                      <AlertCircle className="w-7 h-7" />
                    </div>
                    <div>
                      <p className="text-lg font-semibold text-red-700 dark:text-red-400">⚠ Daily Report Not Submitted</p>
                      <p className="text-sm text-muted-foreground">Upload today's work report below and submit it.</p>
                    </div>
                  </div>
                </Card>
              )
            )}

            {/* Upload form */}
            {data && showForm && (
              <Card className="p-5 space-y-5">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">
                    {editing ? "Update" : hasMis ? "Send a file or message" : "Submit Today's Report"}
                  </h3>
                  {editing && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(false);
                        resetForm();
                      }}
                      disabled={uploading}
                    >
                      <X className="w-4 h-4 mr-1" /> Cancel
                    </Button>
                  )}
                </div>

                {/* File */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">Daily Work Report</label>
                  <div
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (!uploading) pickFile(e.dataTransfer.files?.[0] ?? null);
                    }}
                    className={`rounded-lg border-2 border-dashed p-4 flex flex-col sm:flex-row sm:items-center gap-3 ${
                      fileError ? "border-destructive/60 bg-destructive/5" : "border-border bg-muted/30"
                    }`}
                  >
                    <input
                      ref={fileInput}
                      type="file"
                      className="hidden"
                      accept={rules?.allowedExtensions.map((e) => `.${e}`).join(",")}
                      onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                    />
                    <Button type="button" variant="outline" onClick={() => fileInput.current?.click()} disabled={uploading} className="gap-1.5 shrink-0">
                      <Upload className="w-4 h-4" /> Choose File
                    </Button>
                    <div className="min-w-0 text-sm">
                      {file ? (
                        <p className="flex items-center gap-1.5">
                          <span className="text-muted-foreground">Selected:</span>
                          <span className="font-medium truncate">{file.name}</span>
                          <span className="text-muted-foreground shrink-0">({formatSize(file.size)})</span>
                        </p>
                      ) : editing && report ? (
                        <p className="text-muted-foreground">
                          Keeping current file <span className="font-medium text-foreground">{report.fileName}</span> — choose a file only to replace it.
                        </p>
                      ) : (
                        <p className="text-muted-foreground">No file selected — or drag &amp; drop it here.</p>
                      )}
                      {rules && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          PDF, Word, Excel, PowerPoint, CSV, TXT and similar · max {formatSize(rules.maxFileBytes)}
                        </p>
                      )}
                    </div>
                  </div>
                  {fileError && (
                    <p className="text-sm text-destructive flex items-center gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5" /> {fileError}
                    </p>
                  )}
                </div>

                {/* Important message — stored separately, shown prominently to the CEO */}
                <div className="space-y-2">
                  <label htmlFor="msi-message" className="text-sm font-medium flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4 text-amber-500" /> Important Message / Update for CEO
                    <span className="text-muted-foreground font-normal">(optional)</span>
                  </label>
                  <Textarea
                    id="msi-message"
                    value={message}
                    onChange={(e) => setMessage(e.target.value.slice(0, rules?.maxMessageChars ?? 2000))}
                    placeholder="Client issue, urgent task, delay, achievement, pending work, escalation — anything management should know."
                    className="min-h-28"
                    disabled={uploading}
                  />
                  <p className="text-xs text-muted-foreground text-right">
                    {message.length}/{rules?.maxMessageChars ?? 2000}
                  </p>
                </div>

                {uploading && (
                  <div className="space-y-1.5">
                    <p className="text-sm text-muted-foreground flex items-center gap-2">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> Uploading… {progress}%
                    </p>
                    <Progress value={progress ?? 0} />
                  </div>
                )}

                {formError && (
                  <p className="text-sm text-destructive flex items-center gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5" /> {formError}
                  </p>
                )}

                <Button onClick={submit} disabled={uploading} className="w-full sm:w-auto gap-1.5">
                  {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                  {editing ? "Save Changes" : "Submit Daily Report"}
                </Button>
              </Card>
            )}

            {/* Recent reports — deliberately tiny: MIS data only lives 2 days */}
            <Card className="p-5">
              <h3 className="font-semibold flex items-center gap-2 mb-3">
                <History className="w-4 h-4 text-muted-foreground" /> Recent Reports
              </h3>
              <div className="divide-y">
                {(recent.data?.days ?? []).map((d) => (
                  <div key={d.date} className="py-2.5 flex items-center justify-between gap-3 text-sm">
                    <div>
                      <span className="font-medium">{d.label}</span>
                      <span className="text-muted-foreground"> · {formatLongDate(d.date)}</span>
                    </div>
                    {d.submitted ? (
                      <span className="flex items-center gap-1 text-green-700 dark:text-green-400 font-medium">
                        <CheckCircle className="w-4 h-4" /> Submitted
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <AlertCircle className="w-4 h-4" /> Not submitted
                      </span>
                    )}
                  </div>
                ))}
                <div className="py-2.5 flex items-center justify-between gap-3 text-sm text-muted-foreground">
                  <span>Older than {recent.data?.retentionDays ?? 2} days</span>
                  <span className="italic">Automatically removed</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-3">
                MIS reports are temporary: each report, file and message is deleted automatically 2 days after its date.
              </p>
            </Card>
          </div>
        </main>
      </div>
    </div>
  );
}
