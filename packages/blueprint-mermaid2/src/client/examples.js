import catalog from '../../../gatekeeper-mermaid2/src/generated/examples.json';

export const examples = {
  architecture: {
    name: 'System architecture',
    mermaid: `flowchart TB
  visitor[Visitor] --> web[Web app]
  web --> api[API gateway]

  subgraph services[Application services]
    api --> auth[Authentication]
    api --> orders[Order service]
    orders --> queue[Event queue]
    queue --> worker[Background worker]
  end

  auth --> db[(Database)]
  orders --> db
  worker --> storage[(Object storage)]

  classDef entry fill:#e9efda,stroke:#64724b
  class visitor,web entry
`,
    d2: `direction: down

visitor: Visitor
web: Web app
api: API gateway

services: Application services {
  auth: Authentication
  orders: Order service
  queue: Event queue
  worker: Background worker
  orders -> queue
  queue -> worker
}

db: Database { shape: cylinder }
storage: Object storage { shape: cylinder }

visitor -> web -> api
api -> services.auth
api -> services.orders
services.auth -> db
services.orders -> db
services.worker -> storage

visitor.style.fill: "#e9efda"
web.style.fill: "#e9efda"
`,
  },
  decision: {
    name: 'Decision flow',
    mermaid: `flowchart TD
  start([New request]) --> valid{Valid input?}
  valid -->|Yes| cache{In cache?}
  valid -->|No| reject[Return error]
  cache -->|Yes| response[Send response]
  cache -->|No| compute[Compute result]
  compute --> save[Update cache]
  save --> response
`,
    d2: `direction: down
start: New request { shape: oval }
valid: Valid input? { shape: diamond }
cache: In cache? { shape: diamond }
reject: Return error
response: Send response
compute: Compute result
save: Update cache

start -> valid
valid -> cache: Yes
valid -> reject: No
cache -> response: Yes
cache -> compute: No
compute -> save -> response
`,
  },
  sequence: {
    name: 'Request lifecycle',
    mermaid: `sequenceDiagram
  participant Browser
  participant API
  participant Database
  Browser->>API: Request account
  API->>Database: Look up account
  Database-->>API: Account record
  API-->>Browser: Account details
`,
    d2: `shape: sequence_diagram
browser: Browser
api: API
db: Database

browser -> api: Request account
api -> db: Look up account
db -> api: Account record
api -> browser: Account details
`,
  },
};

Object.assign(examples.architecture, { type: 'Architecture', complexity: 'Starter', description: 'A small architecture with services and shared stores. Try the larger native D2 topologies to explore TALA without a fixed direction.' });
Object.assign(examples.decision, { type: 'Flowchart', complexity: 'Starter', description: 'A compact decision flow with labeled branches and a shared destination.' });
Object.assign(examples.sequence, { type: 'Sequence', complexity: 'Starter', description: 'A request across three participants. Sequence diagrams use D2’s specialized sequence layout with every engine.' });
Object.assign(examples, catalog);

export function exampleOptions(language) {
  const groups = new Map();
  for (const [key, example] of Object.entries(examples)) {
    if (!example[language]) continue;
    if (!groups.has(example.type)) groups.set(example.type, []);
    groups.get(example.type).push(`<option value="${key}">${example.name} · ${example.complexity}</option>`);
  }
  return '<option value="">Choose a diagram…</option>' + [...groups].map(([type, options]) => `<optgroup label="${type}">${options.join('')}</optgroup>`).join('');
}
