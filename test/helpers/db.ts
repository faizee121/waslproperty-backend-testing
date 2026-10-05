import { getPrismaClient } from '../../src/lib/prisma.js';

export const testPrisma = getPrismaClient();

export async function resetDb() {
  // WorkOrder.selectedQuoteId <-> ContractorQuote.workOrderId and
  // QuoteRound.awardedQuoteId <-> ContractorQuote.quoteRoundId are each a
  // circular FK pair — neither table in either pair can be fully deleted
  // first without violating the other direction, so both "award" links
  // are nulled out up front to break the cycles before any deletes run.
  await testPrisma.$transaction([
    testPrisma.workOrder.updateMany({ data: { selectedQuoteId: null } }),
    testPrisma.quoteRound.updateMany({ data: { awardedQuoteId: null } }),
    // PropertyDocument.createdPropertyId <-> Property is the same kind of
    // circular pair — a confirmed document points at the property it
    // created, so the link is broken before either side is deleted.
    testPrisma.propertyDocument.updateMany({ data: { createdPropertyId: null } }),
  ]);

  await testPrisma.$transaction([
    testPrisma.documentAnalysis.deleteMany(),
    testPrisma.propertyDocument.deleteMany(),
    testPrisma.aiMessage.deleteMany(),
    testPrisma.aiAuditEvent.deleteMany(),
    testPrisma.aiConversation.deleteMany(),
    testPrisma.activityEvent.deleteMany(),
    testPrisma.waslSignWebhookEvent.deleteMany(),
    testPrisma.notification.deleteMany(),
    testPrisma.communicationDelivery.deleteMany(),
    testPrisma.communicationRecipient.deleteMany(),
    testPrisma.communication.deleteMany(),
    testPrisma.savedAudience.deleteMany(),
    testPrisma.contractorQuoteAttachment.deleteMany(),
    testPrisma.workOrderVariationAttachment.deleteMany(),
    testPrisma.workOrderVariation.deleteMany(),
    testPrisma.quoteRoundInvitation.deleteMany(),
    testPrisma.contractorQuote.deleteMany(),
    testPrisma.workOrder.deleteMany(),
    testPrisma.quoteRound.deleteMany(),
    testPrisma.contractorCredential.deleteMany(),
    testPrisma.contractorComplianceRequirement.deleteMany(),
    testPrisma.organisationRolePermission.deleteMany(),
    testPrisma.approvalPolicyRule.deleteMany(),
    testPrisma.organisationApprovalPolicy.deleteMany(),
    testPrisma.contractor.deleteMany(),
    testPrisma.maintenanceRequestAttachment.deleteMany(),
    testPrisma.maintenanceRequest.deleteMany(),
    testPrisma.contactInvite.deleteMany(),
    testPrisma.propertyMembership.deleteMany(),
    testPrisma.propertyContact.deleteMany(),
    testPrisma.space.deleteMany(),
    testPrisma.property.deleteMany(),
    testPrisma.session.deleteMany(),
    testPrisma.platformAuditEvent.deleteMany(),
    testPrisma.employeeSession.deleteMany(),
    testPrisma.employee.deleteMany(),
    testPrisma.organisationMembership.deleteMany(),
    testPrisma.user.deleteMany(),
    testPrisma.organisation.deleteMany(),
  ]);
}
