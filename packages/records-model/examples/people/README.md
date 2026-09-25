# People profiles: a rule-bearing module

The first module whose permissions live in its data model. Postgres enforces every rule, so they
hold for every client: cloudflare-os gadgets, SDK users and external systems alike.

| Rule | Where it lives |
| --- | --- |
| Anyone with `people.read` sees names and job titles | `present_people_v1.profile` view |
| Only the owner or an admin sees `email` and `telephone` (otherwise absent) | Column masks in the same view; the profile marks them `restricted` |
| Only the owner or an admin may update a profile | RLS `UPDATE` policy; handlers run as `records_commander` |
| New profiles are owned by whoever created them | `records.stamp_row()` sets `owner` from `records.actor()` |
| Ownership changes only through `people.transfer` | The stamp trigger refuses any other owner change; transfer bumps the permission epoch |
| Only the owner at each change, and admins, see history | `present_people_v1.history` view over the journal |

`admin` is a role held in `records_private.actor_roles`, granted by operator tooling
(`manage.ts role grant <datastore> <actor> admin`), never by a token or a gadget.

Commands: `people.create {name, job_title?, email?, telephone?}`, `people.update {id, ...}` (send
an empty string to clear an optional field) and `people.transfer {id, owner}`. Updates and
transfers need the current revision.
