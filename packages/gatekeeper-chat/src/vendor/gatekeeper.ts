// `ChatGatekeeper`: the Durable Object facet the Workshop installs into every workspace.
//
// It is the ambient singleton of the auto-provisioned chat account (`account.ts`), so there is one
// per workspace and it holds no credentials: the chat data is deployment-wide and the caller is
// always the built-in `agent` account. Its own storage holds only the posts it has submitted for
// approval, because the overseer passes an action back as a bare number and everything else has to
// have been written down.
//
// Observer policy (strategy D, "low-stakes"): every observer is accepted. Everything reachable
// through this session is a public channel, which every signed-in user of this deployment can read
// in the chat app itself, so a collaborator on a shared gadget can already see it. If private
// conversations are ever exposed here, this policy has to change to an ACL check first -- see the
// "Agent access" section of README.md, which is what `/admin` reviews before enabling the binding.

import { DurableObject, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  boundAgentCatalog,
  type ActionKind,
  type AgentCatalog,
  type ApprovalQueue,
  type Gatekeeper,
  type GatekeeperUserVerifier,
  type ObservationAuthorizer,
  type ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";

import { WorkspaceBridge, type ChatBridge } from "./bridge.js";
import {
  applyChatPost,
  MAX_AGENT_CHANNELS,
  rejectChatPost,
  revertChatPost,
  toChatChannelInfo,
  ChatSessionImpl,
  type AppliedChatPost,
  type ChatActionStore,
  type PendingChatPost,
} from "./session.js";
import type { ChatSession } from "./types.js";
import TYPES_CODE from "./types-code.js";

/** Imbued by `ChatAccount.getSingletonGatekeeperClass()`. */
export type ChatGatekeeperProps = { accountId: string };

/** What `describe()` tells the Workshop about the ambient binding. */
export function describeChatResource(): ResourceDescription {
  return {
    url: "chat://main",
    title: "Team chat",
    snippet: "Read and search this deployment's public chat channels, and post to them for approval.",
    suggestedBindingName: "CHAT",
    tsType: "ChatSession",
  };
}

/**
 * The bounded discovery list: the public channels, so the agent knows what it can read without
 * paging anything first. Catalog access is an observation like any other read.
 */
export async function chatAgentCatalog(
  bridge: Pick<ChatBridge, "listChannels">,
  authorizer: Pick<ObservationAuthorizer, "authorizeObservation">,
): Promise<AgentCatalog | null> {
  let channels;
  try {
    const listed = await bridge.listChannels();
    channels = listed.channels.filter((channel) => channel.kind === "public" && !channel.archived);
  } catch {
    // A catalog goes into the system prompt of every turn. A chat Worker that cannot answer (an API
    // route that has not shipped, a Durable Object that is briefly unreachable) must degrade to "no
    // catalog" rather than break every gadget in the workspace.
    return null;
  }

  const entries = channels
    .toSorted((left, right) => (left.name ?? "").localeCompare(right.name ?? ""))
    .slice(0, MAX_AGENT_CHANNELS)
    .map((channel) => {
      const info = toChatChannelInfo(channel);
      return {
        id: info.id,
        title: `#${info.name}`,
        description:
          info.topic ?? info.purpose ?? `Public chat channel with ${info.memberCount} members.`,
      };
    });

  await authorizer.authorizeObservation({
    title: "List team chat channels",
    description:
      `Read the names and topics of ${entries.length} public channel${entries.length === 1 ? "" : "s"} ` +
      "in this deployment's team chat, so the agent knows what it can read.",
  });
  return boundAgentCatalog(entries);
}

@validateRpc()
export class ChatGatekeeper
  extends DurableObject<Cloudflare.Env, ChatGatekeeperProps>
  implements Gatekeeper<ChatSession>
{
  /** Describes the ambient team-chat binding. */
  async describe(): Promise<ResourceDescription> {
    return describeChatResource();
  }

  /** Returns the agent-facing `ChatSession` declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** Posting is never auto-applied: a person reads every message the agent sends. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  /** Opens a session on this deployment's chat, acting as the built-in `agent` account. */
  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<ChatSession> {
    return new ChatSessionImpl({
      approvalQueue: approvalQueue.dup(),
      bridge: this.#bridge(),
      actions: this.#store(),
    });
  }

  /** Lists the public channels the session can reach. */
  async getAgentCatalog(
    authorizer: RpcStub<ObservationAuthorizer>,
  ): Promise<AgentCatalog | null> {
    return chatAgentCatalog(this.#bridge(), authorizer);
  }

  /**
   * Accepts every observer.
   *
   * Only public channels are reachable through this gatekeeper, and a public channel is readable by
   * every signed-in user of this deployment, so any collaborator who can open the shared gadget can
   * already read everything it has observed here.
   */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  /** Nothing is tracked per observer, so there is nothing to forget. */
  async removeObserver(_id: string): Promise<void> {}

  /** Sends an approved post. */
  async applyAction(action: number): Promise<void> {
    try {
      await applyChatPost(this.#store(), this.#bridge(), action);
    } catch (error) {
      // The overseer tells the user the action failed and offers a retry; this line is the only
      // trace the chat Worker's own logs keep. The message body is deliberately not logged.
      console.error(
        JSON.stringify({
          event: "chat.vendor.post_failed",
          accountId: this.ctx.props.accountId,
          action,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  }

  /** Forgets a rejected post. Nothing was simulated, so the gadget needs no restart. */
  async rejectAction(action: number): Promise<void> {
    rejectChatPost(this.#store(), action);
  }

  /** Deletes a message that was already posted. */
  async revertAction(
    action: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    return revertChatPost(this.#store(), this.#bridge(), action);
  }

  #bridge(): ChatBridge {
    return new WorkspaceBridge(this.env);
  }

  /**
   * The action store, over this facet's own SQLite-backed KV.
   *
   * Keys: `counter:action` -> the last id handed out, `pending:<id>` -> a submitted post,
   * `applied:<id>` -> a sent post, kept so `revertAction()` knows what to delete.
   */
  #store(): ChatActionStore {
    const kv = this.ctx.storage.kv;
    return {
      nextActionId(): number {
        const next = (kv.get<number>("counter:action") ?? 0) + 1;
        kv.put("counter:action", next);
        return next;
      },
      putPending(action, post): void {
        kv.put<PendingChatPost>(`pending:${action}`, post);
      },
      getPending(action): PendingChatPost | undefined {
        return kv.get<PendingChatPost>(`pending:${action}`);
      },
      deletePending(action): void {
        kv.delete(`pending:${action}`);
      },
      putApplied(action, applied): void {
        kv.put<AppliedChatPost>(`applied:${action}`, applied);
      },
      getApplied(action): AppliedChatPost | undefined {
        return kv.get<AppliedChatPost>(`applied:${action}`);
      },
      deleteApplied(action): void {
        kv.delete(`applied:${action}`);
      },
    };
  }
}
