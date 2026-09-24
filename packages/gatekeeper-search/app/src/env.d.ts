/// <reference types="vite/client" />

/** True only in a `VITE_SEARCH_MOCK=1` build. A constant, so the production bundle folds it away. */
declare const __SEARCH_MOCK__: boolean;
