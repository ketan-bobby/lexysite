import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

// Execute the current search call and JSON helper with a provider double.
// No live AI calls, database writes or historical candidate reassessment.
function sourceTree(path: string) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
}

function searchCall() {
  const tree = sourceTree("./candidates.ts");
  let call: ts.CallExpression | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(tree) === "router.post" &&
      ts.isStringLiteral(node.arguments[0]!) &&
      node.arguments[0].text === "/candidates/nl-search"
    ) {
      function findCall(child: ts.Node) {
        if (ts.isCallExpression(child) && child.expression.getText(tree) === "generateJSON")
          call = child;
        ts.forEachChild(child, findCall);
      }
      findCall(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(call, "the current natural-language search must call the shared JSON helper");
  return { tree, call };
}

type Message = { role: string; content: string };
type Provider = (
  messages: Message[],
  language: string,
  options: { temperature: number; seed: number },
) => Promise<string>;
type JsonHelper = (prompt: string) => Promise<unknown>;

function jsonHelper(provider: Provider): JsonHelper {
  const tree = sourceTree("../lib/ai.ts");
  const declaration = tree.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "generateJSON",
  );
  assert.ok(declaration);
  const code = ts.transpileModule(declaration.getText(tree).replace(/^export\s+/, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function("chatCompletionWithAI", `${code}; return generateJSON;`)(provider);
}

function runSearch(query: string, generateJSON: JsonHelper): Promise<unknown> {
  const { tree, call } = searchCall();
  const code = ts.transpileModule(`const result = ${call.getText(tree)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function("query", "generateJSON", `${code}; return result;`)(query, generateJSON);
}

test("natural-language search omits the invalid object-valued system instruction", () => {
  const { call } = searchCall();
  assert.equal(call.arguments.length, 1, "use the existing shared helper defaults");
  assert.ok(ts.isTemplateExpression(call.arguments[0]!));
});

test("search uses the existing JSON instruction, language, temperature and seed", async () => {
  let captured: { messages: Message[]; language: string; options: unknown } | undefined;
  const filters = {
    skills: ["TypeScript"],
    locations: ["London"],
    interpretation: "Showing matching candidates",
  };
  const helper = jsonHelper(async (messages, language, options) => {
    captured = { messages, language, options };
    return JSON.stringify(filters);
  });
  const result = await runSearch("TypeScript candidates in London", helper);
  assert.deepEqual(result, filters);
  assert.ok(captured);
  assert.equal(
    captured.messages[0]?.content,
    "Respond with valid JSON only — no markdown fences, no commentary.",
  );
  assert.equal(captured.messages[0]?.role, "system");
  assert.equal(captured.messages[1]?.role, "user");
  assert.match(captured.messages[1]!.content, /Query: "TypeScript candidates in London"/);
  assert.equal(captured.language, "en-US");
  assert.deepEqual(captured.options, { temperature: 0, seed: 42 });
  assert.ok(captured.messages.every((message) => typeof message.content === "string"));
});

test("search preserves omitted optional arrays rather than inventing fallback filters", async () => {
  const result = await runSearch(
    "my candidates",
    jsonHelper(
      async () => '```json\n{"pool":"tenant","interpretation":"Showing my candidates"}\n```',
    ),
  );
  assert.deepEqual(result, { pool: "tenant", interpretation: "Showing my candidates" });
});

test("invalid AI JSON and provider failures propagate instead of returning fabricated empty results", async () => {
  await assert.rejects(
    runSearch(
      "candidates",
      jsonHelper(async () => "not JSON"),
    ),
    SyntaxError,
  );
  const providerError = new Error("fixture provider unavailable");
  await assert.rejects(
    runSearch(
      "candidates",
      jsonHelper(async () => {
        throw providerError;
      }),
    ),
    (error) => error === providerError,
  );
});
