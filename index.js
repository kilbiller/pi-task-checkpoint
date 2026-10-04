import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createExtension } from "./extension.js";

export default function (pi) { createExtension(pi, getAgentDir()); }
