// Where this install keeps its things: rules.json, config.json, secrets.env, hub.db and the worker's runs.
import { homedir } from "node:os";
import path from "node:path";

export const HOME = path.resolve(process.env.AGENT_HUB_HOME ?? path.join(homedir(), ".agent-hub"));
export const RULES_FILE = path.resolve(process.env.AGENT_HUB_RULES ?? path.join(HOME, "rules.json"));
