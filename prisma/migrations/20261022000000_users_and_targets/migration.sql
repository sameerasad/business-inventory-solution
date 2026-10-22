-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'booker',
    "booker_id" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booker_targets" (
    "id" SERIAL NOT NULL,
    "booker_id" INTEGER NOT NULL,
    "month" DATE NOT NULL,
    "amount" DECIMAL(12,2),
    "packs" INTEGER,
    "notes" TEXT,
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booker_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_booker_id_idx" ON "users"("booker_id");

-- CreateIndex
CREATE INDEX "booker_targets_month_idx" ON "booker_targets"("month");

-- CreateIndex
CREATE UNIQUE INDEX "booker_targets_booker_id_month_key" ON "booker_targets"("booker_id", "month");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_booker_id_fkey" FOREIGN KEY ("booker_id") REFERENCES "bookers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booker_targets" ADD CONSTRAINT "booker_targets_booker_id_fkey" FOREIGN KEY ("booker_id") REFERENCES "bookers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

