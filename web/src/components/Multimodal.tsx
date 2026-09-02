/**
 * Multimodal composer controls: attach an image, or dictate by voice.
 *
 * WHY THESE ARE EXPLICIT CONTROLS
 * -------------------------------
 * The two extra models are not part of the routing ladder and must never be
 * chosen for you. Tier routing ranks TEXT models by task complexity; a vision
 * or speech model has no position on that ladder, and a code question routed to
 * Whisper cannot produce an answer at all. So the user says when an image or a
 * recording is part of the turn, and the UI names the exact model that will
 * handle it before anything is sent — the routing decision stays visible
 * (PS 3b) even for these side paths.
 *
 * WHY VOICE INSERTS TEXT RATHER THAN SENDING
 * ------------------------------------------
 * Transcription is not reliable enough to act on unreviewed, and this agent
 * takes real actions on a real filesystem. A misheard "delete" is not something
 * to discover afterwards. The transcript lands in the composer, where it can be
 * edited or discarded like anything typed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useUi } from "../stores/ui";

export interface Capability {
  provider: string;
  model: string;
  param_b: number;
  key_present: boolean;
}
export type Capabilities = { vision: Capability | null; transcription: Capability | null };

export interface Attachment {
  id: string;
  name: string;
  /** data: URL — what the vision model is actually sent. */
  dataUrl: string;
  bytes: number;
}

/** Providers reject oversized images with an opaque 400; fail here instead. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export function useCapabilities(): Capabilities | null {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/router/capabilities")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && j) setCaps(j as Capabilities); })
      .catch(() => { /* capability strip simply stays hidden */ });
    return () => { alive = false; };
  }, []);
  return caps;
}

export function readImageFile(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) return reject(new Error(`${file.name} is not an image`));
    if (file.size > MAX_IMAGE_BYTES) {
      return reject(new Error(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB — limit is 4 MB`));
    }
    const fr = new FileReader();
    fr.onerror = () => reject(new Error(`could not read ${file.name}`));
    fr.onload = () =>
      resolve({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: file.name,
                dataUrl: String(fr.result), bytes: file.size });
    fr.readAsDataURL(file);
  });
}

/** Thumbnails of what will be sent. An attachment you cannot see is one you
 *  cannot notice is wrong. */
export function AttachmentStrip(
  { items, onRemove }: { items: Attachment[]; onRemove: (id: string) => void },
) {
  if (items.length === 0) return null;
  return (
    <div className="mm-strip" role="list" aria-label="attached images">
      {items.map((a) => (
        <div className="mm-thumb" role="listitem" key={a.id} title={`${a.name} · ${(a.bytes / 1024).toFixed(0)} KB`}>
          <img src={a.dataUrl} alt={a.name} />
          <button type="button" className="mm-thumb-x" aria-label={`remove ${a.name}`} onClick={() => onRemove(a.id)}>✕</button>
        </div>
      ))}
    </div>
  );
}

/**
 * Record → transcribe → drop the text in the composer.
 *
 * Recording stops on a second click, not a timer: dictating a paragraph is a
 * normal thing to do and a hidden cutoff would truncate it silently.
 */
export function VoiceButton(
  { cap, onText, disabled }: { cap: Capability | null; onText: (t: string) => void; disabled?: boolean },
) {
  const [state, setState] = useState<"idle" | "recording" | "working">("idle");
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const toast = useUi((s) => s.toast);

  // A recorder left running holds the microphone (and its indicator) open for
  // the life of the tab.
  useEffect(() => () => {
    try { recRef.current?.stream.getTracks().forEach((t) => t.stop()); } catch { /* already gone */ }
  }, []);

  const stop = useCallback(() => {
    try { recRef.current?.stop(); } catch { /* already stopped */ }
  }, []);

  const start = useCallback(async () => {
    if (!cap?.key_present) {
      toast(cap ? `Voice needs a ${cap.provider} API key — add one in Settings` : "No transcription model configured", "err");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast("Microphone permission denied", "err");
      return;
    }
    const rec = new MediaRecorder(stream);
    recRef.current = rec;
    chunksRef.current = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setState("working");
      try {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        const fd = new FormData();
        fd.append("file", blob, "speech.webm");
        const res = await fetch("/api/transcribe", { method: "POST", body: fd });
        const j = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
        if (!res.ok) throw new Error(j.error ?? `transcription failed (${res.status})`);
        const said = (j.text ?? "").trim();
        // Silence transcribes to "" or punctuation; saying so beats a no-op.
        if (!said || said.replace(/[.\s]/g, "") === "") toast("Nothing recognised in that recording", "err");
        else onText(said);
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), "err");
      } finally {
        setState("idle");
      }
    };
    rec.start();
    setState("recording");
  }, [cap, onText, toast]);

  const label = state === "recording" ? "Stop recording" : state === "working" ? "Transcribing…" : "Record voice";
  return (
    <button
      type="button"
      className={`btn tiny mm-btn${state === "recording" ? " is-rec" : ""}`}
      onClick={() => (state === "recording" ? stop() : void start())}
      disabled={disabled || state === "working" || !cap}
      title={cap ? `${label} · ${cap.model} @ ${cap.provider}` : "No transcription model configured"}
      aria-pressed={state === "recording"}
    >
      {state === "recording" ? "■ Stop" : state === "working" ? "…" : "● Voice"}
    </button>
  );
}

/** Names the exact model that will handle an attachment, before you send. */
export function CapabilityNote({ cap, kind }: { cap: Capability | null; kind: string }) {
  if (!cap) return <span className="mm-note is-off">no {kind} model configured</span>;
  if (!cap.key_present) return <span className="mm-note is-off">{kind}: needs a {cap.provider} key</span>;
  return <span className="mm-note">{kind}: {cap.model} @ {cap.provider} · {cap.param_b}B</span>;
}
