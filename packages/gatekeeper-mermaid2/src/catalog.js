// D2 variants of Mermaid examples are generated at build time by mermaid2d2.
// Native D2 examples keep their richer containers and unconstrained directions.
export const catalog = {
  commerce: {
    name: 'Event-driven commerce', type: 'Architecture', complexity: 'Complex',
    description: 'Nested services, shared stores, event fan-out, and a retry cycle. Compare how the engines route cross-service connections.',
    mermaid: `flowchart LR
  customer[Customer] --> edge[Edge gateway]
  partner[Partner API] --> edge
  subgraph core[Commerce services]
    edge --> identity[Identity]
    edge --> catalog[Catalog]
    edge --> checkout[Checkout]
    checkout --> pricing[Pricing]
    checkout --> inventory[Inventory]
    checkout --> payments[Payments]
    checkout --> orders[Orders]
    orders --> shipping[Shipping]
    inventory --> catalog
  end
  subgraph events[Event platform]
    orders --> bus[Event bus]
    payments --> bus
    shipping --> bus
    bus --> notifications[Notifications]
    bus --> analytics[Analytics]
    bus --> fraud[Fraud detection]
    bus --> audit[Audit trail]
    bus --> retry[Retry queue]
    retry --> orders
  end
  subgraph stores[Data stores]
    identity --> accounts[(Accounts)]
    catalog --> products[(Products)]
    inventory --> products
    orders --> ledger[(Order ledger)]
    payments --> ledger
    analytics --> warehouse[(Warehouse)]
    audit --> archive[(Archive)]
  end
  notifications --> email[Email provider]
  payments --> bank[Payment network]
  shipping --> carrier[Carrier API]
  fraud --> payments
`,
  },
  platform: {
    name: 'Streaming data platform', type: 'Architecture', complexity: 'Complex',
    description: 'Batch and streaming ingestion converge on processing and serving layers, with a replay cycle and shared reference data.',
    mermaid: `flowchart LR
  subgraph sources[Sources]
    app[Applications]
    devices[IoT devices]
    crm[CRM export]
    logs[Service logs]
  end
  subgraph ingestion[Ingestion]
    app --> broker[Message broker]
    devices --> broker
    logs --> collector[Log collector]
    collector --> broker
    crm --> batch[Batch import]
  end
  subgraph processing[Processing]
    broker --> normalize[Normalize]
    normalize --> enrich[Enrich]
    enrich --> validate{Valid?}
    validate -->|Yes| aggregate[Aggregate]
    validate -->|No| quarantine[Quarantine]
    quarantine --> replay[Replay]
    replay --> normalize
    batch --> transform[Transform]
  end
  subgraph storage[Storage]
    aggregate --> lake[(Data lake)]
    transform --> lake
    aggregate --> hot[(Hot store)]
    lake --> warehouse[(Warehouse)]
    enrich --> reference[(Reference data)]
  end
  subgraph serving[Serving]
    hot --> api[Query API]
    warehouse --> bi[BI dashboards]
    lake --> training[Model training]
    training --> registry[Model registry]
    registry --> inference[Inference]
    inference --> api
  end
`,
  },
  delivery: {
    name: 'Release pipeline', type: 'Flowchart', complexity: 'Detailed',
    description: 'Parallel checks, decision gates, and rollback paths give the layered engines a useful comparison with TALA.',
    mermaid: `flowchart TD
  commit[Push commit] --> build[Build artifacts]
  build --> unit[Unit tests]
  build --> integration[Integration tests]
  build --> scan[Security scan]
  unit --> gate{Checks pass?}
  integration --> gate
  scan --> gate
  gate -->|No| fix[Fix and retry]
  fix --> commit
  gate -->|Yes| staging[Deploy staging]
  staging --> smoke[Smoke tests]
  smoke --> approval{Approved?}
  approval -->|No| stop[Stop release]
  approval -->|Yes| canary[Canary 5%]
  canary --> healthy{Healthy?}
  healthy -->|Yes| rollout[Roll out 100%]
  healthy -->|No| rollback[Rollback]
  rollout --> monitor[Monitor production]
  monitor --> incident{Regression?}
  incident -->|Yes| rollback
  incident -->|No| done([Release complete])
`,
  },
  incident: {
    name: 'Incident state machine', type: 'State', complexity: 'Detailed',
    description: 'Composite states, cycles, and several terminal transitions show container and return-edge routing.',
    mermaid: `stateDiagram-v2
  [*] --> Healthy
  Healthy --> Investigating: Alert fired
  state Investigating {
    [*] --> Triage
    Triage --> Diagnosing: Assign owner
    Diagnosing --> Mitigating: Identify cause
    Mitigating --> Verifying: Apply fix
    Verifying --> Diagnosing: Still failing
    Verifying --> [*]: Stable
  }
  Investigating --> Monitoring: Mitigated
  Investigating --> Escalated: Severity increases
  Escalated --> Investigating: Specialists join
  Monitoring --> Healthy: Recovery confirmed
  Monitoring --> Investigating: Alert repeats
  Healthy --> Maintenance: Planned change
  Maintenance --> Healthy: Change complete
`,
  },
  domain: {
    name: 'Commerce domain model', type: 'Class', complexity: 'Detailed',
    description: 'Eight classes with fields, methods, inheritance, and shared dependencies. Compare layouts around measured class shapes.',
    mermaid: `classDiagram
  class Entity {
    +UUID id
    +Date createdAt
  }
  class Customer {
    +String email
    +placeOrder()
  }
  class Order {
    +String status
    +Decimal total
    +confirm()
    +cancel()
  }
  class OrderLine {
    +int quantity
    +Decimal unitPrice
  }
  class Product {
    +String name
    +String sku
  }
  class Payment {
    +Decimal amount
    +authorize()
    +refund()
  }
  class Shipment {
    +String trackingCode
    +dispatch()
  }
  class Address {
    +String street
    +String country
  }
  Entity <|-- Customer
  Entity <|-- Order
  Entity <|-- Product
  Customer --> Order : places
  Customer --> Address : owns
  Order *-- OrderLine : contains
  OrderLine --> Product : references
  Order --> Payment : paid by
  Order --> Shipment : fulfilled by
  Shipment --> Address : delivered to
`,
  },
  database: {
    name: 'Marketplace database', type: 'ER', complexity: 'Complex',
    description: 'Eight SQL tables with primary keys, foreign keys, and multiple join paths.',
    mermaid: `erDiagram
  CUSTOMER ||--o{ ORDER : places
  CUSTOMER ||--o{ ADDRESS : owns
  ORDER ||--|{ ORDER_LINE : contains
  PRODUCT ||--o{ ORDER_LINE : appears_in
  CATEGORY ||--o{ PRODUCT : groups
  ORDER ||--o{ PAYMENT : receives
  ORDER ||--o{ SHIPMENT : produces
  ADDRESS ||--o{ SHIPMENT : destination
  CUSTOMER {
    int id PK
    string email
    string name
  }
  ORDER {
    int id PK
    int customer_id FK
    string status
    decimal total
  }
  ORDER_LINE {
    int id PK
    int order_id FK
    int product_id FK
    int quantity
  }
  PRODUCT {
    int id PK
    int category_id FK
    string sku
    decimal price
  }
  CATEGORY {
    int id PK
    string name
  }
  ADDRESS {
    int id PK
    int customer_id FK
    string city
  }
  PAYMENT {
    int id PK
    int order_id FK
    decimal amount
  }
  SHIPMENT {
    int id PK
    int order_id FK
    int address_id FK
    string tracking
  }
`,
  },
  checkout: {
    name: 'Checkout saga', type: 'Sequence', complexity: 'Detailed',
    description: 'Six participants, events, and alternate compensation paths. Sequence diagrams use D2’s dedicated sequence layout with every engine.',
    mermaid: `sequenceDiagram
  participant Customer
  participant Checkout
  participant Inventory
  participant Payments
  participant Orders
  participant Events
  Customer->>Checkout: Submit cart
  Checkout->>Inventory: Reserve stock
  Inventory-->>Checkout: Reservation confirmed
  Checkout->>Payments: Authorize payment
  alt Payment approved
    Payments-->>Checkout: Authorization token
    Checkout->>Orders: Create order
    Orders-->>Checkout: Order ID
    Orders->>Events: Order created
    Events->>Inventory: Confirm reservation
    Checkout-->>Customer: Order confirmed
  else Payment rejected
    Payments-->>Checkout: Declined
    Checkout->>Inventory: Release reservation
    Inventory-->>Checkout: Stock released
    Checkout-->>Customer: Try another payment
  end
`,
  },
  roadmap: {
    name: 'Product roadmap', type: 'Mindmap', complexity: 'Detailed',
    description: 'A hierarchy with four workstreams and 23 nodes. TALA balances the converted tree; Dagre and ELK give more directional arrangements.',
    mermaid: `mindmap
  root((Product roadmap))
    Experience
      Onboarding
        Guided setup
        Demo workspace
      Accessibility
        Keyboard navigation
        Contrast audit
    Platform
      Reliability
        Health checks
        Failover
      Performance
        Query cache
        Load testing
    Integrations
      Developer API
      Webhooks
      Data import
    Operations
      Billing
      Audit logs
      Usage analytics
`,
  },
  c4: {
    name: 'Banking system context', type: 'C4', complexity: 'Detailed',
    description: 'People, systems, and external dependencies converted from C4 notation. D2 uses its own shapes and styling.',
    mermaid: `C4Context
  Person(customer, "Bank customer", "Manages accounts")
  Person(support, "Support agent", "Helps customers")
  System(bank, "Digital banking", "Accounts and transactions")
  System(identity, "Identity provider", "Sign-in and MFA")
  System(payments, "Payment network", "Transfers funds")
  System(email, "Email service", "Sends notifications")
  System(risk, "Risk platform", "Evaluates transactions")
  System(reporting, "Reporting", "Operational analytics")
  Rel(customer, bank, "Uses")
  Rel(support, bank, "Supports")
  Rel(bank, identity, "Authenticates")
  Rel(bank, payments, "Transfers")
  Rel(bank, email, "Notifies")
  Rel(bank, risk, "Screens")
  Rel(bank, reporting, "Publishes events")
  Rel(risk, payments, "Flags suspicious transfers")
`,
  },
  mesh: {
    name: 'Multi-region service mesh', type: 'D2 architecture', complexity: 'Complex',
    description: 'D2-only: nested regions, shared observability, replication cycles, and no fixed direction. A showcase for TALA’s orthogonal placement and routing.',
    d2: `users: Global users {shape: person}
dns: Global traffic manager {shape: hexagon}
eu: Europe {
  ingress: Ingress
  services: Services {
    api: API
    worker: Worker
    cache: Cache {shape: cylinder}
    api -> cache
    api -> worker
  }
  db: Database {shape: cylinder}
  ingress -> services.api
  services.api -> db
  services.worker -> db
}
us: Americas {
  ingress: Ingress
  services: Services {
    api: API
    worker: Worker
    cache: Cache {shape: cylinder}
    api -> cache
    api -> worker
  }
  db: Database {shape: cylinder}
  ingress -> services.api
  services.api -> db
  services.worker -> db
}
ap: Asia Pacific {
  ingress: Ingress
  services: Services {
    api: API
    worker: Worker
    cache: Cache {shape: cylinder}
    api -> cache
    api -> worker
  }
  db: Database {shape: cylinder}
  ingress -> services.api
  services.api -> db
  services.worker -> db
}
control: Shared control plane {
  config: Configuration
  metrics: Metrics
  traces: Traces
  secrets: Secrets
}
users -> dns
dns -> eu.ingress
dns -> us.ingress
dns -> ap.ingress
eu.db <-> us.db: replicate
us.db <-> ap.db: replicate
eu.services.api -> control.metrics
us.services.api -> control.metrics
ap.services.api -> control.metrics
eu.services.worker -> control.traces
us.services.worker -> control.traces
ap.services.worker -> control.traces
control.config -> eu.ingress
control.config -> us.ingress
control.config -> ap.ingress
control.secrets -> eu.services.api
control.secrets -> us.services.api
control.secrets -> ap.services.api
`,
  },
  network: {
    name: 'Zero-trust network', type: 'D2 architecture', complexity: 'Detailed',
    description: 'D2-only: entry points, nested trust boundaries, and shared inspection services. Direction is unconstrained for TALA.',
    d2: `employees: Employees {shape: person}
contractors: Contractors {shape: person}
devices: Managed devices
public: Public internet {shape: cloud}
access: Access gateway
security: Security services {
  identity: Identity
  posture: Device posture
  policy: Policy engine
  audit: Audit log {shape: cylinder}
  identity -> policy
  posture -> policy
  policy -> audit
}
private: Private network {
  connector: Tunnel connector
  apps: Applications {
    internal: Internal portal
    finance: Finance system
    admin: Admin console
  }
  data: Data services {
    db: Database {shape: cylinder}
    vault: Secrets vault
  }
  connector -> apps.internal
  connector -> apps.finance
  connector -> apps.admin
  apps.internal -> data.db
  apps.finance -> data.db
  apps.admin -> data.vault
}
employees -> access
contractors -> access
devices -> security.posture
access -> security.identity
access -> security.policy: evaluate
access -> private.connector: authorized
access -> public: inspected
private.apps.admin -> security.audit
private.apps.finance -> security.audit
`,
  },
};
