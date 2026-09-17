export { GatekeeperVendor, ProcgenAccount, ProcgenVerifier, SyntheticDataGatekeeper, SyntheticDataSessionImpl } from "./procgen.js";
export default { fetch(): Response { return new Response("Not found", { status: 404 }); } };
