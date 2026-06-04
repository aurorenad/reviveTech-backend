-- CreateEnum
CREATE TYPE "CustomerOfferDecision" AS ENUM ('APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "TradeInRequest" ADD COLUMN     "technicianId" TEXT,
ADD COLUMN     "technicianComment" TEXT,
ADD COLUMN     "technicianRepairEstimate" DOUBLE PRECISION,
ADD COLUMN     "technicianReviewedAt" TIMESTAMP(3),
ADD COLUMN     "finalOfferAmount" DOUBLE PRECISION,
ADD COLUMN     "decisionAt" TIMESTAMP(3),
ADD COLUMN     "customerOfferDecision" "CustomerOfferDecision",
ADD COLUMN     "customerDecisionAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "TradeInRequest_technicianId_idx" ON "TradeInRequest"("technicianId");

-- AddForeignKey
ALTER TABLE "TradeInRequest" ADD CONSTRAINT "TradeInRequest_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
