import type { Context } from "@earendil-works/chord/context";
import type {
  Conversation,
  ConversationView,
  ConversationWindow,
  Cursor,
  EntryId,
  EntryRecord,
  InboxState,
  LiveState,
} from "@earendil-works/pi-durable";

const PAGE = 256;

/** Every entry of the conversation's history through `through` (all of it when absent), oldest first. */
export async function history(conversation: Conversation, context: Context, through?: EntryId): Promise<EntryRecord[]> {
  const pages: (readonly EntryRecord[])[] = [];
  let cursor: Cursor | undefined;
  do {
    // Newest first, Pi's default order.
    const page = await conversation.entries(
      through === undefined ? {} : { maxEntryId: through },
      PAGE,
      cursor,
      context,
    );
    pages.push(page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return pages.flat().reverse();
}

/** Bounds of one page of older history sent to the browser: a snapshot's, or one it asks for. */
const HISTORY_PAGE_ENTRIES = 1000;
const HISTORY_PAGE_BYTES = 4 * 1024 * 1024;

/**
 * The newest entries through `through`, oldest first, within the page bounds (at least one when any exists), and the
 * oldest one's ID when older entries remain, which a later page continues before.
 */
export async function historyPage(
  conversation: Conversation,
  context: Context,
  through: EntryId,
): Promise<{ entries: EntryRecord[]; older: EntryId | null }> {
  const entries: EntryRecord[] = [];
  let bytes = 0;
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({ maxEntryId: through }, PAGE, cursor, context);
    for (const entry of page.items) {
      const size = JSON.stringify(entry).length;
      if (entries.length > 0 && (entries.length >= HISTORY_PAGE_ENTRIES || bytes + size > HISTORY_PAGE_BYTES)) {
        const older = entries.at(-1)?.id ?? null;
        return { entries: entries.reverse(), older };
      }
      entries.push(entry);
      bytes += size;
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return { entries: entries.reverse(), older: null };
}

/** The conversation's view as it is now, read once. */
export async function currentView(
  conversation: Conversation,
  context: Context,
  window?: ConversationWindow,
): Promise<ConversationView> {
  const watch = await conversation.watch(context, window);
  try {
    return watch.value;
  } finally {
    await watch.stop();
  }
}

/** The view's run state and queue; Pi always mounts both, and an absent one reads as empty. */
export function liveDocs(view: Pick<ConversationView, "docs">): { live: LiveState; inbox: InboxState } {
  // SAFETY: Pi keys a view's built-in documents by kind, so `pi.live` and `pi.inbox` hold their documents' values.
  return {
    live: (view.docs["pi.live"] ?? {}) as LiveState,
    inbox: (view.docs["pi.inbox"] ?? { items: [] }) as InboxState,
  };
}
