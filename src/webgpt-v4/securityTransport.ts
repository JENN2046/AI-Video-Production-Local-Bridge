import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { WebGptV4Scope } from "./types.js";

type ToolScopes = Readonly<Record<string, WebGptV4Scope | readonly WebGptV4Scope[]>>;

function decorateToolList(message: JSONRPCMessage, toolScopes: ToolScopes): JSONRPCMessage {
  if (!("result" in message) || !message.result || typeof message.result !== "object") return message;
  const result = message.result as Record<string, unknown>;
  if (!Array.isArray(result.tools)) return message;
  return {
    ...message,
    result: {
      ...result,
      tools: result.tools.map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return value;
        const tool = value as Record<string, unknown>;
        const scope = typeof tool.name === "string" ? toolScopes[tool.name] : undefined;
        return scope ? { ...tool, securitySchemes: [{ type: "oauth2", scopes: Array.isArray(scope) ? [...scope] : [scope] }] } : tool;
      })
    }
  } as JSONRPCMessage;
}

export function withToolSecuritySchemes(inner: Transport, toolScopes: ToolScopes): Transport {
  return {
    get sessionId() { return inner.sessionId; },
    setProtocolVersion: inner.setProtocolVersion ? (version) => inner.setProtocolVersion?.(version) : undefined,
    get onclose() { return inner.onclose; },
    set onclose(handler) { inner.onclose = handler; },
    get onerror() { return inner.onerror; },
    set onerror(handler) { inner.onerror = handler; },
    get onmessage() { return inner.onmessage; },
    set onmessage(handler: ((message: JSONRPCMessage, extra?: MessageExtraInfo) => void) | undefined) { inner.onmessage = handler; },
    start: () => inner.start(),
    send: (message: JSONRPCMessage, options?: TransportSendOptions) => inner.send(decorateToolList(message, toolScopes), options),
    close: () => inner.close()
  };
}
