// `SearchService`: the sources' door, over a service binding with `entrypoint: "SearchService"` and
// `props: { source }`. The source is taken from the binding's props, which only deploy.ts writes,
// and never from the batch: a source cannot claim to be another.

import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";

import {
  INDEX_NAME,
  type DenseRecallRequest,
  type DenseRecallResult,
  type IngestBatch,
  type IngestResult,
} from "./shared/contract.js";
import { indexStub, type SearchEnv } from "./env.js";
import { inputError } from "./do/util.js";

export type SearchServiceProps = {
  /** e.g. "chat". Every id and scope this binding writes must start with `<source>:`. */
  source: string;
};

@validateRpc()
export class SearchService extends WorkerEntrypoint<SearchEnv, SearchServiceProps> {
  /** Pushes documents, deletes and ACL changes for this binding's source. */
  async ingest(batch: IngestBatch): Promise<IngestResult> {
    return indexStub(this.env, INDEX_NAME).ingest(this.#source(), batch);
  }

  /**
   * Chat's phase-1 fusion: dense recall restricted to the scopes the caller already resolved, and to
   * this binding's own source prefix.
   */
  async denseRecall(request: DenseRecallRequest): Promise<DenseRecallResult> {
    const scopes = Array.isArray(request?.scopes) ? request.scopes : [];
    return indexStub(this.env, INDEX_NAME).denseRecall({ kind: "delegated", source: this.#source(), scopes }, request);
  }

  #source(): string {
    const source = this.ctx.props?.source;
    if (typeof source !== "string" || source.length === 0) {
      throw inputError("this SearchService binding has no source in its props.");
    }
    return source;
  }
}
