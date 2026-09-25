export { RecordsServiceGatekeeper } from "./gatekeeper.js";
export { GatekeeperVendor, RecordsServiceAccount, RecordsServiceVerifier } from "./vendor.js";
export default { fetch(): Response { return new Response("Not found", { status: 404 }); } };
