import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

// The tested pure helpers have only node: runtime imports, so a data URL needs no resolver.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const javascript = stripTypeScriptTypes(source);
export const worksheet = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
