// What the contract suite needs to know about the service under test. Runtime-neutral (no Node
// imports): the same suite runs in Node against the Node server and inside workerd against the
// Worker's adapters.

export type ContractWorldInfo = {
  datastoreId: string;
  /** A datastore in the same organisation that the credentials are NOT bound to. */
  otherDatastoreId: string;
  projectId: string;
  projectKey: string;
  /** E-mail of the credentials' owner (Jira Basic authentication). */
  ownerEmail: string;
  /** rk1 credential with every record scope plus audit.read. */
  credential: string;
  /** rk1 credential with projects.read and issues.read only. */
  readOnlyCredential: string;
};

export type ContractTarget = ContractWorldInfo & {
  name: string;
  /** Origin the requests are addressed to. */
  baseUrl: string;
  /** Sends a request to the service (global fetch, or a Worker's fetch handler). */
  fetch(request: Request): Promise<Response>;
  /** A valid Access assertion for the API audience. */
  accessAssertion: string;
};
