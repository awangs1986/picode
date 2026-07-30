import { createTransport } from "./app/transport.js";
import { resolveWebSocketUrl, WebSocketClient } from "./app/websocket-client.js";
import { setupChatContextViewer } from "./chat-context-viewer.js";
import { initLocalization } from "./i18n/index.js";

await initLocalization();

const wsClient = new WebSocketClient(resolveWebSocketUrl(window));
const transport = createTransport({ wsClient, env: window });
wsClient.connect();
setupChatContextViewer({ transport, env: window });

window.addEventListener("beforeunload", () => wsClient.disconnect(), { once: true });
