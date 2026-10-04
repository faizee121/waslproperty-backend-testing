-- CreateEnum
CREATE TYPE "PropertyDocumentType" AS ENUM ('NSW_STRATA_PLAN');

-- CreateEnum
CREATE TYPE "PropertyDocumentStatus" AS ENUM ('UPLOADED', 'ANALYSING', 'REVIEW_REQUIRED', 'READY', 'FAILED', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "DocumentAnalysisStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityEventType" ADD VALUE 'STRATA_PLAN_UPLOADED';
ALTER TYPE "ActivityEventType" ADD VALUE 'STRATA_PLAN_ANALYSIS_STARTED';
ALTER TYPE "ActivityEventType" ADD VALUE 'STRATA_PLAN_ANALYSIS_COMPLETED';
ALTER TYPE "ActivityEventType" ADD VALUE 'STRATA_PLAN_ANALYSIS_FAILED';
ALTER TYPE "ActivityEventType" ADD VALUE 'STRATA_PLAN_CONFIRMED';
ALTER TYPE "ActivityEventType" ADD VALUE 'STRATA_PROPERTY_CREATED_FROM_PLAN';

-- CreateTable
CREATE TABLE "property_documents" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "documentType" "PropertyDocumentType",
    "status" "PropertyDocumentStatus" NOT NULL DEFAULT 'UPLOADED',
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "pageCount" INTEGER,
    "draft" JSONB,
    "createdPropertyId" TEXT,
    "confirmedByUserId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "property_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_analyses" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "propertyDocumentId" TEXT NOT NULL,
    "status" "DocumentAnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "classifiedDocumentType" "PropertyDocumentType",
    "classificationConfidence" DOUBLE PRECISION,
    "classificationEvidence" TEXT,
    "extraction" JSONB,
    "issues" JSONB,
    "extractionProvider" TEXT,
    "extractionModel" TEXT,
    "ocrEngine" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "property_documents_createdPropertyId_key" ON "property_documents"("createdPropertyId");

-- CreateIndex
CREATE INDEX "property_documents_organisationId_createdAt_idx" ON "property_documents"("organisationId", "createdAt");

-- CreateIndex
CREATE INDEX "document_analyses_organisationId_idx" ON "document_analyses"("organisationId");

-- CreateIndex
CREATE INDEX "document_analyses_propertyDocumentId_createdAt_idx" ON "document_analyses"("propertyDocumentId", "createdAt");

-- AddForeignKey
ALTER TABLE "property_documents" ADD CONSTRAINT "property_documents_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_documents" ADD CONSTRAINT "property_documents_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_documents" ADD CONSTRAINT "property_documents_confirmedByUserId_fkey" FOREIGN KEY ("confirmedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_documents" ADD CONSTRAINT "property_documents_createdPropertyId_fkey" FOREIGN KEY ("createdPropertyId") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_analyses" ADD CONSTRAINT "document_analyses_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_analyses" ADD CONSTRAINT "document_analyses_propertyDocumentId_fkey" FOREIGN KEY ("propertyDocumentId") REFERENCES "property_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
