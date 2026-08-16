/**
 * Application state machine (§21).
 *
 * The allowed-action table and the transition table below are the
 * structural encoding of the §21 table. Controls never dispatch an
 * action without `can()` returning true, and `transitionTo()` refuses
 * any edge that is not listed, so a local edit cannot silently create a
 * new state flow.
 */
import type { AppState, MessageEnvelope } from "@/model/contracts";

export type AppAction =
  | "selectTrack"
  | "editSettings"
  | "optimize"
  | "stop"
  | "play"
  | "pause"
  | "restartPlayback"
  | "setSpeed"
  | "save"
  | "toggleZoom"
  | "changeFocus"
  | "selectProfiles"
  | "inspect"
  | "importTrack"
  | "importProfile"
  | "newRun"
  | "restartGpu"
  | "cpuFallback"
  | "reset"
  | "exportDiagnostics";

/**
 * §21 allowed actions by state. Conditional qualifiers in the table
 * ("play if profile", "save if certified", "toggle zoom/focus if
 * profile") are enforced additionally by the controller predicates; the
 * sets below are the state-level gate.
 */
export const ALLOWED_ACTIONS: Record<AppState, ReadonlySet<AppAction>> = {
  loading: new Set<AppAction>([]),
  ready: new Set<AppAction>([
    "selectTrack",
    "editSettings",
    "optimize",
    "play",
    "save",
    "toggleZoom",
    "changeFocus",
    "selectProfiles",
    "importTrack",
    "importProfile",
    "newRun",
    "inspect",
  ]),
  optimizing: new Set<AppAction>(["stop", "inspect"]),
  stopping: new Set<AppAction>(["inspect"]),
  certifying: new Set<AppAction>(["inspect"]),
  playing: new Set<AppAction>([
    "pause",
    "restartPlayback",
    "setSpeed",
    "toggleZoom",
    "changeFocus",
    "inspect",
  ]),
  paused: new Set<AppAction>([
    "play",
    "restartPlayback",
    "selectProfiles",
    "toggleZoom",
    "changeFocus",
    "inspect",
  ]),
  gpuLost: new Set<AppAction>(["restartGpu", "cpuFallback"]),
  error: new Set<AppAction>(["reset", "exportDiagnostics"]),
};

/** Legal state transitions (§21 exit conditions). */
export const TRANSITIONS: Record<AppState, readonly AppState[]> = {
  loading: ["ready", "error"],
  ready: ["optimizing", "playing", "certifying", "gpuLost", "error"],
  optimizing: ["stopping", "gpuLost", "error"],
  stopping: ["certifying", "ready", "gpuLost", "error"],
  certifying: ["ready", "error"],
  playing: ["paused", "ready", "error"],
  paused: ["playing", "ready", "error"],
  gpuLost: ["ready", "error"],
  error: ["ready", "loading"],
};

export type StateListener = (next: AppState, prev: AppState) => void;

export class StateMachine {
  #state: AppState = "loading";
  #listeners = new Set<StateListener>();

  get state(): AppState {
    return this.#state;
  }

  can(action: AppAction): boolean {
    return ALLOWED_ACTIONS[this.#state].has(action);
  }

  /**
   * Move to `next` if the edge is legal; returns whether it happened.
   * Illegal edges are refused rather than thrown, because they can
   * legitimately arise from late asynchronous events.
   */
  transitionTo(next: AppState): boolean {
    if (next === this.#state) return true;
    if (!TRANSITIONS[this.#state].includes(next)) return false;
    const prev = this.#state;
    this.#state = next;
    for (const l of this.#listeners) l(next, prev);
    return true;
  }

  onChange(listener: StateListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

/**
 * §21 staleness rule: every asynchronous worker message carries the
 * track fingerprint, settings fingerprint, and monotonically increasing
 * run version; the receiver SHALL discard stale messages. A message is
 * fresh only when all three match the receiver's current values.
 */
export function isFreshEnvelope(message: MessageEnvelope, current: MessageEnvelope): boolean {
  return (
    message.runVersion === current.runVersion &&
    message.trackFingerprint === current.trackFingerprint &&
    message.settingsFingerprint === current.settingsFingerprint
  );
}
