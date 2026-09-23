export * from "./jev.js";

export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
};
