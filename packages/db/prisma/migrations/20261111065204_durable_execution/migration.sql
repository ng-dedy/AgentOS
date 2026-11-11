-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "maxCostUsd" DECIMAL(12,6),
ADD COLUMN     "workflowId" TEXT;

-- AlterTable
ALTER TABLE "UsageRecord" ADD COLUMN     "attempt" INTEGER,
ADD COLUMN     "latencyMs" INTEGER;

-- CreateTable
CREATE TABLE "ProviderCredential" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "wrappedKey" BYTEA NOT NULL,
    "kekId" TEXT NOT NULL,
    "keyHint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unverified',
    "lastVerifiedAt" TIMESTAMP(3),
    "lastVerifyError" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "rotatedAt" TIMESTAMP(3),

    CONSTRAINT "ProviderCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "id" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "pid" INTEGER NOT NULL,
    "taskQueue" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "activeActivities" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderCredential_kekId_idx" ON "ProviderCredential"("kekId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCredential_organizationId_provider_key" ON "ProviderCredential"("organizationId", "provider");

-- CreateIndex
CREATE INDEX "WorkerHeartbeat_lastSeenAt_idx" ON "WorkerHeartbeat"("lastSeenAt");

-- CreateIndex
CREATE INDEX "Message_conversationId_runId_idx" ON "Message"("conversationId", "runId");

-- AddForeignKey
ALTER TABLE "ProviderCredential" ADD CONSTRAINT "ProviderCredential_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Cross-process event fan-out (milestone 2B).
-- Every persisted RunEvent notifies listeners after the inserting transaction commits.
-- The payload carries ids only (well under the 8000-byte NOTIFY limit); listeners read the row.
CREATE OR REPLACE FUNCTION agentos_notify_run_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'agentos_events',
    json_build_object('o', NEW."organizationId", 'r', NEW."rootTaskId", 's', NEW.seq::text)::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER run_event_notify
  AFTER INSERT ON "RunEvent"
  FOR EACH ROW EXECUTE FUNCTION agentos_notify_run_event();
