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
  FileText,
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
import { ApiError, msiApi, type MsiReport, type MsiToday } from "@/lib/api";

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
            <Link href="/" className="sm:hidden text-sm text-primary underline-offset-2 hover:underline">
              Back to Mail
            </Link>
            <span className="text-sm text-muted-foreground hidden sm:block">{user?.name}</span>
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
                <h2 className="text-xl font-semibold tracking-tight">MSI Daily Work Report</h2>
                <p className="text-sm text-muted-foreground">
                  {data ? <>Today's Report · {formatLongDate(data.reportDate)}</> : "Loading…"}
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

            {/* Status */}
            {data && (
              report ? (
                <Card className="p-5 border-green-200 bg-green-50/70 dark:bg-green-950/20 dark:border-green-900">
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-full bg-green-500 text-white flex items-center justify-center shrink-0 shadow-sm">
                      <CheckCircle className="w-7 h-7" />
                    </div>
                    <div className="flex-1 min-w-0 space-y-2">
                      <div>
                        <p className="text-lg font-semibold text-green-700 dark:text-green-400">✓ Daily Report Submitted</p>
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
                  <h3 className="font-semibold">{editing ? "Update Today's Report" : "Submit Today's Report"}</h3>
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

            {/* Recent reports — deliberately tiny: MSI data only lives 2 days */}
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
                MSI reports are temporary: each report, file and message is deleted automatically 2 days after its date.
              </p>
            </Card>
          </div>
        </main>
      </div>
    </div>
  );
}
