import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { boundAgentCatalog } from "@gadgets/workshop-shared/gatekeeper";
import type { AccountDescription, AgentCatalog, ApprovalQueue, Gatekeeper, GatekeeperConnectCallback, GatekeeperConnectOptions, GatekeeperUser, GatekeeperUserVerifier, ObservationAuthorizer, ResourceConfiguratorFrame, ResourceDescription, SupportedResource, VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import { renderInBrowser } from "./browser.js";
import { CAPABILITIES, normalizeRequest } from "./validation.js";
import { CONFIGURATOR_HTML } from "./generated/configurator.js";
import { SKILLS, TYPES_CODE } from "./generated/metadata.js";
import type { DiagramCapabilities, DiagramRequest, DiagramResult, DiagramSession } from "./types.js";

/** Resource authority covers ephemeral rendering, with no stored documents or external reads. */
export const DIAGRAM_RESOURCE: SupportedResource = { urlPattern: "mermaid2://renderer", title: "MermaiD2 renderer", description: "Render supplied Mermaid or D2 using TALA, Dagre or ELK and export diagrams." };
const ICON = { url: "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='#465838'/><path d='M8 8h7v7H8zM19 19h7v7h-7zM15 11h7v8M11 15v7h8' fill='none' stroke='#e4edce' stroke-width='2'/></svg>") };
const SKILL_TITLES = { "mermaid2-connector": "Render diagram files with the MermaiD2 connector", "mermaid2-blueprint": "Create and edit MermaiD2 diagram gadgets", "d2-authoring": "Author D2 architectures, flows and data models" };
class ConfiguratorCapability extends RpcTarget {}

@validateRpc()
export class DiagramGatekeeper extends DurableObject<Cloudflare.Env> implements Gatekeeper<DiagramSession> {
  async describe(): Promise<ResourceDescription> { return { url: DIAGRAM_RESOURCE.urlPattern, title: "MermaiD2", snippet: "Ephemeral Mermaid/D2 rendering and bundled diagram skills. No external images or file imports.", workspaceReadable: true, suggestedBindingName: "MERMAID2", tsType: "DiagramSession" }; }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
  async getAutoApprovableActions(): Promise<[]> { return []; }
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<DiagramSession> { return new DiagramSessionImpl(this.env, queue.dup()); }
  async getAgentCatalog(authorizer: RpcStub<ObservationAuthorizer>): Promise<AgentCatalog> {
    await authorizer.authorizeObservation({ title: "Discover MermaiD2 skills", description: "Three bundled skills for diagram rendering, the playground blueprint and D2 authoring." });
    return boundAgentCatalog(Object.entries(SKILL_TITLES).map(([id, title]) => ({ id, title, description: `Read with MERMAID2.readSkill(${JSON.stringify(id)}).` })));
  }
  async addObserver(_id: string, verifier: Fetcher<GatekeeperUserVerifier>): Promise<void> { await (verifier as Fetcher<DiagramVerifier>).verifyRendererAccess(); }
  async removeObserver(_id: string): Promise<void> {}
  async applyAction(_sequence: number): Promise<void> { throw new Error("MermaiD2 has no external write actions."); }
  async rejectAction(_sequence: number): Promise<void> {}
  async revertAction(_sequence: number): Promise<void> { throw new Error("MermaiD2 has no external write actions."); }
}

/** Verifies access to the supplied-input renderer; it has no historical third-party data. */
interface DiagramVerifier extends GatekeeperUserVerifier { verifyRendererAccess(): Promise<void> }
@validateRpc()
export class MermaiD2Verifier extends WorkerEntrypoint<Cloudflare.Env> implements DiagramVerifier {
  async verifyRendererAccess(): Promise<void> {}
}

@validateRpc()
export class DiagramSessionImpl extends RpcTarget implements DiagramSession {
  constructor(private env: Cloudflare.Env, private queue: RpcStub<ApprovalQueue>) { super(); }
  async describeCapabilities(): Promise<DiagramCapabilities> {
    await this.queue.authorizeObservation({ title: "Read MermaiD2 capabilities", description: "Supported languages, layout engines, export formats and limits." });
    return structuredClone(CAPABILITIES);
  }
  async readSkill(id: string): Promise<string> {
    if (!Object.hasOwn(SKILLS, id)) throw new Error("not_found: unknown MermaiD2 skill.");
    await this.queue.authorizeObservation({ title: "Read diagram skill", description: `Bundled MermaiD2 skill: ${id}.` });
    return SKILLS[id as keyof typeof SKILLS];
  }
  async render(input: DiagramRequest): Promise<DiagramResult> {
    const request = normalizeRequest(input);
    // The document itself is omitted from the observation description and logs.
    await this.queue.authorizeObservation({ title: "Render a diagram", description: `${request.language} → ${request.layout} → ${request.format}; ephemeral processing on Cloudflare.` });
    return executeRender(this.env, request);
  }
  [Symbol.dispose](): void { this.queue[Symbol.dispose](); }
}

@validateRpc()
export class MermaiD2Account extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> { return { displayName: "MermaiD2", avatar: ICON }; }
  async getSupportedResources(): Promise<SupportedResource[]> { return [DIAGRAM_RESOURCE]; }
  async startResourceConfigurator(pattern: string): Promise<ResourceConfiguratorFrame> {
    if (pattern !== DIAGRAM_RESOURCE.urlPattern) throw new Error("Unsupported MermaiD2 resource.");
    return { iframeHtml: CONFIGURATOR_HTML, ui: new RpcStub(new ConfiguratorCapability()) };
  }
  async getGatekeeperClassFor(url: string): Promise<{ class: DurableObjectClass<Gatekeeper<DiagramSession>>; resource: SupportedResource }> {
    if (url !== DIAGRAM_RESOURCE.urlPattern) throw new Error("Expected mermaid2://renderer.");
    return { class: this.ctx.exports.DiagramGatekeeper({}), resource: DIAGRAM_RESOURCE };
  }
  async ensureResources(patterns: string[]): Promise<{ url?: string }> { if (patterns.some(pattern => pattern !== DIAGRAM_RESOURCE.urlPattern)) throw new Error("Unsupported MermaiD2 resource."); return {}; }
  async revoke(): Promise<void> {}
  async reconnect(): Promise<{ url: string }> { throw new Error("MermaiD2 has no authentication flow."); }
  async getAuthenticatedEmail(): Promise<null> { return null; }
  @skipRpcValidation() async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> { return this.ctx.exports.MermaiD2Verifier({}); }
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> { return { displayName: "MermaiD2", url: "https://d2lang.com", logo: ICON, tagline: "Mermaid and D2, rendered your way", description: "Render supplied diagrams using TALA, Dagre and ELK; export images, PDF, ASCII and source. Connect the renderer to apps or workspaces explicitly.", autoProvisionsAccount: true, providesAuth: false }; }
  @skipRpcValidation() async createAccount(): Promise<Fetcher<GatekeeperUser>> { return this.ctx.exports.MermaiD2Account({}); }
  async connectAccount(_callback: Fetcher<GatekeeperConnectCallback>, _options?: GatekeeperConnectOptions): Promise<{ url: string }> { throw new Error("MermaiD2 is credential-free; use the connection picker."); }
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> { return [DIAGRAM_RESOURCE]; }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
}

async function executeRender(env: Cloudflare.Env, request: Required<DiagramRequest>): Promise<DiagramResult> {
    if (request.format === "source") return { data: new TextEncoder().encode(request.source), contentType: "text/plain;charset=utf-8", filename: `mermaid2-diagram.${request.language === "mermaid" ? "mmd" : "d2"}`, language: request.language, layout: request.layout, format: request.format, nodes: 0, edges: 0 };
    return renderInBrowser(env, request);
}

/** Capability for other Workers; Workshop gadgets use DiagramSession for observation auditing. */
@validateRpc()
export class DiagramRenderer extends WorkerEntrypoint<Cloudflare.Env> implements DiagramSession {
  async render(request: DiagramRequest): Promise<DiagramResult> { return executeRender(this.env, normalizeRequest(request)); }
  async describeCapabilities(): Promise<DiagramCapabilities> { return structuredClone(CAPABILITIES); }
  async readSkill(id: string): Promise<string> {
    if (!Object.hasOwn(SKILLS, id)) throw new Error("not_found: unknown MermaiD2 skill.");
    return SKILLS[id as keyof typeof SKILLS];
  }
}

// Assets are a private implementation detail. They can only be fetched using the internal binding.
export default { fetch(): Response { return new Response("Not found", { status: 404 }); } };
