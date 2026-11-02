import test from "node:test";
import assert from "node:assert/strict";
import {
  addTokens,
  addWorkspace,
  conversationsFor,
  createInitialState,
  deriveTitle,
  isOverCap,
  parseSseChunk,
  parseStoredState,
  removeWorkspace,
  updateWorkspace,
  upsertConversation,
} from "../../src/shared/utils/chatWorkspaceStore.ts";

test("deriveTitle trims, collapses whitespace and truncates", () => {
  assert.equal(deriveTitle("  hello \n world "), "hello world");
  assert.equal(deriveTitle(""), "New chat");
  const t = deriveTitle("a".repeat(100), 10);
  assert.equal(t.length, 10);
  assert.ok(t.endsWith("…"));
});

test("workspaces: add, cap, remove keeps at least one", () => {
  let s = addWorkspace(createInitialState(), "Job search");
  const ws = s.workspaces[1];
  assert.equal(s.activeWorkspaceId, ws.id);
  s = updateWorkspace(s, ws.id, { tokenCap: 100 });
  s = addTokens(s, ws.id, 60);
  assert.equal(isOverCap(s.workspaces[1]), false);
  s = addTokens(s, ws.id, 40);
  assert.equal(isOverCap(s.workspaces[1]), true);
  s = upsertConversation(s, {
    id: "c1",
    workspaceId: ws.id,
    title: "x",
    model: "m",
    messages: [],
    updatedAt: 1,
  });
  s = removeWorkspace(s, ws.id);
  assert.equal(s.workspaces.length, 1);
  assert.equal(s.conversations.length, 0);
  assert.equal(removeWorkspace(s, s.workspaces[0].id).workspaces.length, 1);
});

test("conversationsFor filters by workspace and query, newest first", () => {
  let s = createInitialState();
  const base = { workspaceId: "general", model: "m", messages: [] };
  s = upsertConversation(s, { ...base, id: "a", title: "Budget plan", updatedAt: 1 });
  s = upsertConversation(s, { ...base, id: "b", title: "CV review", updatedAt: 2 });
  assert.deepEqual(
    conversationsFor(s, "general").map((c) => c.id),
    ["b", "a"]
  );
  assert.deepEqual(
    conversationsFor(s, "general", "budget").map((c) => c.id),
    ["a"]
  );
});

test("parseStoredState falls back on bad input and drops orphans", () => {
  assert.equal(parseStoredState("{not json").workspaces[0].id, "general");
  const s = parseStoredState(
    JSON.stringify({
      workspaces: [{ id: "w", name: "W", tokenCap: 0, tokensUsed: 0 }],
      conversations: [
        { id: "ok", workspaceId: "w", messages: [] },
        { id: "orphan", workspaceId: "gone", messages: [] },
      ],
      activeWorkspaceId: "missing",
      activeConversationId: "orphan",
    })
  );
  assert.equal(s.activeWorkspaceId, "w");
  assert.deepEqual(
    s.conversations.map((c) => c.id),
    ["ok"]
  );
  assert.equal(s.activeConversationId, null);
});

test("parseSseChunk handles split lines, DONE and usage", () => {
  const first = parseSseChunk('data: {"choices":[{"delta":{"content":"Hel"}}]}\ndata: {"choi');
  assert.deepEqual(first.deltas, [{ text: "Hel", totalTokens: undefined }]);
  const second = parseSseChunk(
    first.rest +
      'ces":[{"delta":{"content":"lo"}}]}\ndata: {"choices":[],"usage":{"total_tokens":12}}\ndata: [DONE]\n'
  );
  assert.equal(second.deltas.map((d) => d.text).join(""), "lo");
  assert.equal(second.deltas.at(-1)?.totalTokens, 12);
  assert.equal(second.rest, "");
});
