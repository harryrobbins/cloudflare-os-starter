// `SearchGatekeeper`: the Durable Object facet the Workshop installs into every workspace.
//
// It is the ambient singleton of the auto-provisioned search account (`account.ts`), so there is one
// per workspace. Its own storage holds two things: index changes awaiting approval (the overseer
// passes an action back as a bare number), and this workspace's partition -- a random id minted on
// first use that names the `account:<partition>` scope its gadgets' documents live in. A partition
// per workspace rather than per account is deliberate: a person who shares one workspace must not
// let collaborators search what gadgets in their other workspaces indexed.
//
// Observer policy: every observer is accepted. Everything reachable is either deployment-public
// (readable by everyone who can sign in) or was indexed by this same workspace's gadgets, which a
// collaborator on the workspace can already open.

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
  type SlashCommandProvider,
} from "@gadgets/workshop-shared/gatekeeper";

import { INDEX_NAME, type SearchIndexApi } from "../shared/contract.js";
import type { SearchEnv } from "../env.js";
import {
  SEARCH_INDEX_ACTION,
  SearchSessionImpl,
  batchFor,
  describeSource,
  type PendingIndexChange,
  type SearchActionStore,
} from "./session.js";
import { SearchSlashCommands } from "./slash.js";
import type { SearchSession } from "./types.js";
import TYPES_CODE from "./types-code.js";

/** Imbued by `SearchAccount.getSingletonGatekeeperClass()`. */
export type SearchGatekeeperProps = { accountId: string };

const PARTITION_KEY = "partition";

export function describeSearchResource(): ResourceDescription {
  return {
    url: "search://main",
    title: "Omni-search",
    snippet:
      "Search this deployment's shared content (public chat, Context Library, this workspace's " +
      "indexed documents) by meaning and by words, and read what it finds.",
    suggestedBindingName: "SEARCH",
    tsType: "SearchSession",
    hasSlashCommands: true,
  };
}

/** One catalog entry per source the agent can see, with its document count. */
export async function searchAgentCatalog(
  index: Pick<SearchIndexApi, "sources">,
  partition: string,
  authorizer: Pick<ObservationAuthorizer, "authorizeObservation">,
): Promise<AgentCatalog | null> {
  let sources;
  try {
    sources = (await index.sources({ kind: "agent", accountId: partition })).filter(
      (source) => source.documents > 0,
    );
  } catch {
    // A catalog goes into every turn's system prompt; an index that cannot answer must degrade to
    // "no catalog" rather than break every gadget in the workspace.
    return null;
  }
  if (sources.length === 0) return null;
  const entries = sources.map((source) => ({
    id: `source:${source.source}`,
    title: describeSource(source.source),
    description:
      `${source.documents} searchable document${source.documents === 1 ? "" : "s"}. Narrow a ` +
      `SEARCH.search() to it with \`source:${source.source}\`, then SEARCH.open() a hit to read it.`,
  }));
  await authorizer.authorizeObservation({
    title: "List searchable sources",
    description:
      `Read which sources (${entries.map((entry) => entry.title).join(", ")}) this deployment's ` +
      "omni-search index holds and how many documents each has.",
  });
  return boundAgentCatalog(entries);
}

@validateRpc()
export class SearchGatekeeper
  extends DurableObject<SearchEnv, SearchGatekeeperProps>
  implements Gatekeeper<SearchSession>
{
  async describe(): Promise<ResourceDescription> {
    return describeSearchResource();
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** Indexing only affects this workspace's own results, so a person may opt in to auto-apply it. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [SEARCH_INDEX_ACTION];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<SearchSession> {
    return new SearchSessionImpl({
      approvalQueue: approvalQueue.dup(),
      index: this.#index(),
      actions: this.#store(),
      partition: this.#partition(),
      publicBaseUrl: this.env.PUBLIC_BASE_URL,
    });
  }

  async getAgentCatalog(authorizer: RpcStub<ObservationAuthorizer>): Promise<AgentCatalog | null> {
    return searchAgentCatalog(this.#index(), this.#partition(), authorizer);
  }

  async getSlashCommandProvider(): Promise<SlashCommandProvider> {
    return new SearchSlashCommands(this.#index(), this.#partition(), this.env.PUBLIC_BASE_URL);
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  async removeObserver(_id: string): Promise<void> {}

  async applyAction(action: number): Promise<void> {
    const store = this.#store();
    const change = store.getPending(action);
    if (change === undefined) {
      // Already applied (the overseer may retry) or never submitted: nothing left to do.
      return;
    }
    try {
      await this.#index().ingest("gadget", batchFor(change, this.#partition()));
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "search.vendor.apply_failed",
          accountId: this.ctx.props.accountId,
          action,
          op: change.op,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
    store.putApplied(action, change);
    store.deletePending(action);
  }

  async rejectAction(action: number): Promise<void> {
    this.#store().deletePending(action);
  }

  /** Reverting an index is deleting what it added; a removal cannot be reverted (no copy is kept). */
  async revertAction(
    action: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    const store = this.#store();
    const applied = store.getApplied(action);
    if (applied === undefined) return { message: "Nothing to revert.", canRetry: false };
    if (applied.op !== "put") {
      return { message: "A removal from the search index cannot be reverted.", canRetry: false };
    }
    await this.#index().ingest("gadget", { deletes: [applied.document.id] });
    store.deleteApplied(action);
  }

  #index(): SearchIndexApi {
    const namespace = this.env.SEARCH_INDEX;
    return namespace.get(namespace.idFromName(INDEX_NAME)) as unknown as SearchIndexApi;
  }

  #partition(): string {
    const kv = this.ctx.storage.kv;
    let partition = kv.get<string>(PARTITION_KEY);
    if (partition === undefined) {
      partition = crypto.randomUUID();
      kv.put(PARTITION_KEY, partition);
    }
    return partition;
  }

  /** Keys: `counter:action`, `pending:<id>`, `applied:<id>`. */
  #store(): SearchActionStore {
    const kv = this.ctx.storage.kv;
    return {
      nextActionId(): number {
        const next = (kv.get<number>("counter:action") ?? 0) + 1;
        kv.put("counter:action", next);
        return next;
      },
      putPending(action, change): void {
        kv.put<PendingIndexChange>(`pending:${action}`, change);
      },
      getPending(action): PendingIndexChange | undefined {
        return kv.get<PendingIndexChange>(`pending:${action}`);
      },
      deletePending(action): void {
        kv.delete(`pending:${action}`);
      },
      putApplied(action, change): void {
        kv.put<PendingIndexChange>(`applied:${action}`, change);
      },
      getApplied(action): PendingIndexChange | undefined {
        return kv.get<PendingIndexChange>(`applied:${action}`);
      },
      deleteApplied(action): void {
        kv.delete(`applied:${action}`);
      },
    };
  }
}
