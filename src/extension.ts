import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkCommand } from "./commands/work.ts";

export default function (pi: ExtensionAPI) {
  registerWorkCommand(pi);
}
