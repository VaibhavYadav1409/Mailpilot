import { useQuery } from "@tanstack/react-query";
import { gmailApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { CheckCircle2, XCircle, Info } from "lucide-react";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * NOTE ON THIS COMPONENT: Project 2's original SettingsDialog let each
 * person paste their own Google OAuth client ID/secret and Groq API key,
 * stored per-browser — that's the right model for a single-user desktop
 * app, but wrong for MailPilot Enterprise: Gmail OAuth and the Groq key are
 * configured once, company-wide, as backend environment variables
 * (GOOGLE_CLIENT_ID/SECRET, GROQ_API_KEY — see backend/.env), and having
 * employees hold their own copies of those secrets would be a real
 * security regression in a multi-tenant deployment. This dialog is
 * therefore now a read-only status view instead of a credentials form.
 */
export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const gmailStatus = useQuery({
    queryKey: ["gmail", "status"],
    queryFn: gmailApi.status,
    enabled: open,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Connection status for your account.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border p-3 space-y-2">
            <p className="text-sm font-medium">Mailbox</p>
            {gmailStatus.data?.connected ? (
              <div className="flex items-center gap-2 text-sm text-green-700">
                <CheckCircle2 className="w-4 h-4" />
                <span>
                  Connected to {gmailStatus.data.email} via{" "}
                  {gmailStatus.data.provider === "gmail" ? "Gmail" : gmailStatus.data.provider === "imap" ? "IMAP" : "manual entry"}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <XCircle className="w-4 h-4" />
                <span>No mailbox connected yet — use "Connect Gmail" or "Connect Any Email" from the toolbar.</span>
              </div>
            )}
          </div>

          <div className="rounded-lg border p-3 space-y-2">
            <p className="text-sm font-medium">Gmail OAuth</p>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {gmailStatus.data?.googleConfigured ? (
                <>
                  <CheckCircle2 className="w-4 h-4 text-green-600" />
                  <span>Configured for your company.</span>
                </>
              ) : (
                <>
                  <Info className="w-4 h-4" />
                  <span>Not configured yet — ask your admin to set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET on the backend.</span>
                </>
              )}
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Gmail OAuth and the AI provider key are configured once for the whole company by your
            administrator, so there's nothing for you to enter here — this just reflects the current status.
          </p>
        </div>

        <div className="flex justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
