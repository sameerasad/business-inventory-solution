-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "booker_id" INTEGER;

-- CreateTable
CREATE TABLE "bookers" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "phone" TEXT,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bookers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bookers_name_key" ON "bookers"("name");

-- CreateIndex
CREATE INDEX "bookers_is_deleted_is_active_idx" ON "bookers"("is_deleted", "is_active");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_booker_id_fkey" FOREIGN KEY ("booker_id") REFERENCES "bookers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

