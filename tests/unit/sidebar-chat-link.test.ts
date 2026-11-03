import test from "node:test";
import assert from "node:assert/strict";

import { SIDEBAR_SECTIONS } from "../../src/shared/constants/sidebarVisibility/sections.ts";

test("sidebar Home section links to the Chat page", () => {
  const home = SIDEBAR_SECTIONS.find((s) => s.id === "home");
  assert.ok(home, "home section exists");
  const chat = home.children.find((c) => "href" in c && c.href === "/dashboard/chat");
  assert.ok(chat, "chat item is in the Home section");
  assert.equal(chat.id, "chat");
});
