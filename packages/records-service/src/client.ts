export interface ModuleDescription { id: string; api_majors: number[]; scopes: string[]; features?: string[]; entities?: unknown }
export interface DatastoreDescription { modules: ModuleDescription[]; granted_scopes: string[]; permission_epoch?: number }
export interface BlueprintRequirement { moduleId: string; apiMajor: number; scopes: string[]; features?: string[] }
export class RecordsError extends Error {
  readonly status: number; readonly detail: unknown;
  constructor(status: number, detail: unknown) { super(`Records request failed (${status})`); this.status = status; this.detail = detail; }
}
export class RecordsClient {
  private transport: typeof fetch;
  private options: { url: string; datastore: string; token: () => string | Promise<string>; fetch?: typeof fetch };
  constructor(options: { url: string; datastore: string; token: () => string | Promise<string>; fetch?: typeof fetch }) { this.options = options; this.transport = options.fetch ?? fetch; }
  private async request(path: string, init: RequestInit = {}, retry = false): Promise<any> {
    let response: Response | undefined;
    for (let attempt = 0; attempt < (retry ? 3 : 1); attempt++) {
      try {
        const headers = new Headers(init.headers); headers.set('authorization', `Bearer ${await this.options.token()}`);
        response = await this.transport(`${this.options.url.replace(/\/$/, '')}/v1/datastores/${encodeURIComponent(this.options.datastore)}/${path}`, { ...init, headers });
        if (response.ok) return await response.json();
        if (![429, 502, 503, 504].includes(response.status) || attempt === 2 || !retry) throw new RecordsError(response.status, await response.json());
        await response.body?.cancel();
      } catch (error) { if (error instanceof RecordsError || attempt === 2 || !retry || init.signal?.aborted) throw error; }
      await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
    }
    throw new Error('Records request exhausted retries');
  }
  describe(): Promise<DatastoreDescription> { return this.request('describe', {}, true); }
  async bind(requirement: BlueprintRequirement): Promise<BoundModule> {
    const description = await this.describe();
    const module = description.modules.find(candidate => candidate.id === requirement.moduleId && candidate.api_majors.includes(requirement.apiMajor));
    if (!module || requirement.scopes.some(scope => !module.scopes.includes(scope) || !description.granted_scopes?.includes(scope))) throw new Error('Datastore does not satisfy blueprint module, API major, and granted scopes');
    if (requirement.features?.some(feature => !module.features?.includes(feature))) throw new Error('Datastore does not satisfy required blueprint features');
    return new BoundModule(this, requirement);
  }
  records(module: string, major: number, query: { entity?: string; id?: string; after?: string; limit?: number } = {}): Promise<unknown> {
    const search = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
    return this.request(`modules/${encodeURIComponent(module)}/v${major}/records?${search}`, {}, true);
  }
  /** An atomic complete snapshot with a journal watermark; oversized datastores fail explicitly. */
  snapshot(module: string, major: number, limit = 1000): Promise<{ records: unknown[]; seq: number; permission_epoch: number; complete: true }> {
    return this.request(`modules/${encodeURIComponent(module)}/v${major}/snapshot?limit=${limit}`, {}, true);
  }
  command(module: string, major: number, command: string, input: unknown, options: { idempotencyKey?: string; revision?: number; signal?: AbortSignal } = {}): Promise<any> {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'idempotency-key': options.idempotencyKey ?? crypto.randomUUID() };
    if (options.revision !== undefined) headers['if-match'] = `"${options.revision}"`;
    // The body and key are constructed once, preserving the same operation across ambiguous failures.
    return this.request(`modules/${encodeURIComponent(module)}/v${major}/rpc/${encodeURIComponent(command)}`, { method: 'POST', headers, body: JSON.stringify(input), signal: options.signal }, true);
  }
  changes(after = 0, epoch?: number): Promise<{ changes: unknown[]; cursor: number; permission_epoch: number }> {
    return this.request(`changes?after=${after}${epoch === undefined ? '' : `&epoch=${epoch}`}`, {}, true);
  }
  /** Poll the durable journal even if an event transport is disconnected. Commit the cursor only after apply succeeds. */
  async sync(apply: (page: { changes: unknown[]; cursor: number; permission_epoch: number }) => Promise<void>, options: { signal: AbortSignal; after?: number; epoch?: number; intervalMs?: number }): Promise<void> {
    let cursor = options.after ?? 0; let epoch = options.epoch;
    while (!options.signal.aborted) {
      const page = await this.changes(cursor, epoch);
      await apply(page); cursor = page.cursor; epoch = page.permission_epoch;
      if (options.signal.aborted) return;
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); options.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, page.changes.length ? 0 : (options.intervalMs ?? 1000));
        options.signal.addEventListener('abort', done, { once: true });
      });
    }
  }
}
export class BoundModule {
  private client: RecordsClient; readonly requirement: BlueprintRequirement;
  constructor(client: RecordsClient, requirement: BlueprintRequirement) { this.client = client; this.requirement = requirement; }
  records(query?: { entity?: string; id?: string; after?: string; limit?: number }): Promise<unknown> { return this.client.records(this.requirement.moduleId, this.requirement.apiMajor, query); }
  snapshot(limit?: number): Promise<{ records: unknown[]; seq: number; permission_epoch: number; complete: true }> { return this.client.snapshot(this.requirement.moduleId, this.requirement.apiMajor, limit); }
  command(command: string, input: unknown, options?: { idempotencyKey?: string; revision?: number; signal?: AbortSignal }): Promise<unknown> { return this.client.command(this.requirement.moduleId, this.requirement.apiMajor, command, input, options); }
}
