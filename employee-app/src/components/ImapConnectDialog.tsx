import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { imapApi, ApiError } from "@/lib/api";

interface ImapConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function ImapConnectDialog({ open, onOpenChange, onSuccess }: ImapConnectDialogProps) {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    email: "",
    imapHost: "",
    imapPort: "993",
    imapUser: "",
    imapPass: "",
    imapSecure: true,
    smtpHost: "",
    smtpPort: "465",
    smtpUser: "",
    smtpPass: "",
    smtpSecure: true,
  });
  const [showAdvanced, setShowAdvanced] = useState(false);

  const autoFillSettings = (email: string) => {
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain) return;

    let settings: Partial<typeof formData> = {
      imapUser: email,
      smtpUser: email,
    };

    if (domain === "farsightshares.com") {
      settings = {
        ...settings,
        imapHost: "webmail.nfcmail.io",
        imapPort: "993",
        smtpHost: "webmail.nfcmail.io",
        smtpPort: "465",
      };
    } else if (domain === "gmail.com") {
      settings = {
        ...settings,
        imapHost: "imap.gmail.com",
        imapPort: "993",
        smtpHost: "smtp.gmail.com",
        smtpPort: "465",
      };
    } else if (domain === "outlook.com" || domain === "hotmail.com") {
      settings = {
        ...settings,
        imapHost: "outlook.office365.com",
        imapPort: "993",
        smtpHost: "smtp.office365.com",
        smtpPort: "587",
        smtpSecure: false,
      };
    } else if (domain === "yahoo.com") {
      settings = {
        ...settings,
        imapHost: "imap.mail.yahoo.com",
        imapPort: "993",
        smtpHost: "smtp.mail.yahoo.com",
        smtpPort: "465",
      };
    } else {
      // Default guess
      settings = {
        ...settings,
        imapHost: `imap.${domain}`,
        smtpHost: `smtp.${domain}`,
      };
    }

    setFormData(prev => ({ ...prev, ...settings, email }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await imapApi.connect({
        ...formData,
        imapPort: Number(formData.imapPort),
        smtpPort: Number(formData.smtpPort),
      });
      toast.success("Connected successfully!");
      onSuccess();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to connect");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Connect via IMAP/SMTP</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Email Address</Label>
            <Input 
              value={formData.email} 
              onChange={e => autoFillSettings(e.target.value)} 
              placeholder="user@example.com" 
              required 
            />
          </div>

          <div className="space-y-2">
            <Label>Email Password</Label>
            <Input 
              type="password"
              value={formData.imapPass} 
              onChange={e => setFormData({ ...formData, imapPass: e.target.value, smtpPass: e.target.value })} 
              placeholder="Your email password" 
              required 
            />
            <p className="text-[10px] text-muted-foreground">This password is used for both reading and sending emails.</p>
          </div>

          <div className="pt-2">
            <Button 
              type="button" 
              variant="ghost" 
              size="sm" 
              className="text-xs text-muted-foreground h-7 px-2"
              onClick={() => setShowAdvanced(!showAdvanced)}
            >
              {showAdvanced ? "Hide Advanced Settings" : "Show Advanced Settings"}
            </Button>
          </div>
          
          {showAdvanced && (
            <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
              <div className="border-t pt-4">
                <h3 className="text-sm font-semibold mb-3">IMAP Settings (Incoming)</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Host</Label>
                    <Input 
                      value={formData.imapHost} 
                      onChange={e => setFormData({ ...formData, imapHost: e.target.value })} 
                      placeholder="imap.example.com" 
                      required 
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Port</Label>
                    <Input 
                      value={formData.imapPort} 
                      onChange={e => setFormData({ ...formData, imapPort: e.target.value })} 
                      placeholder="993" 
                      required 
                    />
                  </div>
                </div>
                <div className="space-y-2 mt-2">
                  <Label>Username</Label>
                  <Input 
                    value={formData.imapUser} 
                    onChange={e => setFormData({ ...formData, imapUser: e.target.value })} 
                    placeholder="Username" 
                    required 
                  />
                </div>
                <div className="flex items-center space-x-2 mt-3">
                  <Switch 
                    id="imap-secure" 
                    checked={formData.imapSecure} 
                    onCheckedChange={v => setFormData({ ...formData, imapSecure: v })} 
                  />
                  <Label htmlFor="imap-secure">Use SSL/TLS</Label>
                </div>
              </div>

              <div className="border-t pt-4">
                <h3 className="text-sm font-semibold mb-3">SMTP Settings (Outgoing)</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Host</Label>
                    <Input 
                      value={formData.smtpHost} 
                      onChange={e => setFormData({ ...formData, smtpHost: e.target.value })} 
                      placeholder="smtp.example.com" 
                      required 
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Port</Label>
                    <Input 
                      value={formData.smtpPort} 
                      onChange={e => setFormData({ ...formData, smtpPort: e.target.value })} 
                      placeholder="465" 
                      required 
                    />
                  </div>
                </div>
                <div className="space-y-2 mt-2">
                  <Label>Username</Label>
                  <Input 
                    value={formData.smtpUser} 
                    onChange={e => setFormData({ ...formData, smtpUser: e.target.value })} 
                    placeholder="Username" 
                    required 
                  />
                </div>
                <div className="flex items-center space-x-2 mt-3">
                  <Switch 
                    id="smtp-secure" 
                    checked={formData.smtpSecure} 
                    onCheckedChange={v => setFormData({ ...formData, smtpSecure: v })} 
                  />
                  <Label htmlFor="smtp-secure">Use SSL/TLS</Label>
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : "Connect Email"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
