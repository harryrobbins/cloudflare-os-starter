// Picks the API implementation. `__SEARCH_MOCK__` is a build-time constant, so a production bundle
// folds the mock branch away together with its dynamic import.
import { createHttpApi, type SearchApi } from "./client.js";

export async function createApi(): Promise<SearchApi> {
  if (__SEARCH_MOCK__) {
    const { createMockApi, mockOptionsFromLocation } = await import("../mock/api.js");
    return createMockApi(mockOptionsFromLocation(window.location.search));
  }
  return createHttpApi();
}
