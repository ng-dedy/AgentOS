-- Milestone 2C: commit-safe event cursor (see packages/platform/src/events/cursor.ts).
-- Added without a default first so Postgres does not rewrite the table (existing rows stay
-- NULL: they committed long ago and sit below every watermark). The default then applies
-- to new rows only. Both statements are metadata-only and take a brief lock.
ALTER TABLE "RunEvent" ADD COLUMN "txid" xid8;
ALTER TABLE "RunEvent" ALTER COLUMN "txid" SET DEFAULT pg_current_xact_id();

-- Milestone 2C: pre-call budget reservations and attempt-level usage accounting.

-- CreateTable
CREATE TABLE "ModelCallAttempt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "rootTaskId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "turn" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "activityAttempt" INTEGER,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reservedUsd" DECIMAL(12,6) NOT NULL,
    "actualUsd" DECIMAL(12,6),
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "recorded" BOOLEAN NOT NULL DEFAULT false,
    "billingUnknown" BOOLEAN NOT NULL DEFAULT false,
    "possibleDuplicate" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "ModelCallAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModelCallAttempt_rootTaskId_status_idx" ON "ModelCallAttempt"("rootTaskId", "status");

-- CreateIndex
CREATE INDEX "ModelCallAttempt_organizationId_createdAt_idx" ON "ModelCallAttempt"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ModelCallAttempt_runId_turn_sequence_key" ON "ModelCallAttempt"("runId", "turn", "sequence");

-- CreateIndex (on large existing tables, create it CONCURRENTLY by hand first; see docs/migrations.md)
CREATE INDEX IF NOT EXISTS "RunEvent_txid_idx" ON "RunEvent"("txid");

-- AddForeignKey
ALTER TABLE "ModelCallAttempt" ADD CONSTRAINT "ModelCallAttempt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


