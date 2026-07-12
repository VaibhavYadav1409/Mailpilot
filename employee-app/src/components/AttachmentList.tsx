import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Download, Loader2, Paperclip } from "lucide-react";
import { toast } from "sonner";
import { emailsApi, type AttachmentRecord } from "@/lib/api";

interface AttachmentListProps {
  emailId: string;
  attachments: AttachmentRecord[] | null | undefined;
}

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(mimeType: string | null | undefined): string {
  if (!mimeType) return "📎";
  if (mimeType.startsWith("image/")) return "🖼️";
  if (mimeType === "application/pdf") return "📄";
  if (mimeType.includes("word") || mimeType.includes("msword")) return "📝";
  if (mimeType.includes("excel") || mimeType.includes("spreadsheet")) return "📊";
  if (mimeType.includes("powerpoint") || mimeType.includes("presentation")) return "📊";
  if (mimeType.startsWith("text/")) return "📃";
  if (mimeType.includes("zip") || mimeType.includes("rar") || mimeType.includes("compress")) return "🗜️";
  return "📎";
}

/**
 * Renders inbound attachments for an email and downloads them via
 * GET /api/emails/:id/attachments/:attachmentId (see backend/src/lib/attachmentStorage.ts
 * for where the bytes actually live — local disk or S3). Previously this
 * component was a documented dead end: the backend didn't persist attachment
 * blobs at all, so `attachmentsJson` was always empty. Now attachments come
 * from the real `Attachment` relation on Email.
 */
export function AttachmentList({ emailId, attachments }: AttachmentListProps) {
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  if (!attachments || attachments.length === 0) return null;

  const handleDownload = async (att: AttachmentRecord) => {
    setDownloadingId(att.id);
    try {
      await emailsApi.downloadAttachment(emailId, att);
    } catch (e) {
      console.error("[Attachment]", e);
      toast.error("Failed to download attachment. Please try again.");
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <div className="mt-3 pt-3 border-t">
      <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
        <Paperclip className="w-3 h-3" />
        {attachments.length} attachment{attachments.length !== 1 ? "s" : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        {attachments.map((att) => {
          const isDownloading = downloadingId === att.id;
          return (
            <div
              key={att.id}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border bg-muted/40 hover:bg-muted/70 transition-colors max-w-xs"
            >
              <span className="text-base leading-none shrink-0">
                {fileIcon(att.mimeType)}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate">{att.filename}</p>
                {att.sizeBytes > 0 && (
                  <p className="text-xs text-muted-foreground">{formatSize(att.sizeBytes)}</p>
                )}
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 shrink-0"
                disabled={isDownloading}
                onClick={() => handleDownload(att)}
                title={`Download ${att.filename}`}
              >
                {isDownloading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
