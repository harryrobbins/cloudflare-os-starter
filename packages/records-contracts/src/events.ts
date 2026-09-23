// Change events. The outbox stores the full envelope; subscribers receive only the notification,
// which names what changed and its revision and never carries record content. A client that
// receives one refetches through an authorized read.

import { z } from "zod";

export const ENTITY_TYPES = ["datastore", "project", "issue", "comment", "membership", "binding"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const EVENT_TYPES = [
  "datastore.created",
  "datastore.updated",
  "datastore.archived",
  "datastore.restored",
  "project.created",
  "issue.created",
  "issue.updated",
  "issue.transitioned",
  "comment.created",
  "membership.changed",
  "binding.revoked",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Envelope published to the Queue. Duplicates and reordering are expected. */
export const ChangeEventSchema = z.object({
  v: z.literal(1),
  eventId: z.uuid(),
  orgId: z.uuid(),
  datastoreId: z.uuid(),
  eventType: z.enum(EVENT_TYPES),
  entityType: z.enum(ENTITY_TYPES),
  entityId: z.uuid(),
  revision: z.number().int().min(0),
  occurredAt: z.string(),
});
export type ChangeEvent = z.infer<typeof ChangeEventSchema>;

/** What a subscriber sees. Obsolete revisions should be ignored; delivery is at-least-once. */
export type ChangeNotification = {
  datastoreId: string;
  eventType: EventType;
  entityType: EntityType;
  entityId: string;
  revision: number;
};

/** Sent instead of individual notifications when continuity cannot be guaranteed. */
export type ResyncNotification = { datastoreId: string; eventType: "resync" };

export function toNotification(event: ChangeEvent): ChangeNotification {
  return {
    datastoreId: event.datastoreId,
    eventType: event.eventType,
    entityType: event.entityType,
    entityId: event.entityId,
    revision: event.revision,
  };
}
