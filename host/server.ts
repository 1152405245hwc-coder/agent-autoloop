// What the kernel's doors need from this machine: the clock, a timer for the next deadline, long polls to wake, the
// rules file to watch, the log as a stream and the webhook plugins.
import { watch } from "node:fs";
import { dirname } from "node:path";
import { RULES_FILE } from "./home.ts";
import { loadPlugin } from "./plugins.ts";
import * as hub from "./runtime.ts";
import { AuthError, NotFound } from "../kernel/errors.ts";
import { createHandler } from "../kernel/http.ts";

/** Past this setTimeout fires at once. */
const LONGEST_TIMER = 2147483647;

function logStream(after: number, signal: AbortSignal, key: string) {
  let cursor = after;
  let unsubscribe = () => {};
  let stop = () => {};
  const detach = () => {
    unsubscribe();
    signal.removeEventListener("abort", stop);
  };
  return new ReadableStream({
    start(controller) {
      stop = () => {
        detach();
        controller.close();
      };
      const send = () => {
        if (!hub.whose("owner", key)) return stop();
        for (const fact of hub.logAfter(cursor)) {
          cursor = fact.seq;
          const message = `id: ${fact.seq}\nevent: fact\ndata: ${JSON.stringify(fact)}\n\n`;
          controller.enqueue(new TextEncoder().encode(message));
        }
      };
      unsubscribe = hub.onChange(send);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      else send();
    },
    cancel: detach,
  });
}

async function adaptWebhook(source: string, headers: Headers, body: string) {
  const adapter = hub.rules.sources[source]?.adapter;
  if (!adapter || !/^[a-z][a-z0-9-]*$/.test(adapter)) throw new NotFound("这个来源不收 Webhook");
  const translate = await loadPlugin(adapter, "source");
  const secret = process.env[`AGENT_HUB_SECRET_${source.toUpperCase().replaceAll("-", "_")}`] ?? "";
  try {
    const events = translate({ headers: Object.fromEntries(headers), body, secret });
    return Array.isArray(events) ? events : [];
  } catch {
    throw new AuthError("验签没过");
  }
}

export function makeHandler(commit = "dev") {
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const waiting = new Set<{ until: number; done: () => void }>();
  const wake = () => {
    for (const waiter of [...waiting]) waiter.done();
  };
  const arm = () => {
    clearTimeout(timer);
    if (closed) return;
    const dates = Object.values(hub.getView().tables.due).map((deadline) => deadline.at as number);
    const next = Math.min(...dates, ...[...waiting].map((waiter) => waiter.until));
    if (!Number.isFinite(next)) return;
    const delay = Math.max(0, Math.min(LONGEST_TIMER, next - Date.now()));
    timer = setTimeout(() => {
      hub.tick();
      wake();
      arm();
    }, delay);
  };
  const unlisten = hub.onChange((type, facts) => {
    // Being seen wakes nobody, unless it changed a card.
    const justSeen = type === "heartbeat" || type === "channelSeen";
    if (!justSeen || facts.some((fact) => fact.changes.some((change) => change.table === "cards"))) wake();
    arm();
  });
  const watcher = watch(dirname(RULES_FILE), (_event, file) => {
    if (file !== RULES_FILE.split("/").at(-1)) return;
    hub.tick();
    arm();
  });
  const handle = createHandler({
    commit,
    now: Date.now,
    view: hub.getView,
    environment: hub.environment,
    dispatch: hub.execute,
    state: hub.stateOf,
    why: hub.why,
    wait(until, signal) {
      return new Promise((resolve) => {
        const waiter = {
          until,
          done() {
            waiting.delete(waiter);
            signal.removeEventListener("abort", waiter.done);
            resolve();
          },
        };
        waiting.add(waiter);
        signal.addEventListener("abort", waiter.done, { once: true });
        if (signal.aborted) waiter.done();
        arm();
      });
    },
    stream: logStream,
    adapt: adaptWebhook,
  });
  hub.tick();
  arm();
  return {
    handle,
    close() {
      closed = true;
      clearTimeout(timer);
      watcher.close();
      unlisten();
      wake();
    },
  };
}
