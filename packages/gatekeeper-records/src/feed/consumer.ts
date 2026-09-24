// Queue consumer: validate each change event, group by datastore, hand each group to that
// datastore's feed. Invalid messages are acknowledged and logged (retrying cannot fix them);
// delivery failures retry with backoff and eventually land in the dead-letter queue.
//
// The same batch also triggers outbound webhook delivery for its datastores (`webhooks`, optional).
// That is best effort and never affects acknowledgement: webhooks keep their own delivery state,
// retries and dead-lettering in Postgres, and the cron runs them as the backstop.

import { ChangeEventSchema, toNotification, type ChangeNotification } from "@records/contracts";

export interface FeedDirectory {
  deliver(datastoreId: string, notifications: ChangeNotification[]): Promise<unknown>;
  /** Run outbound webhook delivery for these datastores. Errors are logged and swallowed. */
  webhooks?(datastoreIds: string[]): Promise<unknown>;
}

export async function consumeChanges(batch: MessageBatch<unknown>, feeds: FeedDirectory): Promise<void> {
  const groups = new Map<string, { messages: Message<unknown>[]; notifications: ChangeNotification[] }>();
  for (const message of batch.messages) {
    const parsed = ChangeEventSchema.safeParse(message.body);
    if (!parsed.success) {
      console.error(JSON.stringify({ event: "records.feed.invalid_message", id: message.id }));
      message.ack();
      continue;
    }
    const group = groups.get(parsed.data.datastoreId) ?? { messages: [], notifications: [] };
    group.messages.push(message);
    group.notifications.push(toNotification(parsed.data));
    groups.set(parsed.data.datastoreId, group);
  }
  await Promise.all(
    [...groups].map(async ([datastoreId, group]) => {
      try {
        await feeds.deliver(datastoreId, group.notifications);
        for (const m of group.messages) m.ack();
      } catch {
        for (const m of group.messages) m.retry({ delaySeconds: Math.min(300, 5 * 2 ** m.attempts) });
      }
    }),
  );
  if (feeds.webhooks && groups.size > 0) {
    try {
      await feeds.webhooks([...groups.keys()]);
    } catch (err) {
      console.warn(JSON.stringify({ event: "records.webhook.run_failed", error: err instanceof Error ? err.name : "error" }));
    }
  }
}
