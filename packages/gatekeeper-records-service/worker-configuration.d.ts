declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./src/index");
    durableNamespaces: "RecordsServiceGatekeeper";
  }
  interface Env {
    /** Records service origin, e.g. https://records.surprisingly.ltd (a plain var). */
    RECORDS_SERVICE_URL: string;
    /** Secret: JSON array of { id, label, key } for each operator-approved datastore. */
    RECORDS_SERVICE_DATASTORES?: string;
  }
}
