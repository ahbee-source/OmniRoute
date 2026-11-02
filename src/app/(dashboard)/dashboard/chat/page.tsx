// src/app/(dashboard)/dashboard/chat/page.tsx
// Server shell for the conversational Chat page; all state lives in the client.

import { Suspense } from "react";
import { ChatWorkspace } from "./ChatWorkspace";

export const dynamic = "force-dynamic";

export default function ChatPage() {
  return (
    <Suspense fallback={null}>
      <ChatWorkspace />
    </Suspense>
  );
}
