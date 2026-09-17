declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./src/index");
    durableNamespaces: "SyntheticDataGatekeeper";
  }
  interface Env {}
}
