import { useAuth } from "@/_core/hooks/useAuth";
import { AIInsightsPanel } from "@/components/AIInsightsPanel";
import { EmailBody } from "@/components/EmailBody";
import { AttachmentList } from "@/components/AttachmentList";
import { SettingsDialog } from "@/components/SettingsDialog";
import { ImapConnectDialog } from "@/components/ImapConnectDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { gmailApi, emailsApi, ApiError, type EmailRecord } from "@/lib/api";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Mail, LogOut, Loader2, RefreshCw, Inbox,
  Eye, EyeOff, Send, MessageSquare, MessageSquareOff,
  CheckCircle, AlertCircle, User, X, PlusCircle,
  Star, Trash2, Reply, CornerUpLeft, Search, Tag, Settings, Paperclip, ChevronDown, ChevronUp, Mails, ArrowLeft
} from "lucide-react";
import { useState, useEffect } from "react";
import { toast } from "sonner";

type FilterType = "all" | "unread" | "read" | "replied" | "unreplied" | "sent" | "promotions";

const FILTERS: { key: FilterType; label: string; icon: React.ReactNode }[] = [
  { key: "all", label: "All", icon: <Inbox className="w-3.5 h-3.5" /> },
  { key: "unread", label: "Unread", icon: <EyeOff className="w-3.5 h-3.5" /> },
  { key: "read", label: "Read", icon: <Eye className="w-3.5 h-3.5" /> },
  { key: "unreplied", label: "Unreplied", icon: <MessageSquareOff className="w-3.5 h-3.5" /> },
  { key: "replied", label: "Replied", icon: <MessageSquare className="w-3.5 h-3.5" /> },
  { key: "sent", label: "Sent", icon: <Send className="w-3.5 h-3.5" /> },
  { key: "promotions", label: "Promotions", icon: <Tag className="w-3.5 h-3.5" /> },
];

function formatDate(date: Date | string | null) {
  if (!date) return "";
  const d = new Date(date);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function Home() {
  const { user, loading, isAuthenticated, logout } = useAuth({ redirectOnUnauthenticated: true });
  const [filter, setFilter] = useState<FilterType>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [manualForm, setManualForm] = useState({ subject: "", from: "", body: "" });
  const [savingManual, setSavingManual] = useState(false);
  const [showReply, setShowReply] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [imapOpen, setImapOpen] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("error") === "google_not_configured") {
      setSettingsOpen(true);
      toast.info("Gmail OAuth isn't configured for this company yet. Contact your admin.");
      window.history.replaceState({}, "", window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [replyBody, setReplyBody] = useState("");
  const [sendingReply, setSendingReply] = useState(false);
  const [replyAttachments, setReplyAttachments] = useState<{ filename: string; mimeType: string; data: string; size: number }[]>([]);

  const queryClient = useQueryClient();

  const gmailStatus = useQuery({
    queryKey: ["gmail", "status"],
    queryFn: gmailApi.status,
    enabled: isAuthenticated,
  });
  const isConnected = gmailStatus.data?.connected;
  const googleConfigured = gmailStatus.data?.googleConfigured ?? true; // assume true until loaded, to avoid a flash
  // Conditional Sending: assume true until the status query resolves, same
  // "avoid a flash" reasoning as googleConfigured above — the reply box
  // still hides once gmailStatus.data lands, this just avoids it flickering
  // on for connected Gmail users on every page load.
  const canSend = gmailStatus.data?.canSend ?? true;
  const sendDisabledMessage = gmailStatus.data?.sendDisabledMessage ?? null;

  const emails = useQuery({
    queryKey: ["emails", filter, search.trim()],
    queryFn: () => emailsApi.list({ filter, search: search.trim() || undefined }),
    enabled: isAuthenticated && isConnected === true,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["emails"] });
  };

  /**
   * Detects Gmail scope errors so we can prompt the user to reconnect
   * instead of showing a generic failure message. This happens when the
   * stored access/refresh token was issued before gmail.modify / gmail.send
   * scopes were requested (e.g. an older connection).
   */
  const isScopeError = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    return msg.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") || msg.includes("insufficient authentication scopes") || msg.includes("403");
  };

  const disconnectMutation = useMutation({
    mutationFn: gmailApi.disconnect,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gmail", "status"] });
      queryClient.invalidateQueries({ queryKey: ["emails"] });
      setSelectedId(null);
    },
  });

  const handleReconnect = async () => {
    try {
      await disconnectMutation.mutateAsync();
    } finally {
      gmailApi.connectAndRedirect().catch(() => toast.error("Couldn't start Gmail connection. Try again."));
    }
  };

  const showScopeAwareError = (e: unknown, fallback: string) => {
    if (isScopeError(e)) {
      toast.error("Gmail permissions are out of date.", {
        description: "Your Gmail connection needs to be refreshed to allow this action.",
        action: { label: "Reconnect", onClick: handleReconnect },
        duration: 10000,
      });
    } else {
      toast.error(e instanceof ApiError ? e.message : fallback);
    }
  };

  const syncMutation = useMutation({
    mutationFn: emailsApi.sync,
    onSuccess: (d) => {
      // Nothing new came in (common on the fast path, or a background
      // tick with no new mail) — invalidate so flag changes still show up,
      // but skip the toast so "Sync" doesn't feel noisy for a no-op.
      if (d.synced > 0) toast.success(`Synced ${d.synced} emails`);
      invalidate();
    },
    onError: (e) => showScopeAwareError(e, "Sync failed"),
  });
  const patchMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { isRead?: boolean; isStarred?: boolean; isTrashed?: boolean } }) =>
      emailsApi.patch(id, data),
    onSuccess: invalidate,
    onError: (e) => showScopeAwareError(e, "Failed to update email"),
  });
  const sendReplyMutation = useMutation({
    mutationFn: (vars: { id: string; body: string; attachments: { filename: string; mimeType: string; data: string }[] }) =>
      emailsApi.reply(vars.id, { body: vars.body, attachments: vars.attachments }),
    onSuccess: () => {
      toast.success("Reply sent!");
      setShowReply(false);
      setReplyBody("");
      invalidate();
      syncMutation.mutate();
    },
    onError: (e) => showScopeAwareError(e, `Failed to send reply`),
  });
  const saveManual = useMutation({ mutationFn: emailsApi.saveManual });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("synced") === "1") {
      toast.success("Gmail connected! Emails synced.");
      window.history.replaceState({}, "", "/");
      queryClient.invalidateQueries({ queryKey: ["gmail", "status"] });
      invalidate();
    }
    if (params.get("error") === "gmail_auth_failed") {
      toast.error("Gmail connection failed. Please try again.");
      window.history.replaceState({}, "", "/");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the inbox fresh in the background instead of relying on the user
  // to keep hitting "Sync". A background tick failing on a flaky connection
  // shouldn't interrupt someone who isn't even looking at the app, so
  // failures are swallowed here and it naturally recovers on the next tick.
  useEffect(() => {
    if (!isConnected) return;
    const interval = setInterval(() => {
      if (syncMutation.isPending) return;
      emailsApi
        .sync()
        .then((d) => { if (d.synced > 0) invalidate(); })
        .catch((e) => console.warn("[MailPilot] Background sync skipped:", e));
    }, 45_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected]);

  const handleSync = async () => {
    setSyncing(true);
    try { await syncMutation.mutateAsync(); }
    finally { setSyncing(false); }
  };

  const handleImapSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ["gmail", "status"] });
    toast.success("Email connected! Syncing your inbox…");
    handleSync();
  };

  const handleSelectEmail = (id: string, isRead: boolean) => {
    // Push a history entry so the device/browser back button (and the
    // in-app Back button on mobile, which just calls history.back()) closes
    // the open email and returns to the list instead of leaving the app.
    if (!selectedId) window.history.pushState({ mailpilotView: "email" }, "");
    setSelectedId(id);
    setShowManual(false);
    setShowReply(false);
    setReplyBody("");
    setReplyAttachments([]);
    if (!isRead) {
      patchMutation.mutate({ id, data: { isRead: true } });
    }
  };

  // Let the browser/device Back button close an open email or the "paste
  // email" form and return to the list, rather than navigating away from
  // the app entirely (the previous behavior, since neither view had its own
  // route or way back).
  useEffect(() => {
    const onPopState = () => {
      setSelectedId(null);
      setShowManual(false);
      setShowReply(false);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const selectedListItem: EmailRecord | null = emails.data?.find((e) => e.id === selectedId) ?? null;

  // The list endpoint (GET /api/emails) omits attachments to keep the inbox
  // payload light; fetch the full record (GET /api/emails/:id) once an
  // email is opened. Falls back to the list item so the header/body render
  // instantly while attachments arrive a beat later.
  const selectedEmailDetail = useQuery({
    queryKey: ["emails", selectedId, "detail"],
    queryFn: () => emailsApi.get(selectedId!),
    enabled: !!selectedId,
  });

  const selectedEmail: EmailRecord | null = selectedEmailDetail.data ?? selectedListItem;

  // Other messages sharing this email's threadId (same mailbox), oldest
  // first. Only fetched once an email with a threadId is open; a single-
  // message "thread" of length 1 renders nothing extra.
  const [threadOpen, setThreadOpen] = useState(false);
  const threadQuery = useQuery({
    queryKey: ["emails", selectedEmail?.id, "thread"],
    queryFn: () => emailsApi.thread(selectedEmail!.id),
    enabled: !!selectedEmail?.id && !!selectedEmail?.threadId,
  });
  const threadMessages = (threadQuery.data ?? []).filter((m) => m.id !== selectedEmail?.id);

  const MAX_ATTACHMENT_MB = 20;

  const handleAttachFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const totalExisting = replyAttachments.reduce((sum, a) => sum + a.size, 0);
    const incoming = Array.from(files);
    const incomingTotal = incoming.reduce((sum, f) => sum + f.size, 0);
    if (totalExisting + incomingTotal > MAX_ATTACHMENT_MB * 1024 * 1024) {
      toast.error(`Attachments can't exceed ${MAX_ATTACHMENT_MB}MB total`);
      return;
    }
    const read = (file: File) => new Promise<{ filename: string; mimeType: string; data: string; size: number }>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        resolve({ filename: file.name, mimeType: file.type || "application/octet-stream", data: result.split(",")[1] ?? "", size: file.size });
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    try {
      const parsed = await Promise.all(incoming.map(read));
      setReplyAttachments(prev => [...prev, ...parsed]);
    } catch {
      toast.error("Failed to read one or more files");
    }
  };

  const handleSendReply = async () => {
    if (!selectedEmail || (!replyBody.trim() && replyAttachments.length === 0)) return;
    setSendingReply(true);
    try {
      await sendReplyMutation.mutateAsync({
        id: selectedEmail.id,
        body: replyBody,
        attachments: replyAttachments.map(({ filename, mimeType, data }) => ({ filename, mimeType, data })),
      });
      setReplyAttachments([]);
    } finally { setSendingReply(false); }
  };

  const handleSaveManual = async () => {
    if (!manualForm.body.trim() && !manualForm.subject.trim()) return;
    setSavingManual(true);
    try {
      const email = await saveManual.mutateAsync({ subject: manualForm.subject, fromAddress: manualForm.from, bodyText: manualForm.body });
      setManualForm({ subject: "", from: "", body: "" });
      setShowManual(false);
      setSelectedId(email.id);
      invalidate();
      toast.success("Email saved");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to save email");
    } finally { setSavingManual(false); }
  };

  if (loading) return <div className="min-h-screen flex items-center justify-center"><Loader2 className="animate-spin w-6 h-6 text-muted-foreground" /></div>;
  if (!isAuthenticated) return null;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b bg-card shrink-0">
        <div className="max-w-full px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center">
              <Mail className="text-primary-foreground w-4 h-4" />
            </div>
            <h1 className="text-lg font-semibold">MailPilot AI</h1>
          </div>
          <div className="flex items-center gap-2">
            {isConnected ? (
              <>
                <div className="flex items-center gap-1.5 text-xs text-green-600 bg-green-50 px-2 py-1 rounded-full border border-green-200">
                  <CheckCircle className="w-3 h-3" />
                  <span className="hidden sm:block">{gmailStatus.data?.email} ({gmailStatus.data?.provider})</span>
                  <span className="sm:hidden">Connected</span>
                </div>
                <Button size="sm" variant="outline" onClick={handleSync} disabled={syncing}>
                  <RefreshCw className={`w-3.5 h-3.5 mr-1 ${syncing ? "animate-spin" : ""}`} />
                  Sync
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    if (confirm(`Disconnect ${gmailStatus.data?.provider === 'gmail' ? 'Gmail' : 'Email'}?`)) {
                      disconnectMutation.mutate();
                    }
                  }}
                  disabled={disconnectMutation.isPending}
                >
                  {disconnectMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Disconnect"}
                </Button>
              </>
            ) : (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setImapOpen(true)}>
                  <Mail className="w-3.5 h-3.5" /> Connect Any Email
                </Button>
                {googleConfigured ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => gmailApi.connectAndRedirect().catch(() => toast.error("Couldn't start Gmail connection."))}
                  >
                    <Mail className="w-3.5 h-3.5" /> Connect Gmail
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setSettingsOpen(true)}>
                    <Mail className="w-3.5 h-3.5" /> Set Up Gmail
                  </Button>
                )}
              </div>
            )}
            <span className="text-sm text-muted-foreground hidden sm:block">{user?.name}</span>
            <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)} title="Settings">
              <Settings className="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={logout}><LogOut className="w-4 h-4" /></Button>
          </div>
        </div>
      </header>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <ImapConnectDialog open={imapOpen} onOpenChange={setImapOpen} onSuccess={handleImapSuccess} />

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar — on mobile this is the only pane shown until an email
            (or the paste-email form) is opened, at which point it's hidden
            in favor of the detail pane's Back button; both panes show
            side-by-side from md breakpoint up regardless of selection. */}
        <div className={`${selectedEmail || showManual ? "hidden md:flex" : "flex"} w-full md:w-80 shrink-0 border-r flex-col bg-card`}>
          <div className="p-3 border-b">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search mail..."
                className="w-full pl-8 pr-7 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
          <div className="p-3 border-b flex flex-wrap gap-1.5">
            {FILTERS.map(f => (
              <button key={f.key} onClick={() => setFilter(f.key)}
                className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border transition-colors ${filter === f.key ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-accent border-border"}`}>
                {f.icon}{f.label}
              </button>
            ))}
          </div>

          {!isConnected && (
            <div className="px-3 pt-3">
              <Button size="sm" className="w-full gap-2" onClick={() => { window.history.pushState({ mailpilotView: "manual" }, ""); setShowManual(true); }}>
                <PlusCircle className="w-4 h-4" /> Paste Email Manually
              </Button>
            </div>
          )}

          <div className="flex-1 overflow-y-auto">
            {!isConnected ? (
              <div className="flex flex-col items-center justify-center h-48 text-center px-6 gap-3">
                <AlertCircle className="w-8 h-8 text-muted-foreground opacity-40" />
                <p className="text-sm text-muted-foreground">Connect an email account to see your messages.</p>
                <div className="flex flex-col gap-2 w-full px-4">
                  <Button size="sm" onClick={() => setImapOpen(true)}>Connect Any Email (IMAP)</Button>
                  {googleConfigured ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full"
                      onClick={() => gmailApi.connectAndRedirect().catch(() => toast.error("Couldn't start Gmail connection."))}
                    >
                      Connect Gmail
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>Set Up Gmail OAuth</Button>
                  )}
                </div>
              </div>
            ) : emails.isLoading ? (
              <div className="flex justify-center py-10"><Loader2 className="animate-spin w-5 h-5 text-muted-foreground" /></div>
            ) : !emails.data?.length ? (
              <div className="flex flex-col items-center justify-center h-48 text-muted-foreground text-sm gap-2">
                <Inbox className="w-8 h-8 opacity-20" />
                {search ? `No results for "${search}"` : "No emails in this view"}
              </div>
            ) : (
              emails.data.map(email => (
                <button key={email.id} onClick={() => handleSelectEmail(email.id, email.isRead)}
                  className={`w-full text-left px-4 py-3 border-b hover:bg-accent transition-colors ${selectedId === email.id ? "bg-accent border-l-2 border-l-primary" : ""}`}>
                  <div className="flex items-start justify-between gap-2">
                    <p className={`text-sm truncate flex-1 ${!email.isRead ? "font-semibold" : "font-normal"}`}>
                      {email.fromName || email.fromAddress || "Unknown"}
                    </p>
                    <span className="text-xs text-muted-foreground shrink-0">{formatDate(email.receivedAt)}</span>
                  </div>
                  <p className={`text-xs truncate mt-0.5 ${!email.isRead ? "font-medium text-foreground" : "text-muted-foreground"}`}>
                    {email.subject || "(No subject)"}
                  </p>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">{email.snippet}</p>
                  <div className="flex items-center gap-1 mt-1">
                    {!email.isRead && <span className="w-1.5 h-1.5 rounded-full bg-primary inline-block" />}
                    {email.isStarred && <span className="text-yellow-500 text-xs">★</span>}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Main content */}
        <div className={`${selectedEmail || showManual ? "flex" : "hidden md:flex"} flex-1 overflow-y-auto bg-background flex-col`}>
          {showManual ? (
            <div className="max-w-2xl mx-auto p-6">
              <Card className="p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => window.history.back()}
                      className="md:hidden -ml-1 p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                      aria-label="Back">
                      <ArrowLeft className="w-4 h-4" />
                    </button>
                    <h2 className="font-semibold text-lg">Paste Email</h2>
                  </div>
                  <button onClick={() => setShowManual(false)}><X className="w-4 h-4 text-muted-foreground" /></button>
                </div>
                <div className="space-y-3">
                  <div><label className="text-sm font-medium">From</label>
                    <input type="text" value={manualForm.from} onChange={e => setManualForm(f => ({ ...f, from: e.target.value }))}
                      placeholder="sender@example.com" className="w-full mt-1 px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary" /></div>
                  <div><label className="text-sm font-medium">Subject</label>
                    <input type="text" value={manualForm.subject} onChange={e => setManualForm(f => ({ ...f, subject: e.target.value }))}
                      placeholder="Email subject" className="w-full mt-1 px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary" /></div>
                  <div><label className="text-sm font-medium">Body</label>
                    <textarea value={manualForm.body} onChange={e => setManualForm(f => ({ ...f, body: e.target.value }))}
                      placeholder="Paste email content here..." rows={10}
                      className="w-full mt-1 px-3 py-2 rounded-md border bg-background text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary" /></div>
                </div>
                <div className="flex gap-2">
                  <Button onClick={handleSaveManual} disabled={savingManual}>
                    {savingManual ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</> : "Save & Analyze"}
                  </Button>
                  <Button variant="outline" onClick={() => setShowManual(false)}>Cancel</Button>
                </div>
              </Card>
            </div>
          ) : selectedEmail ? (
            <div className="grid grid-cols-1 lg:grid-cols-5 h-full">
              {/* Email */}
              <div className="lg:col-span-3 p-6 overflow-y-auto border-r space-y-4">
                {/* Action bar */}
                <div className="flex items-center gap-2 pb-2 border-b flex-wrap">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="md:hidden gap-1"
                    onClick={() => window.history.back()}>
                    <ArrowLeft className="w-3.5 h-3.5" /> Back
                  </Button>
                  {canSend ? (
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setShowReply(v => !v)}>
                      <CornerUpLeft className="w-3.5 h-3.5" /> Reply
                    </Button>
                  ) : (
                    <p className="text-xs text-muted-foreground italic max-w-md">
                      {sendDisabledMessage}
                    </p>
                  )}
                  <Button size="sm" variant="outline" className="gap-1.5"
                    onClick={() => patchMutation.mutate({ id: selectedEmail.id, data: { isRead: !selectedEmail.isRead } })}>
                    {selectedEmail.isRead ? <><EyeOff className="w-3.5 h-3.5" />Mark Unread</> : <><Eye className="w-3.5 h-3.5" />Mark Read</>}
                  </Button>
                  <Button size="sm" variant="outline" className="gap-1.5"
                    onClick={() => patchMutation.mutate({ id: selectedEmail.id, data: { isStarred: !selectedEmail.isStarred } })}>
                    <Star className={`w-3.5 h-3.5 ${selectedEmail.isStarred ? "fill-yellow-400 text-yellow-400" : ""}`} />
                    {selectedEmail.isStarred ? "Unstar" : "Star"}
                  </Button>
                  <Button size="sm" variant="outline" className="gap-1.5 text-destructive hover:text-destructive"
                    onClick={() => {
                      if (confirm("Move to trash?")) {
                        patchMutation.mutate({ id: selectedEmail.id, data: { isTrashed: true } });
                        toast.success("Moved to trash");
                        setSelectedId(null);
                      }
                    }}>
                    <Trash2 className="w-3.5 h-3.5" /> Trash
                  </Button>
                </div>

                {/* Email header */}
                <div className="border-b pb-4">
                  <h2 className="text-xl font-bold mb-3">{selectedEmail.subject || "(No subject)"}</h2>
                  <div className="space-y-1 text-sm">
                    <p><span className="text-muted-foreground">From:</span> {selectedEmail.fromName ? `${selectedEmail.fromName} <${selectedEmail.fromAddress}>` : selectedEmail.fromAddress}</p>
                    {selectedEmail.toAddresses && (
                      <p><span className="text-muted-foreground">To:</span> {(() => { try { return JSON.parse(selectedEmail.toAddresses!).join(", "); } catch { return selectedEmail.toAddresses; } })()}</p>
                    )}
                    <p><span className="text-muted-foreground">Date:</span> {selectedEmail.receivedAt ? new Date(selectedEmail.receivedAt).toLocaleString() : ""}</p>
                    <div className="flex gap-2 mt-2">
                      {!selectedEmail.isRead && <Badge variant="secondary">Unread</Badge>}
                      {selectedEmail.isStarred && <Badge variant="secondary">⭐ Starred</Badge>}
                    </div>
                  </div>
                </div>

                {threadMessages.length > 0 && (
                  <div className="border rounded-lg overflow-hidden">
                    <button
                      className="w-full flex items-center justify-between px-3 py-2 text-sm text-muted-foreground hover:bg-muted/50 transition-colors"
                      onClick={() => setThreadOpen((v) => !v)}>
                      <span className="flex items-center gap-2">
                        <Mails className="w-3.5 h-3.5" />
                        {threadMessages.length} earlier {threadMessages.length === 1 ? "message" : "messages"} in this thread
                      </span>
                      {threadOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                    {threadOpen && (
                      <div className="divide-y">
                        {threadMessages.map((m) => (
                          <button
                            key={m.id}
                            onClick={() => setSelectedId(m.id)}
                            className="w-full text-left px-3 py-2 hover:bg-muted/50 transition-colors">
                            <div className="flex items-center justify-between text-sm">
                              <span className="font-medium truncate">{m.fromName || m.fromAddress}</span>
                              <span className="text-xs text-muted-foreground shrink-0 ml-2">{formatDate(m.receivedAt)}</span>
                            </div>
                            <p className="text-xs text-muted-foreground truncate mt-0.5">{m.snippet || m.subject}</p>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <EmailBody bodyHtml={null} bodyText={selectedEmail.bodyText} snippet={selectedEmail.snippet} />
                <AttachmentList emailId={selectedEmail.id} attachments={selectedEmail.attachments} />

                {/* Reply box */}
                {showReply && canSend && (
                  <Card className="p-4 space-y-3 border-primary">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium flex items-center gap-2">
                        <Reply className="w-4 h-4" />
                        Replying to {selectedEmail.fromName || selectedEmail.fromAddress}
                      </p>
                      <button onClick={() => setShowReply(false)}><X className="w-4 h-4 text-muted-foreground" /></button>
                    </div>
                    <textarea
                      value={replyBody}
                      onChange={e => setReplyBody(e.target.value)}
                      placeholder="Write your reply..."
                      rows={6}
                      className="w-full px-3 py-2 rounded-md border bg-background text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                    {replyAttachments.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {replyAttachments.map((att, i) => (
                          <div key={`${att.filename}-${i}`} className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border bg-muted/40 text-xs max-w-[200px]">
                            <Paperclip className="w-3 h-3 shrink-0 text-muted-foreground" />
                            <span className="truncate">{att.filename}</span>
                            <button onClick={() => setReplyAttachments(prev => prev.filter((_, idx) => idx !== i))}>
                              <X className="w-3 h-3 text-muted-foreground hover:text-foreground" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <Button onClick={handleSendReply} disabled={sendingReply || (!replyBody.trim() && replyAttachments.length === 0)}>
                        {sendingReply ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending…</> : <><Send className="w-4 h-4 mr-2" />Send Reply</>}
                      </Button>
                      <Button variant="outline" size="icon" asChild>
                        <label className="cursor-pointer" title="Attach files">
                          <Paperclip className="w-4 h-4" />
                          <input
                            type="file"
                            multiple
                            className="hidden"
                            onChange={e => { handleAttachFiles(e.target.files); e.target.value = ""; }}
                          />
                        </label>
                      </Button>
                      <Button variant="outline" onClick={() => {
                        // Use AI suggested reply if available
                        const aiReply = document.querySelector('[data-suggested-reply]')?.textContent;
                        if (aiReply) setReplyBody(aiReply);
                        else toast.info("Generate an AI reply first from the panel →");
                      }}>
                        Use AI Reply
                      </Button>
                      <Button variant="ghost" onClick={() => setShowReply(false)}>Cancel</Button>
                    </div>
                  </Card>
                )}
              </div>

              {/* AI Insights */}
              <div className="lg:col-span-2 p-6 overflow-y-auto">
                {selectedId && (
                  <AIInsightsPanel
                    messageId={selectedId}
                    canSend={canSend}
                    onSuggestedReplySelect={(reply) => {
                      setReplyBody(reply);
                      setShowReply(true);
                      toast.success("AI reply loaded — review and send!");
                    }}
                  />
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full min-h-64">
              <div className="text-center text-muted-foreground">
                <Mail className="w-12 h-12 mx-auto mb-3 opacity-20" />
                <p className="text-sm">{isConnected ? "Select an email to read it." : "Connect Gmail or paste an email to get started."}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
