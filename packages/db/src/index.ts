// @hb/db — public surface of the DB-1 contract.
//
//   import { createDb, orders, type Order, type NewOrder } from '@hb/db';
//   const db = createDb(env.DB);           // Workers (D1 binding)
//   const rows = await db.select().from(orders).where(eq(orders.status, 'new'));

import { drizzle, type AnyD1Database, type DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema.ts';

export * from './schema.ts';
export * from './enums.ts';
export { schema };

export type Schema = typeof schema;
/** Drizzle database over D1 with the full schema (relational `db.query.*` enabled). */
export type Db = DrizzleD1Database<Schema>;

/** Wrap a D1 binding (`env.DB`). D1 enforces foreign keys; no PRAGMA is needed. */
export function createDb(d1: AnyD1Database): Db {
  return drizzle(d1, { schema });
}

// ---------------------------------------------------------------------------------------------
// Row types: `X` = a selected row, `NewX` = an insert (defaults optional).
// ---------------------------------------------------------------------------------------------

export type Category = typeof schema.categories.$inferSelect;
export type NewCategory = typeof schema.categories.$inferInsert;
export type Product = typeof schema.products.$inferSelect;
export type NewProduct = typeof schema.products.$inferInsert;
export type ProductOption = typeof schema.productOptions.$inferSelect;
export type NewProductOption = typeof schema.productOptions.$inferInsert;
export type OptionValue = typeof schema.optionValues.$inferSelect;
export type NewOptionValue = typeof schema.optionValues.$inferInsert;
export type Variant = typeof schema.variants.$inferSelect;
export type NewVariant = typeof schema.variants.$inferInsert;
export type VariantOptionValue = typeof schema.variantOptionValues.$inferSelect;
export type NewVariantOptionValue = typeof schema.variantOptionValues.$inferInsert;
export type PackItem = typeof schema.packItems.$inferSelect;
export type NewPackItem = typeof schema.packItems.$inferInsert;
export type Image = typeof schema.images.$inferSelect;
export type NewImage = typeof schema.images.$inferInsert;
export type Wilaya = typeof schema.wilayas.$inferSelect;
export type NewWilaya = typeof schema.wilayas.$inferInsert;
export type Commune = typeof schema.communes.$inferSelect;
export type NewCommune = typeof schema.communes.$inferInsert;
export type DeliveryFee = typeof schema.deliveryFees.$inferSelect;
export type NewDeliveryFee = typeof schema.deliveryFees.$inferInsert;
export type Customer = typeof schema.customers.$inferSelect;
export type NewCustomer = typeof schema.customers.$inferInsert;
export type Order = typeof schema.orders.$inferSelect;
export type NewOrder = typeof schema.orders.$inferInsert;
export type OrderItem = typeof schema.orderItems.$inferSelect;
export type NewOrderItem = typeof schema.orderItems.$inferInsert;
export type OrderEvent = typeof schema.orderEvents.$inferSelect;
export type NewOrderEvent = typeof schema.orderEvents.$inferInsert;
export type ContentPage = typeof schema.contentPages.$inferSelect;
export type NewContentPage = typeof schema.contentPages.$inferInsert;
export type Setting = typeof schema.settings.$inferSelect;
export type NewSetting = typeof schema.settings.$inferInsert;
export type AdminUser = typeof schema.adminUsers.$inferSelect;
export type NewAdminUser = typeof schema.adminUsers.$inferInsert;
export type AuditLogEntry = typeof schema.auditLog.$inferSelect;
export type NewAuditLogEntry = typeof schema.auditLog.$inferInsert;
export type PublishRun = typeof schema.publishRuns.$inferSelect;
export type NewPublishRun = typeof schema.publishRuns.$inferInsert;
export type RumEvent = typeof schema.rumEvents.$inferSelect;
export type NewRumEvent = typeof schema.rumEvents.$inferInsert;
export type RumDaily = typeof schema.rumDaily.$inferSelect;
export type NewRumDaily = typeof schema.rumDaily.$inferInsert;
export type NotificationDelivery = typeof schema.notificationDeliveries.$inferSelect;
export type NewNotificationDelivery = typeof schema.notificationDeliveries.$inferInsert;
export type CourierAccount = typeof schema.courierAccounts.$inferSelect;
export type NewCourierAccount = typeof schema.courierAccounts.$inferInsert;
export type Shipment = typeof schema.shipments.$inferSelect;
export type NewShipment = typeof schema.shipments.$inferInsert;
export type ShipmentEvent = typeof schema.shipmentEvents.$inferSelect;
export type NewShipmentEvent = typeof schema.shipmentEvents.$inferInsert;
export type CourierWebhookInboxRow = typeof schema.courierWebhookInbox.$inferSelect;
export type NewCourierWebhookInboxRow = typeof schema.courierWebhookInbox.$inferInsert;
export type DeliveryException = typeof schema.deliveryExceptions.$inferSelect;
export type NewDeliveryException = typeof schema.deliveryExceptions.$inferInsert;
export type CourierDirectoryRow = typeof schema.courierDirectory.$inferSelect;
export type NewCourierDirectoryRow = typeof schema.courierDirectory.$inferInsert;
export type SheetsConnection = typeof schema.sheetsConnection.$inferSelect;
export type NewSheetsConnection = typeof schema.sheetsConnection.$inferInsert;
export type SheetsRow = typeof schema.sheetsRows.$inferSelect;
export type NewSheetsRow = typeof schema.sheetsRows.$inferInsert;
export type SheetsRevocation = typeof schema.sheetsRevocations.$inferSelect;
export type NewSheetsRevocation = typeof schema.sheetsRevocations.$inferInsert;
export * from './orders.ts';
export * from './fees.ts';
export * from './order-contact.ts';
export * from './secret-box.ts';
export * from './webhook-token.ts';
export * from './shipments.ts';
export * from './courier-directory.ts';
