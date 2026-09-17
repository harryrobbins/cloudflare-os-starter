# Inter-Gadget Connectivity, Data Connectors, and Service APIs in Cloudflare OS

Code trace and architecture analysis of inter-gadget communication, data sharing/connectors, and service APIs in Cloudflare OS. Written 2026-09-17 against the pinned submodule at `cloudflare-os` commit `90f0591` and starter integrations in `packages/custom-gatekeeper/`. Paths are relative to `cloudflare-os/` unless prefixed with repository root paths.

---

## Headline

1. **Can one gadget connect to another gadget's data as a connector?**
   **Not directly today.** In the current runtime, attempting to bind a gadget directly to another gadget throws an explicit error: `Gadget-to-gadget bindings are not supported yet.` ([`packages/workshop-backend/src/overseer.ts:1832`](cloudflare-os/packages/workshop-backend/src/overseer.ts#L1832)). Furthermore, each gadget runs inside an isolated Durable Object facet with private DO storage (KV/SQLite), and gadget dynamic workers have `globalOutbound: null` with sandboxed iframes (`connect-src 'none'`), preventing direct peer-to-peer network calls.
   
   However, the multi-gadget architecture plan ([`cloudflare-os/plans/multi-gadget.md:27`](cloudflare-os/plans/multi-gadget.md#L27)) was designed with a shared workpiece ID namespace specifically so that gadget-to-gadget bindings can be introduced in a future release.

2. **Can a gadget be essentially a service with an API that exposes functions other gadgets can call?**
   In Cloudflare OS, a service with an API that exposes callable functions to gadgets is **not a Gadget—it is a Gatekeeper**.
   
   In the Cloudflare OS kernel architecture:
   * **Gadgets** = Applications / Processes (user-facing UI in an iframe, private DO state, internal business logic).
   * **Gatekeepers** = Services / Drivers / Connectors (typed RPC sessions, shared or external data access, observation auditing, action approval queues, and optional HTTP endpoints).

To provide callable service functions and shared data across gadgets, you implement a **Gatekeeper** (such as [`packages/custom-gatekeeper`](packages/custom-gatekeeper)). Multiple gadgets in the workspace bind to the same Gatekeeper and invoke its methods as standard async RPC calls on `env.SERVICE_NAME`.

---

## 1. Gadget Sandboxing and Storage Isolation

Every gadget in Cloudflare OS executes within a tightly restricted sandbox:

### Runtime sandbox
* **Dynamic Worker Loader**: Gadgets run inside dynamic worker facets loaded via `this.env.LOADER.get(...)` ([`overseer.ts:2374-2422`](cloudflare-os/packages/workshop-backend/src/overseer.ts#L2374)).
* **No Outbound Network**: Dynamic worker configurations specify `globalOutbound: null` ([`overseer.ts:2416`](cloudflare-os/packages/workshop-backend/src/overseer.ts#L2416)). Gadgets cannot make outbound `fetch()` requests or open external WebSockets.
* **No Inbound HTTP Routes**: Incoming HTTP requests to the deployment hit the Router and Workshop Workers. Gadgets do not have public or private HTTP endpoints; they receive calls exclusively via RPC ([`docs/research/gadget-collaboration-runtime.md:192`](docs/research/gadget-collaboration-runtime.md#L192)).
* **Facet-Scoped Storage**: State is backed by Durable Object storage inside the Overseer DO facet (`id: facetName`). One gadget cannot access another gadget's KV or SQLite DO storage ([`overseer.ts:2469-2476`](cloudflare-os/packages/workshop-backend/src/overseer.ts#L2469)).

### Client sandbox
* Gadget frontends (`client.js`) run in an opaque-origin `srcDoc` iframe (`<iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox">`).
* Strict CSP: `connect-src 'none'; default-src 'none'; ...` ([`packages/workshop-frontend/src/GadgetUI.tsx:105-115`](cloudflare-os/packages/workshop-frontend/src/GadgetUI.tsx#L105)).
* Communication occurs strictly over a Cap'n Web RPC session over `MessageChannel` connected to the parent frame and forwarded to the backend facet.

---

## 2. Gadget-to-Gadget Bindings: Current Limitations vs Architecture

### Current code limit
When a binding is created on a gadget via `bindWorkpiece()` ([`overseer.ts:1812-1841`](cloudflare-os/packages/workshop-backend/src/overseer.ts#L1812)), the kernel explicitly verifies that the target is a gatekeeper:

```ts
// packages/workshop-backend/src/overseer.ts:1830-1835
if (!this.storage.gatekeepers.get(target)) {
  if (this.storage.gadgets.get(target)) {
    throw new Error(`Gadget-to-gadget bindings are not supported yet.`);
  }
  throw new Error(`No such gatekeeper: ${target}`);
}
```

Similarly, when constructing the worker environment in `getEnvForLoader()` ([`overseer.ts:2142-2150`](cloudflare-os/packages/workshop-backend/src/overseer.ts#L2142)), visible bindings are hardcoded to create loopbacks of type `"gatekeeper"`:

```ts
// packages/workshop-backend/src/overseer.ts:2146-2148
for (let [name, edge] of this.visibleBindings(gadget, forChatId)) {
  env[name] = this.makeBindingLoopback({type: "gatekeeper", id: edge.target}, caller);
}
```

### Architecture and roadmap
Under the multi-gadget architecture design ([`cloudflare-os/plans/multi-gadget.md`](cloudflare-os/plans/multi-gadget.md)):
1. **Unified Workpiece Namespace**: Both gadgets and gatekeepers share a single numeric ID counter (`WorkpieceId = number`), so references are unambiguous across types.
2. **Binding Edges**: Gadget bindings are edge records stored on the gadget record (`bindings: Record<string, BindingRecord>`, where `BindingRecord = {target: WorkpieceId, blueprintAnnotation?}`).
3. **Loopback Infrastructure Already Implemented**: The underlying loopback generator (`makeBindingLoopback` and `startGatekeeperSession` in [`overseer.ts:2772-2792`](cloudflare-os/packages/workshop-backend/src/overseer.ts#L2772)) already supports `{type: "gadget", id}` targets:
   ```ts
   case "gadget": {
     if (caller.from === "agent") {
       this.#getOrCreateCapturedActions(caller.chatId).accessedGadget = true;
     }
     let chatId = "chatId" in caller ? caller.chatId : undefined;
     return this.getGadgetFacet(target.id, chatId);
   }
   ```
4. **Why it is not enabled yet**: Lifecycle management (circular dependencies, facet abort cascading on restarts, permission boundaries, and blueprint export/import semantics for gadget dependencies) requires resolution before direct gadget-to-gadget binding can be enabled safely.

---

## 3. The Platform Primitive: Gatekeepers as Services & Connectors

In Cloudflare OS, if an entity needs to:
* Expose an API that other components call
* Provide or mediate data access (e.g. database, external API, shared state)
* Act as a connector (GitHub, Slack, Supabase, Google, custom REST/GraphQL)
* Enforce security policies and observation logging

**It should be built as a Gatekeeper.**

### Operating System Analogy

| Traditional OS | Cloudflare OS Concept | Role |
| :--- | :--- | :--- |
| **Executable / Code Template** | Blueprint (`.gadget` archive) | Template code defining client and server behavior. |
| **Process / User Application** | Gadget | Interactive app instance with sandboxed UI and private storage. |
| **Device Driver / System Service** | Gatekeeper | Typed RPC service providing data, APIs, and external connectivity. |
| **Kernel / IPC Manager** | Workshop Backend (`OverseerDurableObject`) | Sandboxing, capability access control, and RPC loopback routing. |

---

## 4. How a Service API Gatekeeper Works

The starter repository provides an end-to-end template for this in [`packages/custom-gatekeeper/`](packages/custom-gatekeeper).

### Step 1: Define the RPC API Interface
Create the TypeScript interface representing the API methods gadgets may call:

```ts
// packages/custom-gatekeeper/src/types.d.ts
export interface CustomSession {
  getDeploymentInfo(): Promise<CustomDeploymentInfo>;
  queryData(filter: string): Promise<DataItem[]>;
  mutateRecord(id: string, update: any): Promise<void>;
}
```

### Step 2: Implement the Session Class (`RpcTarget`)
The session handles the incoming RPC calls from gadgets. It can interact with Durable Object storage, D1, KV, external APIs, or other Cloudflare services:

```ts
// packages/custom-gatekeeper/src/custom.ts
import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";

@validateRpc()
export class CustomSessionImpl extends RpcTarget implements CustomSession {
  readonly #approvalQueue: ObservationQueue;
  readonly #db: D1Database;

  constructor(approvalQueue: ObservationQueue, db: D1Database) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#db = db;
  }

  async queryData(filter: string): Promise<DataItem[]> {
    // Record observation for security auditing
    await this.#approvalQueue.authorizeObservation({
      title: "Query service data",
      description: `Queried records with filter: ${filter}`,
    });

    return await this.#db.prepare("SELECT * FROM items WHERE type = ?").bind(filter).all();
  }
}
```

### Step 3: Implement the Gatekeeper Durable Object
The `Gatekeeper` class exports resource metadata, TypeScript types, and creates sessions:

```ts
@validateRpc()
export class CustomGatekeeper extends DurableObject<Cloudflare.Env> implements Gatekeeper<CustomSession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: "custom://service-api",
      title: "Shared Service API",
      snippet: "Exposes data queries and mutations to workspace gadgets.",
      suggestedBindingName: "DATA_SERVICE",
      tsType: "CustomSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE; // Exposes types to Monaco and the AI agent
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<CustomSession> {
    return new CustomSessionImpl(approvalQueue.dup(), this.env.DB);
  }
}
```

### Step 4: Bind to Multiple Gadgets
In the Cloudflare OS UI (under the **Connections** tab) or programmatically via the agent (`setGadgetBinding`), the Gatekeeper is bound to Gadget 1 and Gadget 2 under a chosen name (e.g. `DATA_SERVICE`).

### Step 5: Consume from Gadget `server.js`
In any gadget's `server.js`, the Gatekeeper appears on `env.DATA_SERVICE`. Methods are called using standard asynchronous Cap'n Web RPC:

```js
// Gadget server.js
export class Gadget {
  constructor(ctx, env) {
    this.env = env;
  }

  async loadItems() {
    // Direct RPC call to the Gatekeeper session
    const items = await this.env.DATA_SERVICE.queryData("active");
    return items;
  }
}
```

---

## 5. Comparison: Gatekeeper vs Gadget for APIs

| Feature | Gadget | Gatekeeper |
| :--- | :--- | :--- |
| **Primary Purpose** | User-facing application with interactive UI. | Shared service, connector, or API provider. |
| **Callable by other Gadgets** | ❌ Not currently supported (`overseer.ts:1832`). | ✅ Yes, via `env.<BINDING_NAME>`. |
| **Multi-Gadget Sharing** | ❌ Storage is isolated to its own facet. | ✅ Multiple gadgets can bind to the same instance. |
| **External Network (`fetch`)** | ❌ Blocked (`globalOutbound: null`). | ✅ Permitted (can access internet/external APIs). |
| **HTTP Endpoints** | ❌ None (receives only Cap'n Web RPC). | ✅ Supported (routes proxied under `/gatekeeper/<name>`). |
| **Auditing & Approval** | ❌ Internal to gadget. | ✅ Integrates with `ApprovalQueue` for action approvals and observation logging. |
| **AI Agent Access** | ✅ Accessible in chat via `env.GADGET_NAME`. | ✅ Accessible in chat via `env.BINDING_NAME`. |

---

## 6. Summary and Recommendations

1. **For inter-gadget data sharing**: Do not attempt to wire gadgets directly to each other. Instead, use a shared Gatekeeper (e.g. backed by D1, KV, SQLite, or an external backend) bound to both gadgets.
2. **For services with APIs**: Implement a custom Gatekeeper using `packages/custom-gatekeeper/` as a template. It gives you typed RPC bindings in `env`, audit logging, multi-gadget connectivity, and external data access by design.
3. **For AI agent orchestration**: If two existing gadgets need their data synced without a Gatekeeper, the AI coding agent can be instructed in chat to read data from Gadget A and write it to Gadget B, as the agent has access to all workspace workpieces in `env`.
