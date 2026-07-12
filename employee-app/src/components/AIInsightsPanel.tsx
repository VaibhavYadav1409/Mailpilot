import { useState, useCallback } from "react";
import { emailsApi, ApiError } from "@/lib/api";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, Zap, MessageSquare, Loader2, RefreshCw, Copy } from "lucide-react";
import { toast } from "sonner";

interface AIInsightsPanelProps {
  messageId: string;
  onSuggestedReplySelect?: (reply: string) => void;
}

/**
 * AI Insights Panel Component
 * Displays AI-generated email analysis with collapsible sections
 * Features: summary, priority score, suggested reply
 * Accessibility: ARIA labels, keyboard navigation, screen reader support
 */
export function AIInsightsPanel({
  messageId,
  onSuggestedReplySelect,
}: AIInsightsPanelProps) {
  const [expandedSections, setExpandedSections] = useState({
    summary: true,
    priority: true,
    reply: true,
  });

  const queryClient = useQueryClient();

  // Fetch cached insights (GET /api/emails/:id/insights)
  const { data: insights, refetch: refetchInsights } = useQuery({
    queryKey: ["emails", messageId, "insights"],
    queryFn: () => emailsApi.insights(messageId),
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });

  const invalidateInsights = () => {
    queryClient.invalidateQueries({ queryKey: ["emails", messageId, "insights"] });
    refetchInsights();
  };

  // Mutations for generating insights
  const generateSummary = useMutation({
    mutationFn: (force: boolean) => emailsApi.generateSummary(messageId, force),
    onSuccess: invalidateInsights,
  });

  const generatePriority = useMutation({
    mutationFn: (force: boolean) => emailsApi.generatePriority(messageId, force),
    onSuccess: invalidateInsights,
  });

  const generateSuggestedReply = useMutation({
    mutationFn: (force: boolean) => emailsApi.generateSuggestedReply(messageId, force),
    onSuccess: invalidateInsights,
  });

  const isGenerating =
    generateSummary.isPending ||
    generatePriority.isPending ||
    generateSuggestedReply.isPending;

  const hasSummary = insights?.summary || generateSummary.data?.summary;
  const hasPriority =
    (insights?.priorityScore !== null && insights?.priorityScore !== undefined) ||
    generatePriority.data?.priorityScore;
  const hasReply = insights?.suggestedReply || generateSuggestedReply.data?.suggestedReply;

  const priorityScore =
    insights?.priorityScore ?? generatePriority.data?.priorityScore;
  const priorityRationale =
    insights?.priorityRationale ?? generatePriority.data?.priorityRationale;

  const toggleSection = useCallback(
    (section: keyof typeof expandedSections) => {
      setExpandedSections((prev) => ({
        ...prev,
        [section]: !prev[section],
      }));
    },
    []
  );

  const handleGenerateAll = useCallback(async () => {
    // If all insights already exist, force-regenerate (bypass cache)
    const force = Boolean(hasSummary && hasPriority && hasReply);
    try {
      await Promise.all([
        generateSummary.mutateAsync(force),
        generatePriority.mutateAsync(force),
        generateSuggestedReply.mutateAsync(force),
      ]);
      toast.success(force ? "AI insights regenerated" : "AI insights generated successfully");
    } catch (error) {
      console.error("Failed to generate insights:", error);
      toast.error("Failed to generate insights. Please try again.");
    }
  }, [hasSummary, hasPriority, hasReply, generateSummary, generatePriority, generateSuggestedReply]);

  const handleInsertReply = useCallback(() => {
    const reply = insights?.suggestedReply || generateSuggestedReply.data?.suggestedReply;
    const actionId = generateSuggestedReply.data?.actionId || insights?.suggestedReplyActionId;
    if (reply) {
      onSuggestedReplySelect?.(reply);
      toast.success("Suggested reply inserted");
      if (actionId) {
        emailsApi.recordOutcome(actionId, true).catch(() => {
          // Best-effort — analytics tracking shouldn't block the user's workflow.
        });
      }
    }
  }, [insights?.suggestedReply, insights?.suggestedReplyActionId, generateSuggestedReply.data, onSuggestedReplySelect]);

  const handleCopyReply = useCallback(() => {
    const reply = insights?.suggestedReply || generateSuggestedReply.data?.suggestedReply;
    const actionId = generateSuggestedReply.data?.actionId || insights?.suggestedReplyActionId;
    if (reply) {
      navigator.clipboard.writeText(reply);
      toast.success("Copied to clipboard");
      if (actionId) {
        emailsApi.recordOutcome(actionId, true).catch(() => {});
      }
    }
  }, [insights?.suggestedReply, insights?.suggestedReplyActionId, generateSuggestedReply.data]);

  const getPriorityColor = (score: number | null | undefined) => {
    if (!score) return "bg-gray-100 text-gray-700";
    if (score <= 3) return "bg-green-100 text-green-700";
    if (score <= 6) return "bg-yellow-100 text-yellow-700";
    return "bg-red-100 text-red-700";
  };

  const firstError =
    generateSummary.error || generatePriority.error || generateSuggestedReply.error;

  const getFriendlyError = (e: typeof firstError) => {
    if (!e) return null;
    const msg = e instanceof ApiError ? e.message : e instanceof Error ? e.message : "";
    if (msg.includes("429") || msg.includes("rate_limit")) {
      return "Groq API rate limit hit. Wait a moment and try again — the free tier resets quickly.";
    }
    if (msg.includes("GROQ_API_KEY is not configured")) {
      return "No Groq API key configured on the server. Ask your admin to set GROQ_API_KEY in the backend's environment.";
    }
    if (msg.includes("401") || msg.includes("invalid_api_key") || msg.includes("Invalid API Key")) {
      return "The server's Groq API key is invalid. Ask your admin to double-check it in the backend's environment.";
    }
    return msg || "Please try again or check your connection";
  };

  return (
    <div className="w-full space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-foreground">AI Insights</h2>
        <Button
          size="sm"
          variant="outline"
          onClick={handleGenerateAll}
          disabled={isGenerating}
          className="gap-2 whitespace-nowrap"
          aria-label={isGenerating ? "Generating insights" : "Generate AI insights"}
        >
          {isGenerating ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="hidden sm:inline">Generating...</span>
            </>
          ) : hasSummary && hasPriority && hasReply ? (
            <>
              <RefreshCw className="h-4 w-4" />
              <span className="hidden sm:inline">Regenerate</span>
            </>
          ) : (
            <>
              <Zap className="h-4 w-4" />
              <span className="hidden sm:inline">Generate</span>
            </>
          )}
        </Button>
      </div>

      {/* Summary Section */}
      <Card className="overflow-hidden">
        <button
          onClick={() => toggleSection("summary")}
          className="w-full px-4 py-3 flex items-center justify-between hover:bg-accent transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
          aria-expanded={expandedSections.summary}
          aria-controls="summary-content"
        >
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-blue-500 flex-shrink-0" />
            <span className="font-medium text-left">Summary</span>
          </div>
          <span className="text-xs text-muted-foreground flex-shrink-0">
            {expandedSections.summary ? "▼" : "▶"}
          </span>
        </button>

        {expandedSections.summary && (
          <div className="border-t px-4 py-3" id="summary-content">
            {generateSummary.isPending ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
              </div>
            ) : hasSummary ? (
              <p className="text-sm text-foreground leading-relaxed">
                {insights?.summary || generateSummary.data?.summary}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground italic">
                Click "Generate" to create a summary
              </p>
            )}
          </div>
        )}
      </Card>

      {/* Priority Section */}
      <Card className="overflow-hidden">
        <button
          onClick={() => toggleSection("priority")}
          className="w-full px-4 py-3 flex items-center justify-between hover:bg-accent transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
          aria-expanded={expandedSections.priority}
          aria-controls="priority-content"
        >
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-amber-500 flex-shrink-0" />
            <span className="font-medium text-left">Priority</span>
          </div>
          <span className="text-xs text-muted-foreground flex-shrink-0">
            {expandedSections.priority ? "▼" : "▶"}
          </span>
        </button>

        {expandedSections.priority && (
          <div className="border-t px-4 py-3" id="priority-content">
            {generatePriority.isPending ? (
              <div className="space-y-2">
                <Skeleton className="h-8 w-20" />
                <Skeleton className="h-4 w-full" />
              </div>
            ) : hasPriority ? (
              <div className="space-y-2">
                <div
                  className={`inline-flex items-center gap-2 px-3 py-1 rounded-full font-semibold text-sm ${getPriorityColor(priorityScore)}`}
                  role="status"
                  aria-label={`Priority score: ${priorityScore} out of 10`}
                >
                  <span>{priorityScore}/10</span>
                </div>
                <p className="text-sm text-foreground leading-relaxed">
                  {priorityRationale}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground italic">
                Click "Generate" to analyze priority
              </p>
            )}
          </div>
        )}
      </Card>

      {/* Suggested Reply Section */}
      <Card className="overflow-hidden">
        <button
          onClick={() => toggleSection("reply")}
          className="w-full px-4 py-3 flex items-center justify-between hover:bg-accent transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
          aria-expanded={expandedSections.reply}
          aria-controls="reply-content"
        >
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-green-500 flex-shrink-0" />
            <span className="font-medium text-left">Suggested Reply</span>
          </div>
          <span className="text-xs text-muted-foreground flex-shrink-0">
            {expandedSections.reply ? "▼" : "▶"}
          </span>
        </button>

        {expandedSections.reply && (
          <div className="border-t px-4 py-3 space-y-3" id="reply-content">
            {generateSuggestedReply.isPending ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-4/5" />
              </div>
            ) : hasReply ? (
              <>
                <p className="text-sm text-foreground leading-relaxed bg-muted p-3 rounded border border-border" data-suggested-reply>
                  {insights?.suggestedReply ||
                    generateSuggestedReply.data?.suggestedReply}
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={handleInsertReply}
                    className="flex-1"
                    aria-label="Insert suggested reply into compose field"
                  >
                    Insert
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleCopyReply}
                    className="flex-shrink-0"
                    aria-label="Copy suggested reply to clipboard"
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="flex-shrink-0 text-muted-foreground"
                    aria-label="Mark suggested reply as not useful"
                    onClick={() => {
                      const actionId = generateSuggestedReply.data?.actionId || insights?.suggestedReplyActionId;
                      if (actionId) {
                        emailsApi.recordOutcome(actionId, false).catch(() => {});
                        toast.success("Thanks — noted as not useful");
                      }
                    }}
                  >
                    Not useful
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground italic">
                Click "Generate" to create a suggested reply
              </p>
            )}
          </div>
        )}
      </Card>

      {/* Error States */}
      {(generateSummary.isError ||
        generatePriority.isError ||
        generateSuggestedReply.isError) && (
        <Card
          className="border-red-200 bg-red-50 p-3 flex items-start gap-2"
          role="alert"
          aria-live="polite"
        >
          <AlertCircle className="h-4 w-4 text-red-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-red-700">
            <p className="font-medium">Failed to generate insights</p>
            <p className="text-xs mt-1 break-words">
              {getFriendlyError(firstError)}
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}
