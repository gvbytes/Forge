// The user's own prompt must never render below the reply to it.
//
// deriveTimeline used to end with `[...dedupeAdjacent(out), ...local]` —
// optimistic local items (the bubble shown the instant you hit send) were
// CONCATENATED after every server event. Send a second prompt while a task is
// still streaming and your message appeared underneath the previous turn's
// thinking and tool output. A transcript has to read in the order things
// happened, so local items are now merged by timestamp.
import { describe, expect, test } from "bun:test";
import { deriveTimeline, type TimelineItem } from "../src/stores/chat";
import type { EventDto } from "../src/lib/types";

const ev = (id: number, ts: number, type: string, payload: unknown): EventDto =>
  ({ id, taskId: "t1", ts, type, payload } as EventDto);

const localMsg = (id: string, ts: number, text: string): TimelineItem =>
  ({ kind: "message", id, ts, role: "user", text } as unknown as TimelineItem);

describe("deriveTimeline — chronological ordering of optimistic messages", () => {
  test("a prompt sent mid-task renders ABOVE the output that follows it", () => {
    const events = [
      ev(1, 1000, "message", { id: "m1", role: "user", content: "first prompt" }),
      ev(2, 2000, "message", { id: "m2", role: "assistant", content: "first answer" }),
      // server-side output that arrives AFTER the second prompt was typed
      ev(3, 4000, "message", { id: "m3", role: "assistant", content: "second answer" }),
    ];
    const local = [localMsg("local-1", 3000, "second prompt")];

    const idx = deriveTimeline(events, local).map((i) => (i as { text?: string }).text);
    const promptAt = idx.indexOf("second prompt");
    const answerAt = idx.indexOf("second answer");

    expect(promptAt).toBeGreaterThanOrEqual(0);
    expect(answerAt).toBeGreaterThanOrEqual(0);
    // The regression: promptAt used to be LAST, after "second answer".
    expect(promptAt).toBeLessThan(answerAt);
  });

  test("a local item newer than everything still sorts last", () => {
    const events = [ev(1, 1000, "message", { id: "m1", role: "assistant", content: "older" })];
    const out = deriveTimeline(events, [localMsg("l", 9000, "newest")]);
    expect((out[out.length - 1] as { text?: string }).text).toBe("newest");
  });

  test("ordering is stable for items sharing a timestamp", () => {
    const events = [ev(1, 5000, "message", { id: "m1", role: "assistant", content: "server" })];
    const out = deriveTimeline(events, [localMsg("l", 5000, "local")]).map((i) => (i as { text?: string }).text);
    // Tie breaks toward the server item so an optimistic bubble stays adjacent
    // to the confirmed copy it will be deduped against.
    expect(out.indexOf("server")).toBeLessThan(out.indexOf("local"));
  });
});
