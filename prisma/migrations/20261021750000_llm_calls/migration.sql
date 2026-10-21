-- CreateTable
CREATE TABLE "llm_calls" (
    "id" SERIAL NOT NULL,
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "llm_calls_created_at_idx" ON "llm_calls"("created_at");


-- token 数、耗时不为负
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_numbers_check" CHECK ("prompt_tokens" >= 0 AND "completion_tokens" >= 0 AND "latency_ms" >= 0);
