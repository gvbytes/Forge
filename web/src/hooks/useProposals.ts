// HITL proposals for the active task + pending-hunk badge bookkeeping.
// Refetches when ANY proposal-relevant event lands in the stream (web #21:
// not just when the LAST buffered event is a proposal — a follow-up event
// committed in the same batch used to hide it).
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { ProposalDto } from "../lib/types";
import { useChat } from "../stores/chat";
import { useUi } from "../stores/ui";

/** proposal wire frame OR a trace that proposes/approves file changes. */
function isProposalRelevant(ev: { type: string; payload: any }): boolean {
  if (ev.type === "proposal") return true;
  if (ev.type === "trace") {
    const kind = ev.payload?.event?.kind;
    return kind === "diff.propose" || kind === "approval.request" || kind === "approval.decision";
  }
  return false;
}

export function useProposals(taskId: string | null): ProposalDto[] {
  const [proposals, setProposals] = useState<ProposalDto[]>([]);
  // how many buffered events we already scanned for proposal relevance
  const scanned = useRef(0);

  // task switch → reload + reset the scan cursor (and clear the badge)
  useEffect(() => {
    setProposals([]);
    scanned.current = 0;
    if (!taskId) {
      useUi.getState().setPendingHunks(0);
      return;
    }
    let alive = true;
    api.proposals(taskId)
      .then((ps) => alive && setProposals(Array.isArray(ps) ? ps : []))
      .catch(() => {/* endpoint may not exist yet; badge stays 0 */});
    return () => { alive = false; };
  }, [taskId]);

  // proposal-relevant events → refetch (scan only the new tail)
  const rev = useChat((s) => (taskId ? s.rev[taskId] ?? 0 : 0));
  useEffect(() => {
    if (!taskId || rev === 0) return;
    const evs = useChat.getState().events[taskId] ?? [];
    const tail = evs.slice(scanned.current);
    scanned.current = evs.length;
    if (tail.length === 0 || !tail.some(isProposalRelevant)) return;
    let alive = true;
    api.proposals(taskId)
      .then((ps) => alive && setProposals(Array.isArray(ps) ? ps : []))
      .catch(() => {});
    return () => { alive = false; };
  }, [rev, taskId]);

  // badge count
  useEffect(() => {
    const n = (Array.isArray(proposals) ? proposals : []).reduce(
      (acc, p) => acc + ((p && Array.isArray(p.hunks)) ? p.hunks.filter((h) => h.status === "pending").length : 0),
      0,
    );
    useUi.getState().setPendingHunks(n);
  }, [proposals]);

  return proposals;
}
