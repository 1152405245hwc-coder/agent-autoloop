// Feishu (Lark), through the official lark-cli: it holds the app's credentials and the long connection that brings clicks
// back, so this machine needs no public address. Only one listener can hold an app's card clicks, so run this in one place.
//   "channels": { "feishu": { "key": "…", "user": "ou_xxx" } } in config.json
//   "channels": { "feishu": { "name": "飞书", "answerers": ["ou_xxx"] } } in rules.json: who may answer.
import { execFileSync, spawn } from "node:child_process";
import readline from "node:readline";
import type { Card, ChannelContext } from "../../src/channels.ts";

/** One card, as it looks now: the options while it's open, what became of it after. */
export function render(card: Card) {
  const chosen = card.choice === null ? card.answer : card.options[card.choice];
  const outcome = card.state === "decided" ? `你选了「${chosen}」，已记录，等待处理。`
    : card.state === "done" ? `你选了「${chosen}」。${card.result ? `已执行：${card.result}` : "已执行。"}`
    : card.state === "closed" && card.kind === "ask" ? `不用决定了：${card.result ?? ""}`
    : card.state === "closed" && card.result ? card.result : null;
  // Each option is a block across the card, its words wrapping: buttons in a row, one line high, cut long options off.
  const option = (label: string, i: number) => ({
    tag: "interactive_container", width: "fill", has_border: true, border_color: i === card.recommend ? "blue" : "grey", corner_radius: "8px", padding: "8px 12px 8px 12px",
    behaviors: [{ type: "callback", value: { card: card.id, choice: i } }],
    elements: [{ tag: "div", text: { tag: "plain_text", content: label } }],
  });
  return {
    schema: "2.0",
    config: { update_multi: true, enable_forward: false },
    header: { title: { tag: "plain_text", content: card.title }, template: card.state === "open" ? "blue" : card.state === "closed" ? "grey" : "green" },
    body: {
      elements: [
        ...(card.text ? [{ tag: "markdown", content: card.text }] : []),
        ...(card.state === "open" ? card.options.map(option) : outcome ? [{ tag: "markdown", content: `**${outcome}**` }] : []),
      ],
    },
  };
}

export default async function feishu({ hub, options, log, signal }: ChannelContext) {
  const LARK = (options.lark as string | undefined) ?? "lark-cli";
  const lark = (args: string[], input: string) => {
    const out = JSON.parse(execFileSync(LARK, args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 60_000 }));
    if (out.ok === false || out.error) throw new Error(`lark-cli ${args.slice(0, 3).join(" ")}: ${JSON.stringify(out.error ?? out).slice(0, 300)}`);
    return out;
  };
  const owner = (options.user as string | undefined) ?? lark(["auth", "status"], "").identities?.user?.openId;
  if (!owner) throw new Error("飞书通道要在 config.json 写 user，或者先 lark-cli auth login");

  async function deliver() {
    while (!signal.aborted) {
      let card: Card | null;
      try {
        ({ card } = await hub.nextCard(50));
      } catch (error) {
        log(`couldn't reach the hub: ${error}`);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        continue;
      }
      if (!card) continue;
      try {
        const content = JSON.stringify(render(card));
        let ref = card.ref;
        if (ref) lark(["im", "messages", "patch", "--message-id", ref, "--as", "bot", "--data", "-"], JSON.stringify({ content }));
        // The key is the card alone, not its version: a report that got lost must not make a second message.
        else ref = lark(["im", "+messages-send", "--user-id", owner, "--as", "bot", "--msg-type", "interactive", "--idempotency-key", `agent-hub-card-${card.id}`, "--content", "-"], content).data.message_id as string;
        await hub.delivered(card.id, card.version, ref);
      } catch (error) {
        log(`card ${card.id} not sent: ${error}`);
        await hub.failed(card.id, card.version, String(error)).catch(() => {});
      }
    }
  }

  /** Only the owner's click on the card that was sent counts; the hub checks both. */
  async function clicked(line: string) {
    const event = JSON.parse(line);
    const value = JSON.parse(event.action_value);
    if (!Number.isInteger(value.card) || !Number.isInteger(value.choice)) return;
    const answer = await hub.answer(value.card, { choice: value.choice, by: event.operator_id, ref: event.message_id });
    log(`card ${value.card}: answered by ${event.operator_id}, ${answer.changed ? "counted" : "already settled"}`);
  }

  async function listen() {
    while (!signal.aborted) {
      // stdin stays open: lark-cli ends an unbounded consume when its stdin closes.
      const consume = spawn(LARK, ["event", "consume", "card.action.trigger", "--as", "bot"], { stdio: ["pipe", "pipe", "pipe"] });
      const stop = () => consume.kill();
      signal.addEventListener("abort", stop);
      readline.createInterface({ input: consume.stderr }).on("line", (line) => log(line));
      readline.createInterface({ input: consume.stdout }).on("line", (line) => void clicked(line).catch((error) => log(`click not handled: ${error}`)));
      await new Promise((resolve) => consume.on("close", resolve));
      signal.removeEventListener("abort", stop);
      if (!signal.aborted) {
        log("the click listener stopped; starting it again in 10 seconds");
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    }
  }

  await Promise.all([deliver(), listen()]);
}
