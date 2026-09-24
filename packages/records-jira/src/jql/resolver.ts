// Lookups the JQL parser needs. The parser is synchronous; the router loads projects, the
// workflow and members from the port once per request and builds a resolver from them.

export interface JqlResolver {
  /** The caller's principal ID, for currentUser(); null when anonymous (matches nothing). */
  currentUser(): string | null;
  /** A project key (case-insensitive), numeric Jira id or exact name → project ID. */
  project(ref: string): string | null;
  /** A workflow state name (case-insensitive), key or numeric Jira id → state key. */
  status(ref: string): string | null;
  /** An accountId (a principal ID) → the principal ID, if that principal is a member. */
  user(ref: string): string | null;
}

export type ResolverLookups = {
  me: string | null;
  projects: { id: string; key: string; name: string; jiraId: number }[];
  states: { key: string; name: string; jiraId: number }[];
  members: { id: string; displayName?: string }[];
};

export function resolverFromLookups(l: ResolverLookups): JqlResolver {
  return {
    currentUser: () => l.me,
    project(ref) {
      const s = ref.trim();
      const up = s.toUpperCase();
      const p =
        l.projects.find((x) => x.key === up) ??
        l.projects.find((x) => /^\d+$/.test(s) && String(x.jiraId) === s) ??
        l.projects.find((x) => x.id === s) ??
        l.projects.find((x) => x.name.toLowerCase() === s.toLowerCase());
      return p?.id ?? null;
    },
    status(ref) {
      const s = ref.trim().toLowerCase();
      const st =
        l.states.find((x) => x.name.toLowerCase() === s) ??
        l.states.find((x) => /^\d+$/.test(s) && String(x.jiraId) === s) ??
        l.states.find((x) => x.key === s);
      return st?.key ?? null;
    },
    user(ref) {
      const s = ref.trim();
      return l.members.find((m) => m.id === s)?.id ?? null;
    },
  };
}
