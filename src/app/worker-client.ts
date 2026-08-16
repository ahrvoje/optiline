/**
 * Thin typed clients for the optimizer and certifier workers (§6.2,
 * §21). The clients stamp every outgoing command with the current
 * envelope (run version + fingerprints) and drop every incoming event
 * whose envelope is stale. Worker code itself is owned elsewhere; this
 * module only speaks the OptimizerCommand/OptimizerEvent and
 * CertifierCommand/CertifierEvent contracts.
 */
import type {
  CertifierCommand,
  CertifierEvent,
  MessageEnvelope,
  OptimizerCommand,
  OptimizerEvent,
} from "@/model/contracts";
import { isFreshEnvelope } from "@/app/state-machine";

/** Omit distributed over a union (the command types are unions). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type OptimizerCommandBody = DistributiveOmit<OptimizerCommand, keyof MessageEnvelope>;
export type CertifierCommandBody = DistributiveOmit<CertifierCommand, keyof MessageEnvelope>;

export type EnvelopeSource = () => MessageEnvelope;

class TypedWorkerClient<TBody extends object, TEvent extends MessageEnvelope> {
  #worker: Worker;
  #envelope: EnvelopeSource;
  #onEvent: (event: TEvent) => void;
  #onStale: ((event: TEvent) => void) | undefined;

  constructor(
    worker: Worker,
    envelope: EnvelopeSource,
    onEvent: (event: TEvent) => void,
    onStale?: (event: TEvent) => void,
  ) {
    this.#worker = worker;
    this.#envelope = envelope;
    this.#onEvent = onEvent;
    this.#onStale = onStale;
    worker.addEventListener("message", (m: MessageEvent) => {
      const event = m.data as TEvent;
      if (isFreshEnvelope(event, this.#envelope())) {
        this.#onEvent(event);
      } else {
        this.#onStale?.(event);
      }
    });
  }

  /** Stamp the current envelope onto the body and post it. */
  send(body: TBody, transfer?: Transferable[]): void {
    const message = { ...this.#envelope(), ...body };
    if (transfer && transfer.length > 0) {
      this.#worker.postMessage(message, transfer);
    } else {
      this.#worker.postMessage(message);
    }
  }

  terminate(): void {
    this.#worker.terminate();
  }
}

export class OptimizerClient extends TypedWorkerClient<OptimizerCommandBody, OptimizerEvent> {}
export class CertifierClient extends TypedWorkerClient<CertifierCommandBody, CertifierEvent> {}

/**
 * Worker instantiation. The worker source files are owned by another
 * module set; these are runtime paths only — no types are imported from
 * them (build-time contract, §6.2).
 */
export function createOptimizerWorker(): Worker {
  return new Worker(new URL("../workers/optimizer-worker.ts", import.meta.url), {
    type: "module",
  });
}

export function createCertifierWorker(): Worker {
  return new Worker(new URL("../workers/certifier-worker.ts", import.meta.url), {
    type: "module",
  });
}
