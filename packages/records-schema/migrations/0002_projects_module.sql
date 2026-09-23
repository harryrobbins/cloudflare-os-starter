-- Projects module, API v1. Every table is scoped by (org_id, datastore_id), and composite foreign
-- keys include both, so a row can never reference another dataset's row.

CREATE SCHEMA projects;
REVOKE ALL ON SCHEMA projects FROM PUBLIC;
GRANT USAGE ON SCHEMA projects TO records_app;

INSERT INTO records.module_installations (module_id, version, api_versions, features)
VALUES ('projects', '1.0.0', '{1}', '{issues,comments,workflow,custom_fields}');

CREATE TABLE projects.workflow_states (
  org_id        uuid NOT NULL,
  datastore_id  uuid NOT NULL,
  key           text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  category      text NOT NULL CHECK (category IN ('todo', 'in_progress', 'done')),
  position      int NOT NULL,
  PRIMARY KEY (datastore_id, key),
  UNIQUE (org_id, datastore_id, key),
  FOREIGN KEY (org_id, datastore_id) REFERENCES records.datastores(org_id, id)
);

CREATE TABLE projects.workflow_transitions (
  org_id        uuid NOT NULL,
  datastore_id  uuid NOT NULL,
  from_state    text NOT NULL,
  to_state      text NOT NULL,
  PRIMARY KEY (datastore_id, from_state, to_state),
  FOREIGN KEY (org_id, datastore_id, from_state) REFERENCES projects.workflow_states(org_id, datastore_id, key),
  FOREIGN KEY (org_id, datastore_id, to_state) REFERENCES projects.workflow_states(org_id, datastore_id, key)
);

-- Custom field definitions. Values live in issues.custom_fields (validated JSONB); promoting a
-- field to a typed column is a migration, never a runtime change.
CREATE TABLE projects.custom_fields (
  org_id        uuid NOT NULL,
  datastore_id  uuid NOT NULL,
  key           text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  type          text NOT NULL CHECK (type IN ('text', 'number', 'boolean', 'enum')),
  options       text[] NOT NULL DEFAULT '{}',
  revision      int NOT NULL DEFAULT 1,
  PRIMARY KEY (datastore_id, key),
  FOREIGN KEY (org_id, datastore_id) REFERENCES records.datastores(org_id, id)
);

CREATE TABLE projects.projects (
  org_id             uuid NOT NULL,
  datastore_id       uuid NOT NULL,
  id                 uuid NOT NULL PRIMARY KEY,
  key                text NOT NULL CHECK (key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description        text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  next_issue_number  int NOT NULL DEFAULT 1,
  revision           int NOT NULL DEFAULT 1,
  created_by         uuid NOT NULL,
  updated_by         uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, datastore_id, id),
  UNIQUE (datastore_id, key),
  FOREIGN KEY (org_id, datastore_id) REFERENCES records.datastores(org_id, id),
  FOREIGN KEY (org_id, created_by) REFERENCES records.principals(org_id, id),
  FOREIGN KEY (org_id, updated_by) REFERENCES records.principals(org_id, id)
);

CREATE TABLE projects.issues (
  org_id         uuid NOT NULL,
  datastore_id   uuid NOT NULL,
  id             uuid NOT NULL PRIMARY KEY,
  project_id     uuid NOT NULL,
  number         int NOT NULL,
  title          text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description    text NOT NULL DEFAULT '' CHECK (length(description) <= 20000),
  state          text NOT NULL,
  priority       text NOT NULL DEFAULT 'none' CHECK (priority IN ('none', 'low', 'medium', 'high', 'urgent')),
  assignee_id    uuid,
  custom_fields  jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(custom_fields) = 'object'),
  revision       int NOT NULL DEFAULT 1,
  created_by     uuid NOT NULL,
  updated_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, datastore_id, id),
  UNIQUE (project_id, number),
  FOREIGN KEY (org_id, datastore_id, project_id) REFERENCES projects.projects(org_id, datastore_id, id),
  FOREIGN KEY (org_id, datastore_id, state) REFERENCES projects.workflow_states(org_id, datastore_id, key),
  FOREIGN KEY (org_id, assignee_id) REFERENCES records.principals(org_id, id),
  FOREIGN KEY (org_id, created_by) REFERENCES records.principals(org_id, id),
  FOREIGN KEY (org_id, updated_by) REFERENCES records.principals(org_id, id)
);
CREATE INDEX issues_updated ON projects.issues (datastore_id, updated_at DESC, id DESC);
CREATE INDEX issues_project_number ON projects.issues (datastore_id, project_id, number);

CREATE TABLE projects.comments (
  org_id        uuid NOT NULL,
  datastore_id  uuid NOT NULL,
  id            uuid NOT NULL PRIMARY KEY,
  issue_id      uuid NOT NULL,
  body          text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  author_id     uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, datastore_id, issue_id) REFERENCES projects.issues(org_id, datastore_id, id),
  FOREIGN KEY (org_id, author_id) REFERENCES records.principals(org_id, id)
);
CREATE INDEX comments_issue ON projects.comments (datastore_id, issue_id, created_at, id);

CREATE TRIGGER workflow_states_tenant BEFORE UPDATE ON projects.workflow_states FOR EACH ROW EXECUTE FUNCTION records.forbid_tenant_key_change();
CREATE TRIGGER custom_fields_tenant BEFORE UPDATE ON projects.custom_fields FOR EACH ROW EXECUTE FUNCTION records.forbid_tenant_key_change();
CREATE TRIGGER projects_tenant BEFORE UPDATE ON projects.projects FOR EACH ROW EXECUTE FUNCTION records.forbid_tenant_key_change();
CREATE TRIGGER issues_tenant BEFORE UPDATE ON projects.issues FOR EACH ROW EXECUTE FUNCTION records.forbid_tenant_key_change();

ALTER TABLE projects.workflow_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects.workflow_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects.custom_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects.issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects.comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY app_datastore ON projects.workflow_states TO records_app
  USING (org_id = records.current_org() AND datastore_id = records.current_datastore())
  WITH CHECK (org_id = records.current_org() AND datastore_id = records.current_datastore());
CREATE POLICY app_datastore ON projects.workflow_transitions TO records_app
  USING (org_id = records.current_org() AND datastore_id = records.current_datastore())
  WITH CHECK (org_id = records.current_org() AND datastore_id = records.current_datastore());
CREATE POLICY app_datastore ON projects.custom_fields TO records_app
  USING (org_id = records.current_org() AND datastore_id = records.current_datastore())
  WITH CHECK (org_id = records.current_org() AND datastore_id = records.current_datastore());
CREATE POLICY app_datastore ON projects.projects TO records_app
  USING (org_id = records.current_org() AND datastore_id = records.current_datastore())
  WITH CHECK (org_id = records.current_org() AND datastore_id = records.current_datastore());
CREATE POLICY app_datastore ON projects.issues TO records_app
  USING (org_id = records.current_org() AND datastore_id = records.current_datastore())
  WITH CHECK (org_id = records.current_org() AND datastore_id = records.current_datastore());
CREATE POLICY app_datastore ON projects.comments TO records_app
  USING (org_id = records.current_org() AND datastore_id = records.current_datastore())
  WITH CHECK (org_id = records.current_org() AND datastore_id = records.current_datastore());

GRANT SELECT, INSERT ON projects.workflow_states, projects.workflow_transitions, projects.custom_fields TO records_app;
GRANT SELECT, INSERT ON projects.projects TO records_app;
GRANT UPDATE (name, description, next_issue_number, revision, updated_by, updated_at) ON projects.projects TO records_app;
GRANT SELECT, INSERT ON projects.issues TO records_app;
GRANT UPDATE (title, description, state, priority, assignee_id, custom_fields, revision, updated_by, updated_at)
  ON projects.issues TO records_app;
-- Comments are append-only in v1.
GRANT SELECT, INSERT ON projects.comments TO records_app;
