// Pure state helpers for the dashboard Chat page (/dashboard/chat).
// Kept framework-free so they can be unit tested without React.
//
// Pattern credits: the workspace-grouped sidebar and SSE delta parsing follow the
// approach used by Open WebUI (BSD-3-Clause) and LibreChat (MIT). No code was copied.

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  model?: string;
}

export interface Conversation {
  id: string;
  workspaceId: string;
  title: string;
  model: string;
  messages: ChatMessage[];
  updatedAt: number;
}

export interface Workspace {
  id: string;
  name: string;
  /** Soft monthly token budget for this workspace; 0 means no cap. */
  tokenCap: number;
  tokensUsed: number;
}

export interface ChatState {
  workspaces: Workspace[];
  conversations: Conversation[];
  activeWorkspaceId: string;
  activeConversationId: string | null;
}

export const CHAT_STORAGE_KEY = "omniroute.chat.v1";

export const DEFAULT_WORKSPACES: Workspace[] = [
  { id: "general", name: "General", tokenCap: 0, tokensUsed: 0 },
];

export function createInitialState(): ChatState {
  return {
    workspaces: DEFAULT_WORKSPACES.map((w) => ({ ...w })),
    conversations: [],
    activeWorkspaceId: DEFAULT_WORKSPACES[0].id,
    activeConversationId: null,
  };
}

export function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Derive a short sidebar title from the first user message. */
export function deriveTitle(text: string, max = 48): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "New chat";
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

export function addWorkspace(state: ChatState, name: string): ChatState {
  const trimmed = name.trim();
  if (!trimmed) return state;
  const ws: Workspace = { id: makeId("ws"), name: trimmed, tokenCap: 0, tokensUsed: 0 };
  return { ...state, workspaces: [...state.workspaces, ws], activeWorkspaceId: ws.id };
}

export function updateWorkspace(
  state: ChatState,
  id: string,
  patch: Partial<Omit<Workspace, "id">>
): ChatState {
  return {
    ...state,
    workspaces: state.workspaces.map((w) => (w.id === id ? { ...w, ...patch } : w)),
  };
}

/** Removes a workspace and its conversations. The last workspace cannot be removed. */
export function removeWorkspace(state: ChatState, id: string): ChatState {
  if (state.workspaces.length <= 1) return state;
  const workspaces = state.workspaces.filter((w) => w.id !== id);
  const conversations = state.conversations.filter((c) => c.workspaceId !== id);
  const activeWorkspaceId =
    state.activeWorkspaceId === id ? workspaces[0].id : state.activeWorkspaceId;
  const activeConversationId = conversations.some((c) => c.id === state.activeConversationId)
    ? state.activeConversationId
    : null;
  return { workspaces, conversations, activeWorkspaceId, activeConversationId };
}

export function upsertConversation(state: ChatState, conv: Conversation): ChatState {
  const exists = state.conversations.some((c) => c.id === conv.id);
  const conversations = exists
    ? state.conversations.map((c) => (c.id === conv.id ? conv : c))
    : [conv, ...state.conversations];
  return { ...state, conversations };
}

export function removeConversation(state: ChatState, id: string): ChatState {
  return {
    ...state,
    conversations: state.conversations.filter((c) => c.id !== id),
    activeConversationId: state.activeConversationId === id ? null : state.activeConversationId,
  };
}

export function conversationsFor(
  state: ChatState,
  workspaceId: string,
  query = ""
): Conversation[] {
  const q = query.trim().toLowerCase();
  return state.conversations
    .filter((c) => c.workspaceId === workspaceId)
    .filter((c) => !q || c.title.toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function addTokens(state: ChatState, workspaceId: string, tokens: number): ChatState {
  if (!Number.isFinite(tokens) || tokens <= 0) return state;
  return {
    ...state,
    workspaces: state.workspaces.map((w) =>
      w.id === workspaceId ? { ...w, tokensUsed: w.tokensUsed + Math.round(tokens) } : w
    ),
  };
}

export function isOverCap(ws: Workspace | undefined): boolean {
  return !!ws && ws.tokenCap > 0 && ws.tokensUsed >= ws.tokenCap;
}

/** Parse stored JSON defensively; any malformed payload falls back to a fresh state. */
export function parseStoredState(raw: string | null): ChatState {
  if (!raw) return createInitialState();
  try {
    const data = JSON.parse(raw) as Partial<ChatState>;
    if (!Array.isArray(data.workspaces) || data.workspaces.length === 0) {
      return createInitialState();
    }
    const workspaces = data.workspaces.filter(
      (w): w is Workspace => !!w && typeof w.id === "string" && typeof w.name === "string"
    );
    if (workspaces.length === 0) return createInitialState();
    const conversations = Array.isArray(data.conversations)
      ? data.conversations.filter(
          (c): c is Conversation =>
            !!c &&
            typeof c.id === "string" &&
            Array.isArray(c.messages) &&
            workspaces.some((w) => w.id === c.workspaceId)
        )
      : [];
    const activeWorkspaceId = workspaces.some((w) => w.id === data.activeWorkspaceId)
      ? (data.activeWorkspaceId as string)
      : workspaces[0].id;
    const activeConversationId = conversations.some((c) => c.id === data.activeConversationId)
      ? (data.activeConversationId as string)
      : null;
    return { workspaces, conversations, activeWorkspaceId, activeConversationId };
  } catch {
    return createInitialState();
  }
}

export interface SseDelta {
  text: string;
  totalTokens?: number;
}

/**
 * Parse complete `data:` lines of an OpenAI-compatible chat stream.
 * Returns the parsed deltas plus any trailing partial line to carry into the next chunk.
 */
export function parseSseChunk(buffer: string): { deltas: SseDelta[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const deltas: SseDelta[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const json = JSON.parse(payload) as {
        choices?: { delta?: { content?: string | null } }[];
        usage?: { total_tokens?: number };
      };
      const text = json.choices?.[0]?.delta?.content ?? "";
      const totalTokens = json.usage?.total_tokens;
      if (text || typeof totalTokens === "number") deltas.push({ text, totalTokens });
    } catch {
      // ignore keep-alive or non-JSON lines
    }
  }
  return { deltas, rest };
}
