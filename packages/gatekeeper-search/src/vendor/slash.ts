// `/find <words>`: searches the index and inserts the top hits as an ordinary user message, which the
// agent then reads with `SEARCH.open()`. The authorizer is authorization and audit only; the hits
// are observed through it before any of them reaches the message.

import { RpcTarget, type RpcStub } from "cloudflare:workers";
import type {
  ObservationAuthorizer,
  SlashCommandDescriptor,
  SlashCommandProvider,
  SlashCommandResult,
} from "@gadgets/workshop-shared/gatekeeper";

import type { SearchIndexApi } from "../shared/contract.js";
import { describeSource, runSearch } from "./session.js";

export const FIND_COMMAND: SlashCommandDescriptor = {
  id: "find",
  name: "find",
  description: "Search this deployment's shared content and hand the agent the top matches",
};

const FIND_LIMIT = 8;

export class SearchSlashCommands extends RpcTarget implements SlashCommandProvider {
  readonly #index: Pick<SearchIndexApi, "search">;
  readonly #partition: string;
  readonly #publicBaseUrl: string;

  constructor(index: Pick<SearchIndexApi, "search">, partition: string, publicBaseUrl: string) {
    super();
    this.#index = index;
    this.#partition = partition;
    this.#publicBaseUrl = publicBaseUrl;
  }

  async list(): Promise<SlashCommandDescriptor[]> {
    return [FIND_COMMAND];
  }

  async invoke(
    id: string,
    args: string,
    authorizer: RpcStub<ObservationAuthorizer>,
  ): Promise<SlashCommandResult> {
    if (id !== FIND_COMMAND.id) throw new Error(`Unknown command: ${id}`);
    return expandFind(this.#index, this.#partition, this.#publicBaseUrl, args, authorizer);
  }

  [Symbol.dispose](): void {}
}

export async function expandFind(
  index: Pick<SearchIndexApi, "search">,
  partition: string,
  publicBaseUrl: string,
  args: string,
  authorizer: Pick<ObservationAuthorizer, "authorizeObservation">,
): Promise<SlashCommandResult> {
  const query = args.trim();
  if (query.length === 0) {
    return { message: "/find needs something to look for, for example `/find onboarding docs`." };
  }
  const answer = await runSearch(
    index,
    { kind: "agent", accountId: partition },
    authorizer,
    publicBaseUrl,
    query,
    { limit: FIND_LIMIT },
  );
  if (answer.hits.length === 0) {
    return {
      message:
        `Find what this deployment has about: ${query}\n\n` +
        "Omni-search found nothing for that. Try other words, or search with SEARCH.search().",
    };
  }
  const lines = answer.hits.map((hit, index) => {
    const title = hit.url === null ? hit.title : `[${hit.title}](${hit.url})`;
    const where = [describeSource(hit.source), hit.container, hit.author].filter(Boolean).join(" · ");
    const excerpt = hit.excerpt.replace(/\s+/gu, " ").trim().slice(0, 200);
    return `${index + 1}. ${title} — ${where}\n   ${excerpt}\n   documentId: \`${hit.documentId}\``;
  });
  return {
    message:
      `Find what this deployment has about: ${query}\n\n` +
      `Top matches from omni-search${answer.semantic ? "" : " (word matches only)"}:\n\n` +
      `${lines.join("\n")}\n\n` +
      "Read the relevant ones with SEARCH.open(documentId), then use them and cite their links.",
  };
}
