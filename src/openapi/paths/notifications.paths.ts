import { z } from 'zod';
import { notificationsQuerySchema } from '../../modules/notifications/notifications.schemas.js';
import { commonErrors, jsonContent, paginatedSchema } from '../components/common.schemas.js';
import { notificationSchema } from '../components/entities.schemas.js';
import { registry, SECURITY_CUSTOMER } from '../registry.js';

const TAG = 'Notifications';
const idParam = registry.register('NotificationIdParam', z.object({ id: z.string() }));

registry.registerPath({
  method: 'get',
  path: '/notifications',
  operationId: 'listNotifications',
  tags: [TAG],
  summary: "Lists the authenticated caller's own notifications.",
  security: SECURITY_CUSTOMER,
  request: { query: notificationsQuerySchema },
  responses: {
    200: jsonContent(paginatedSchema(notificationSchema, 'Notifications'), 'Notifications.'),
    401: commonErrors[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/notifications/unread-count',
  operationId: 'getUnreadNotificationCount',
  tags: [TAG],
  summary: 'Returns the caller’s unread notification count (for a badge).',
  security: SECURITY_CUSTOMER,
  responses: {
    200: jsonContent(z.object({ count: z.number().int() }), 'Unread count.'),
    401: commonErrors[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/notifications/read-all',
  operationId: 'markAllNotificationsRead',
  tags: [TAG],
  summary: 'Marks all of the caller’s notifications as read.',
  security: SECURITY_CUSTOMER,
  responses: {
    200: jsonContent(z.object({ updated: z.number().int() }), 'Count marked read.'),
    401: commonErrors[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/notifications/{id}',
  operationId: 'getNotification',
  tags: [TAG],
  summary: 'Returns one notification.',
  description:
    'Only the owning user can read their own notification — possession of its id is never itself authorization.',
  security: SECURITY_CUSTOMER,
  request: { params: idParam },
  responses: {
    200: jsonContent(notificationSchema, 'The notification.'),
    401: commonErrors[401],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'post',
  path: '/notifications/{id}/read',
  operationId: 'markNotificationRead',
  tags: [TAG],
  summary: 'Marks one notification as read.',
  security: SECURITY_CUSTOMER,
  request: { params: idParam },
  responses: {
    200: jsonContent(notificationSchema, 'Updated.'),
    401: commonErrors[401],
    404: commonErrors[404],
  },
});
