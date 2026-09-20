/// <reference types="vite/client" />

/** True only in a `VITE_CHAT_MOCK=1` build. A constant, so the production bundle folds it away. */
declare const __CHAT_MOCK__: boolean;
/** True in a dev or mock build; gates the dev-identity switcher, which production never shows. */
declare const __DEV_BUILD__: boolean;
