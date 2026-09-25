# Independent inventory module

This complete third module starts with a custom ontology, without Schema.org or changes to the
service core. `module.json` carries explicit constraints, scopes, command routing and migration
checksums. `migrations/0001_initial.sql` creates typed, tenant-keyed storage and the standard
command-handler function; the privileged publisher installs and registers it transactionally.

After publication, an operator separately grants the binding `inventory.read`/`inventory.write`
and enables this module for the datastore. Publication itself creates no tenant or grant. Send
`inventory.register` with `{ "label": "Laptop", "serial": "SN42" }` through the ordinary command
endpoint and read the asset through the ordinary records endpoint. Duplicate serials within one
datastore conflict; different datastores may reuse a serial. Core command execution supplies the
journal, idempotency, current revision, trusted identity and shared read projection.

This example supports registration only. It does not advertise update/delete operations or a full
asset-management workflow. SQL installation is privileged deployment of reviewed code, never
execution of arbitrary end-user SQL. The tests in the model package verify publication artefacts;
the service integration suite is responsible for executing the SQL and proving tenant isolation.
