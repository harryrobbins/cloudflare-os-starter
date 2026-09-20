/**
 * Team chat, as the CloudflareOS agent sees it.
 *
 * This is the whole agent-facing surface of the chat Gatekeeper. It is published verbatim by
 * `getTypeScriptTypes()`, so it is also the agent's only documentation: every comment here is
 * written for the caller, not for the maintainer.
 */

/** A public channel in this deployment's team chat. */
export interface ChatChannelInfo {
  /** Opaque channel id. Pass it to the read, search and post methods. */
  readonly id: string;
  /** The channel name without its leading `#`, for example "general". */
  readonly name: string;
  /** One-line topic, or null when nobody has set one. */
  readonly topic: string | null;
  /** Longer statement of what the channel is for, or null. */
  readonly purpose: string | null;
  /** How many people have joined the channel. */
  readonly memberCount: number;
}

/** One message in a channel or in a thread hanging off a channel message. */
export interface ChatMessage {
  /** Opaque message id. Use it as `rootId` to read or reply to this message's thread. */
  readonly id: string;
  readonly channelId: string;
  /** The thread root's id when this message is a reply; null for a top-level message. */
  readonly rootId: string | null;
  /** Opaque id of the author. `"agent"` is this agent's own account. */
  readonly authorId: string;
  /** The author's display name when the message was read. Neither unique nor stable. */
  readonly authorName: string;
  /**
   * Markdown. A mention is an immutable id token rather than a name: `<@U123>` mentions the person
   * whose id is `U123`, and `<@agent>` mentions this agent. Resolve a token through the
   * `authorId`/`authorName` pairs already read, and write mentions the same way when posting --
   * a plain "@Alice" is text and notifies nobody.
   */
  readonly body: string;
  /** "user" for a person, "agent" for this agent, "system" for a channel event such as an archive. */
  readonly kind: "user" | "system" | "agent";
  /** When the message was posted, in milliseconds since the epoch. */
  readonly createdAt: number;
  /** When it was last edited, or null if it never was. */
  readonly editedAt: number | null;
  /** True for a deleted message that survives only because replies hang off it; its body is blank. */
  readonly deleted: boolean;
  /** Replies in this message's thread; 0 when it has none. Read them with `readThread`. */
  readonly replyCount: number;
  /** Ids of the people mentioned in `body`, in the order the tokens appear. */
  readonly mentionedUserIds: string[];
  /** How many images and files are attached. Their contents are not readable through this API. */
  readonly attachmentCount: number;
}

/** A page of messages, oldest first. */
export interface ChatMessagePage {
  readonly messages: ChatMessage[];
  /**
   * Opaque cursor for the page of older messages immediately before this one, or null when the
   * start of the history has been reached. Pass it back as `options.before`.
   */
  readonly olderCursor: string | null;
}

/** How much history to read, and from where. */
export interface ChatReadOptions {
  /** A cursor from a previous page's `olderCursor`. Omit to start at the newest message. */
  readonly before?: string;
  /** Messages per page, from 1 to 50. Defaults to 20. */
  readonly limit?: number;
}

/** How many search hits to return, and from where. */
export interface ChatSearchOptions {
  /** A cursor from a previous result's `cursor`. Omit to start at the best-ranked hit. */
  readonly cursor?: string;
  /** Hits per page, from 1 to 50. Defaults to 20. */
  readonly limit?: number;
}

/** One search hit. */
export interface ChatSearchHit {
  readonly message: ChatMessage;
  /** The matching fragment of the message body, with the matched words wrapped in `<mark>` tags. */
  readonly snippet: string;
}

export interface ChatSearchResult {
  /** Best match first. */
  readonly hits: ChatSearchHit[];
  /** Opaque cursor for the next page of hits, or null when there are no more. */
  readonly cursor: string | null;
}

/** Where a new message goes. */
export interface ChatPostOptions {
  /**
   * Reply inside this message's thread instead of posting at the top level of the channel. Use the
   * `id` of the message that starts the thread, or any message's `rootId`.
   */
  readonly rootId?: string;
}

/**
 * The team chat of this CloudflareOS deployment.
 *
 * **Only public channels are reachable.** Private channels, group conversations and direct
 * messages are never listed, read, searched or posted to, so nothing read here is more private
 * than "visible to everyone who can sign in to this deployment".
 *
 * Messages are posted as the built-in "Agent" member, and a post needs the approval of the person
 * whose workspace this runs in before it is sent -- `postMessage` returns as soon as the request
 * has been raised, and the message appears in the channel only once that person approves it.
 */
export interface ChatSession {
  /** Lists the public channels that are not archived. */
  listChannels(): Promise<ChatChannelInfo[]>;

  /**
   * Reads one page of a public channel's history, newest page first.
   *
   * Top-level messages only: a threaded reply is reached through `readThread` on its root. Throws
   * if the channel is not a public channel.
   */
  readMessages(channelId: string, options?: ChatReadOptions): Promise<ChatMessagePage>;

  /**
   * Reads one thread: the message whose id is `rootId`, followed by its replies oldest first.
   *
   * Throws if the channel is not a public channel, or if `rootId` is not a message in it.
   */
  readThread(channelId: string, rootId: string, options?: ChatReadOptions): Promise<ChatMessagePage>;

  /**
   * Full-text search across the public channels.
   *
   * `query` is free text. It also understands the qualifiers the chat app's own search box takes,
   * such as `in:#general`, `from:` a person and `has:image`; anything unrecognised is matched as
   * text. An empty result is an ordinary answer, not an error.
   */
  search(query: string, options?: ChatSearchOptions): Promise<ChatSearchResult>;

  /**
   * Asks to post `text` (Markdown, at most 8 KiB) to a public channel as the "Agent" member.
   *
   * Returns once the request has been raised. The message is sent only after the person whose
   * workspace this runs in approves it, so a later read does not show it until then; say what was
   * requested rather than claiming it has been sent. Throws if `text` is empty or too long, or if
   * the channel is not a public channel.
   */
  postMessage(channelId: string, text: string, options?: ChatPostOptions): Promise<void>;
}
