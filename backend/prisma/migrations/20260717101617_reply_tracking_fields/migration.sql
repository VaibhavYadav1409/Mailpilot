-- AlterTable
ALTER TABLE "Email" ADD COLUMN     "firstResponseAt" TIMESTAMP(3),
ADD COLUMN     "lastReplyAt" TIMESTAMP(3),
ADD COLUMN     "pendingDurationSec" INTEGER,
ADD COLUMN     "replyTimeSec" INTEGER;

-- CreateIndex
CREATE INDEX "Email_gmailAccountId_threadId_idx" ON "Email"("gmailAccountId", "threadId");
