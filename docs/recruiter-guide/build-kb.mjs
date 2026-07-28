/* Regenerates artifacts/api-server/src/lib/help-kb.generated.ts from guide.html.
   Run after editing the guide: node docs/recruiter-guide/build-kb.mjs */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
let html = readFileSync(path.join(dir, "guide.html"), "utf8");
html = html.replace(/<style>[\s\S]*?<\/style>/, "");
html = html.replace(/<div class="cover">[\s\S]*?<\/div>/, "");
const text = html
  .replace(/<h2[^>]*>/g, "\n\n## ")
  .replace(/<h3[^>]*>/g, "\n### ")
  .replace(/<h4[^>]*>/g, "\n#### ")
  .replace(/<li[^>]*>/g, "\n- ")
  .replace(/<tr[^>]*>/g, "\n| ")
  .replace(/<\/t[hd]>/g, " | ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&nbsp;/g, " ")
  .replace(/[ \t]+/g, " ")
  .replace(/\n{3,}/g, "\n\n")
  .trim();
const out =
  "/* AUTO-GENERATED from docs/recruiter-guide/guide.html — regenerate with docs/recruiter-guide/build-kb.mjs. Do not hand-edit. */\nexport const HELP_KB = " +
  JSON.stringify(text) +
  ";\n";
writeFileSync(path.resolve(dir, "../../artifacts/api-server/src/lib/help-kb.generated.ts"), out);
console.log("KB regenerated:", text.length, "chars");
