import { Router } from 'express';
import { aiRouter } from '../../modules/ai/ai.routes.js';
import { authRouter } from '../../modules/auth/auth.routes.js';
import { backofficeRouter } from '../../modules/backoffice/backoffice.routes.js';
import { communicationsRouter } from '../../modules/communications/communications.routes.js';
import { contractorsRouter } from '../../modules/contractors/contractors.routes.js';
import { dashboardRouter } from '../../modules/dashboard/dashboard.routes.js';
import { invitesRouter } from '../../modules/invites/invites.routes.js';
import { maintenanceRouter } from '../../modules/maintenance/maintenance.routes.js';
import { notificationsRouter } from '../../modules/notifications/notifications.routes.js';
import { organisationsRouter } from '../../modules/organisations/organisations.routes.js';
import { peopleRouter } from '../../modules/people/people.routes.js';
import { propertiesRouter } from '../../modules/properties/properties.routes.js';
import { propertyDocumentsRouter } from '../../modules/property-documents/property-documents.routes.js';
import { quoteRoundsRouter } from '../../modules/quotes/quote-rounds.routes.js';
import { quotesRouter } from '../../modules/quotes/quotes.routes.js';
import { rfqPublicRouter } from '../../modules/quotes/rfq-public.routes.js';
import { workOrderVariationsRouter } from '../../modules/work-orders/work-order-variations.routes.js';
import { savedAudiencesRouter } from '../../modules/saved-audiences/saved-audiences.routes.js';
import { spacesRouter } from '../../modules/spaces/spaces.routes.js';
import { workOrdersRouter } from '../../modules/work-orders/work-orders.routes.js';

export const apiV1Router = Router();

apiV1Router.get('/ping', (_req, res) => {
  res.json({ pong: true });
});

apiV1Router.use('/auth', authRouter);
apiV1Router.use('/organisations', organisationsRouter);
apiV1Router.use('/properties', propertiesRouter);
apiV1Router.use('/spaces', spacesRouter);
apiV1Router.use('/people', peopleRouter);
apiV1Router.use('/maintenance-requests', maintenanceRouter);
apiV1Router.use('/invites', invitesRouter);
apiV1Router.use('/work-orders', workOrdersRouter);
apiV1Router.use('/contractors', contractorsRouter);
apiV1Router.use('/quotes', quotesRouter);
apiV1Router.use('/quote-rounds', quoteRoundsRouter);
apiV1Router.use('/rfq', rfqPublicRouter);
apiV1Router.use('/work-order-variations', workOrderVariationsRouter);
apiV1Router.use('/dashboard', dashboardRouter);
apiV1Router.use('/communications', communicationsRouter);
apiV1Router.use('/saved-audiences', savedAudiencesRouter);
apiV1Router.use('/notifications', notificationsRouter);
apiV1Router.use('/backoffice', backofficeRouter);
apiV1Router.use('/ai', aiRouter);
apiV1Router.use('/property-documents', propertyDocumentsRouter);
