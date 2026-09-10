-- CreateTable
CREATE TABLE "voice_attempts" (
    "id" SERIAL NOT NULL,
    "transcript" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "model" TEXT,
    "no_speech_prob" DOUBLE PRECISION,
    "saved" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "voice_attempts_created_at_idx" ON "voice_attempts"("created_at");

-- CreateIndex
CREATE INDEX "voice_attempts_kind_created_at_idx" ON "voice_attempts"("kind", "created_at");

