// Browsers and the published server both provide a standards-based WebSocket.
// Avoid loading Node-only ws and its stream inheritance tree during imports.
export const WebSocket = globalThis.WebSocket;