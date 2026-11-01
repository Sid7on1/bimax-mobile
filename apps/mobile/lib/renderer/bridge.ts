import artifact from "../../generated/chat-renderer.json";
export { artifact };
export function scriptValue(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
export function transcriptScript(value: unknown): string {
  return `window.BimaxTranscript?.update(${scriptValue(value)});true;`;
}
export function pluginScript(name: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(artifact.plugins, name)) return null;
  const plugin = artifact.plugins[name as keyof typeof artifact.plugins];
  return `(function(){var style=document.createElement('style');style.textContent=${scriptValue(plugin.css)};document.head.appendChild(style);var script=document.createElement('script');script.setAttribute('nonce',${scriptValue(artifact.nonce)});script.textContent=${scriptValue(plugin.js)};document.body.appendChild(script)})();true;`;
}
export function externalUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const u = new URL(value);
    return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}
export function parseBridge(raw: string): { type: string; [key: string]: unknown } | null {
  if (raw.length > 200 * 1024) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && typeof v.type === "string" ? v : null;
  } catch {
    return null;
  }
}

export interface WireMessage {
  id: string;
  role: string;
  content: string;
  reasoning?: string | null;
  streaming?: boolean;
  status?: string;
}
export interface RenderPreferences {
  textSize?: "comfortable" | "large";
  reduceMotion: boolean;
  followReplies: boolean;
  showThinking: boolean;
}
export interface WireState {
  key: string;
  messages: WireMessage[];
  empty?: string;
  failedId?: string;
  preferences?: RenderPreferences;
}
export function wireState(props: {
  conversationKey: string;
  messages: WireMessage[];
  empty?: string;
  failedId?: string;
  preferences?: RenderPreferences;
}): WireState {
  return {
    key: props.conversationKey,
    messages: props.messages,
    empty: props.empty,
    failedId: props.failedId,
    preferences: props.preferences,
  };
}
const sameMessage = (a: WireMessage, b: WireMessage) =>
  a.id === b.id &&
  a.role === b.role &&
  a.content === b.content &&
  a.reasoning === b.reasoning &&
  a.streaming === b.streaming &&
  a.status === b.status;
const textChange = (before: string, after: string) =>
  before === after
    ? undefined
    : after.startsWith(before)
      ? { append: after.slice(before.length) }
      : { set: after };
/** Serialize only the changed transcript tail, never all saved history for each live token. */
export function transcriptOperation(
  previous: WireState | undefined,
  next: WireState,
): { type: "update" | "patch"; state?: WireState; patch?: unknown } | null {
  if (!previous || previous.key !== next.key) return { type: "update", state: next };
  let from = 0;
  while (
    from < previous.messages.length &&
    from < next.messages.length &&
    sameMessage(previous.messages[from], next.messages[from])
  )
    from++;
  if (
    from === previous.messages.length &&
    from === next.messages.length &&
    previous.empty === next.empty &&
    previous.failedId === next.failedId &&
    JSON.stringify(previous.preferences) === JSON.stringify(next.preferences)
  )
    return null;
  const index = next.messages.length - 1,
    a = previous.messages[index],
    b = next.messages[index];
  if (
    previous.messages.length === next.messages.length &&
    from === index &&
    a.id === b.id &&
    a.role === b.role
  ) {
    return {
      type: "patch",
      patch: {
        key: next.key,
        empty: next.empty,
        failedId: next.failedId,
        preferences: next.preferences,
        index,
        id: b.id,
        content: textChange(a.content, b.content),
        reasoning: textChange(a.reasoning ?? "", b.reasoning ?? ""),
        streaming: b.streaming,
        status: b.status,
      },
    };
  }
  return {
    type: "patch",
    patch: {
      key: next.key,
      empty: next.empty,
      failedId: next.failedId,
      preferences: next.preferences,
      from,
      tail: next.messages.slice(from),
    },
  };
}
export function operationScript(
  operation: NonNullable<ReturnType<typeof transcriptOperation>>,
): string {
  return operation.type === "update"
    ? transcriptScript(operation.state)
    : `window.BimaxTranscript?.patch(${scriptValue(operation.patch)});true;`;
}
