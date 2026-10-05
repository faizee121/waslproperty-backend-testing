-- Strata lot numbers must be unique within one Property, never across
-- properties, and never enforced for a NULL lotNumber (COMMON_PROPERTY /
-- UNCLASSIFIED spaces, and every space on a non-strata property). A
-- partial unique index is the only way to express "unique when present" —
-- Prisma's schema DSL cannot declare one, so this is a hand-written
-- migration; see Space's @@unique([propertyId, code]) doc comment in
-- schema.prisma for why it isn't declared there either.
CREATE UNIQUE INDEX "spaces_propertyId_lotNumber_key" ON "spaces"("propertyId", "lotNumber") WHERE "lotNumber" IS NOT NULL;
