-- AlterTable
ALTER TABLE "User" ADD COLUMN "avatarUrl" TEXT;

-- AlterTable
ALTER TABLE "Device" ADD COLUMN "imageUrls" TEXT NOT NULL DEFAULT '[]';
