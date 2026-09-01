-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "share_token" TEXT;

-- AlterTable
ALTER TABLE "shops" ADD COLUMN     "phone" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "bookings_share_token_key" ON "bookings"("share_token");

