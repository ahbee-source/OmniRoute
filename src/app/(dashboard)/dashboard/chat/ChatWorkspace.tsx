"use client";

// src/app/(dashboard)/dashboard/chat/ChatWorkspace.tsx
// Conversational chat UI: workspaces sidebar, model picker, streaming replies,
// per-workspace soft token caps. Conversations are stored in this browser only.

import {
  ArrowUp,
  Ban,
  Folder,
  PanelLeft,
  Plus,
  SlidersHorizontal,
  Square,
  SquarePen,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import MarkdownMessage from "../playground/components/MarkdownMessage";
import {
  CHAT_STORAGE_KEY,
  addTokens,
  addWorkspace,
  conversationsFor,
  createInitialState,
  deriveTitle,
  isOverCap,
  makeId,
  parseSseChunk,
  parseStoredState,
  removeConversation,
  removeWorkspace,
  updateWorkspace,
  upsertConversation,
  type ChatMessage,
  type ChatState,
  type Conversation,
} from "@/shared/utils/chatWorkspaceStore";

const MODEL_KEY = "omniroute.chat.model";

const ICONS = {
  edit_square: SquarePen,
  add: Plus,
  folder: Folder,
  block: Ban,
  delete: Trash2,
  tune: SlidersHorizontal,
  menu: PanelLeft,
  stop: Square,
  arrow_upward: ArrowUp,
} as const;

function Icon({ name, className = "" }: { name: keyof typeof ICONS; className?: string }) {
  const Cmp = ICONS[name];
  return <Cmp aria-hidden className={`size-4 shrink-0 ${className}`} />;
}

interface TurnArgs {
  text: string;
  model: string;
  conversation: Conversation | undefined;
  workspaceId: string;
  signal: AbortSignal;
  setState: React.Dispatch<React.SetStateAction<ChatState>>;
  onError: (message: string) => void;
}

/** Sends one user turn and streams the assistant reply into state. */
async function runChatTurn({
  text,
  model,
  conversation,
  workspaceId,
  signal,
  setState,
  onError,
}: TurnArgs): Promise<void> {
  const base: Conversation = conversation ?? {
    id: makeId("c"),
    workspaceId,
    title: deriveTitle(text),
    model,
    messages: [],
    updatedAt: Date.now(),
  };
  const history: ChatMessage[] = [...base.messages, { role: "user", content: text }];
  const write = (content: string | null) => {
    const conv: Conversation = {
      ...base,
      model,
      messages: content === null ? history : [...history, { role: "assistant", content, model }],
      updatedAt: Date.now(),
    };
    setState((s) => ({ ...upsertConversation(s, conv), activeConversationId: conv.id }));
  };
  write("");

  let reply = "";
  let tokens = 0;
  try {
    const res = await fetch("/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: true,
        stream_options: { include_usage: true },
        messages: history.map(({ role, content }) => ({ role, content })),
      }),
      signal,
    });
    if (!res.ok || !res.body) {
      const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(err.error?.message || `Request failed (HTTP ${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { deltas, rest } = parseSseChunk(buffer);
      buffer = rest;
      for (const d of deltas) {
        reply += d.text;
        if (typeof d.totalTokens === "number") tokens = d.totalTokens;
      }
      write(reply);
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") onError((e as Error).message);
    if (!reply) write(null);
  } finally {
    // Rough fallback when the provider sends no usage block: ~4 chars per token.
    if (!tokens) tokens = Math.ceil((text.length + reply.length) / 4);
    setState((s) => addTokens(s, base.workspaceId, tokens));
  }
}

export function ChatWorkspace() {
  const [state, setState] = useState<ChatState>(createInitialState);
  const [loaded, setLoaded] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  // Load persisted state + model list once.
  useEffect(() => {
    try {
      // Hydrate from browser storage after mount (SSR has no localStorage).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState(parseStoredState(localStorage.getItem(CHAT_STORAGE_KEY)));
      const savedModel = localStorage.getItem(MODEL_KEY);
      if (savedModel) setModel(savedModel);
    } catch {
      // storage unavailable (private mode) — keep in-memory state
    }
    if (window.matchMedia("(max-width: 767px)").matches) setSidebarOpen(false);
    setLoaded(true);
    fetch("/v1/models")
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((d: { data?: { id: string }[] }) => {
        const ids = (d.data ?? []).map((m) => m.id).filter(Boolean);
        setModels(ids);
        setModel((cur) => cur || ids[0] || "");
      })
      .catch(() => setModels([]));
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore quota / private mode
    }
  }, [state, loaded]);

  useEffect(() => {
    if (!model) return;
    try {
      localStorage.setItem(MODEL_KEY, model);
    } catch {
      // ignore
    }
  }, [model]);

  const workspace = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  const conversation = state.conversations.find((c) => c.id === state.activeConversationId);
  const list = useMemo(
    () => conversationsFor(state, state.activeWorkspaceId, search),
    [state, search]
  );
  const overCap = isOverCap(workspace);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [conversation?.messages]);

  const newChat = () => {
    abortRef.current?.abort();
    setState((s) => ({ ...s, activeConversationId: null }));
    setError(null);
  };

  const send = () => {
    const text = input.trim();
    if (!text || streaming || !model || overCap) return;
    setError(null);
    setInput("");
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    void runChatTurn({
      text,
      model,
      conversation,
      workspaceId: state.activeWorkspaceId,
      signal: controller.signal,
      setState,
      onError: setError,
    }).finally(() => {
      setStreaming(false);
      abortRef.current = null;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const promptNewWorkspace = () => {
    const name = window.prompt("Workspace name");
    if (name) setState((s) => ({ ...addWorkspace(s, name), activeConversationId: null }));
  };

  return (
    <div className="relative flex h-[calc(100dvh-11rem)] min-h-[480px] overflow-hidden rounded-xl border border-border bg-bg">
      {/* Sidebar */}
      {sidebarOpen && (
        <aside className="absolute inset-y-0 left-0 z-20 flex w-64 shrink-0 flex-col border-r border-border bg-bg-alt shadow-lg md:static md:shadow-none">
          <div className="flex items-center gap-2 p-3">
            <button
              type="button"
              onClick={newChat}
              className="flex flex-1 items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-bg"
            >
              <Icon name="edit_square" /> New chat
            </button>
          </div>

          <div className="px-3 pb-2">
            <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              Workspaces
              <button
                type="button"
                onClick={promptNewWorkspace}
                title="Add workspace"
                aria-label="Add workspace"
              >
                <Icon name="add" />
              </button>
            </div>
            <ul className="space-y-0.5">
              {state.workspaces.map((w) => (
                <li key={w.id}>
                  <button
                    type="button"
                    onClick={() =>
                      setState((s) => ({
                        ...s,
                        activeWorkspaceId: w.id,
                        activeConversationId: null,
                      }))
                    }
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                      w.id === state.activeWorkspaceId
                        ? "bg-primary/10 text-primary"
                        : "hover:bg-bg"
                    }`}
                  >
                    <Icon name="folder" />
                    <span className="flex-1 truncate">{w.name}</span>
                    {isOverCap(w) && <Icon name="block" className="text-red-500" />}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="px-3 pb-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search chats"
              className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm"
            />
          </div>

          <ul className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-3">
            {list.length === 0 && (
              <li className="px-2 py-4 text-xs text-text-muted">No chats in this workspace yet.</li>
            )}
            {list.map((c) => (
              <li key={c.id} className="group flex items-center">
                <button
                  type="button"
                  onClick={() => setState((s) => ({ ...s, activeConversationId: c.id }))}
                  className={`flex-1 truncate rounded-md px-2 py-1.5 text-left text-sm ${
                    c.id === state.activeConversationId ? "bg-bg font-medium" : "hover:bg-bg"
                  }`}
                >
                  {c.title}
                </button>
                <button
                  type="button"
                  aria-label="Delete chat"
                  onClick={() => setState((s) => removeConversation(s, c.id))}
                  className="invisible px-1 text-text-muted hover:text-red-500 group-hover:visible"
                >
                  <Icon name="delete" />
                </button>
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={() => setShowSettings((v) => !v)}
            className="flex items-center gap-2 border-t border-border px-4 py-3 text-sm hover:bg-bg"
          >
            <Icon name="tune" /> Workspace settings
          </button>
        </aside>
      )}

      {/* Main column */}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2">
          <button
            type="button"
            aria-label="Toggle sidebar"
            onClick={() => setSidebarOpen((v) => !v)}
            className="rounded-md p-1 hover:bg-bg-alt"
          >
            <Icon name="menu" />
          </button>
          <select
            aria-label="Model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="max-w-[18rem] truncate rounded-md border border-border bg-bg px-2 py-1 text-sm"
          >
            {models.length === 0 && <option value="">No models — add a provider first</option>}
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <span className="ml-auto truncate text-xs text-text-muted">
            {workspace?.name}
            {workspace &&
              workspace.tokenCap > 0 &&
              ` · ${workspace.tokensUsed.toLocaleString()} / ${workspace.tokenCap.toLocaleString()} tokens`}
          </span>
        </header>

        {showSettings && workspace && (
          <div className="space-y-3 border-b border-border bg-bg-alt px-6 py-4 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2">
                Name
                <input
                  value={workspace.name}
                  onChange={(e) =>
                    setState((s) => updateWorkspace(s, workspace.id, { name: e.target.value }))
                  }
                  className="rounded-md border border-border bg-bg px-2 py-1"
                />
              </label>
              <label className="flex items-center gap-2">
                Token cap (0 = none)
                <input
                  type="number"
                  min={0}
                  step={1000}
                  value={workspace.tokenCap}
                  onChange={(e) =>
                    setState((s) =>
                      updateWorkspace(s, workspace.id, {
                        tokenCap: Math.max(0, Number(e.target.value) || 0),
                      })
                    )
                  }
                  className="w-32 rounded-md border border-border bg-bg px-2 py-1"
                />
              </label>
              <button
                type="button"
                onClick={() => setState((s) => updateWorkspace(s, workspace.id, { tokensUsed: 0 }))}
                className="rounded-md border border-border px-2 py-1 hover:bg-bg"
              >
                Reset usage
              </button>
              <button
                type="button"
                disabled={state.workspaces.length <= 1}
                onClick={() => {
                  if (window.confirm(`Delete "${workspace.name}" and its chats?`)) {
                    setState((s) => removeWorkspace(s, workspace.id));
                  }
                }}
                className="rounded-md border border-red-500/40 px-2 py-1 text-red-500 disabled:opacity-40"
              >
                Delete workspace
              </button>
            </div>
            <p className="text-xs text-text-muted">
              This cap is a soft limit kept in this browser. For hard spending limits and cheaper
              routing that apply to every client, use{" "}
              <Link href="/dashboard/limits" className="underline">
                Limits
              </Link>
              ,{" "}
              <Link href="/dashboard/costs" className="underline">
                Costs
              </Link>{" "}
              and{" "}
              <Link href="/dashboard/combos" className="underline">
                Combos
              </Link>
              .
            </p>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {!conversation || conversation.messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <h1 className="text-2xl font-semibold">What can I help with?</h1>
              <p className="max-w-md text-sm text-text-muted">
                Chats go through your OmniRoute providers and combos. Pick a model above, or a combo
                to let OmniRoute choose the cheapest one that works.
              </p>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
              {conversation.messages.map((m, i) => (
                <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
                  {m.role === "user" ? (
                    <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-bg-alt px-4 py-2 text-sm">
                      {m.content}
                    </div>
                  ) : (
                    <div className="text-sm leading-relaxed">
                      {m.content ? (
                        <MarkdownMessage content={m.content} />
                      ) : (
                        <span className="animate-pulse text-text-muted">Thinking…</span>
                      )}
                      {m.model && m.content && (
                        <div className="mt-1 text-[11px] text-text-muted">{m.model}</div>
                      )}
                    </div>
                  )}
                </div>
              ))}
              <div ref={endRef} />
            </div>
          )}
        </div>

        <footer className="px-4 pb-4">
          {error && (
            <div
              role="alert"
              className="mx-auto mb-2 max-w-3xl rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-500"
            >
              {error}
            </div>
          )}
          {overCap && (
            <div className="mx-auto mb-2 max-w-3xl rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-600">
              This workspace reached its token cap. Raise or reset it in Workspace settings.
            </div>
          )}
          <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-border bg-bg-alt p-2 focus-within:border-primary">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={`Message ${workspace?.name ?? ""}…`}
              aria-label="Message"
              className="max-h-48 min-h-[2.5rem] flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none [field-sizing:content]"
            />
            {streaming ? (
              <button
                type="button"
                aria-label="Stop"
                onClick={() => abortRef.current?.abort()}
                className="rounded-full bg-text-main p-2 text-bg"
              >
                <Icon name="stop" />
              </button>
            ) : (
              <button
                type="button"
                aria-label="Send"
                onClick={() => void send()}
                disabled={!input.trim() || !model || overCap}
                className="rounded-full bg-primary p-2 text-black disabled:opacity-40"
              >
                <Icon name="arrow_upward" />
              </button>
            )}
          </div>
          <p className="mt-1 text-center text-[11px] text-text-muted">
            Enter to send, Shift+Enter for a new line. Chats are saved in this browser only.
          </p>
        </footer>
      </section>
    </div>
  );
}
