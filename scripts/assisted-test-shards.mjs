import ts from "typescript";

// Partition a large file's registered top-level tests, not its dependencies.
// Every shard keeps its own disposable fixture and the existing process budget.
export function shardAssistedTestBatch(batch, source, size = 20) {
  if (batch.files.length !== 1 || !Number.isInteger(size) || size < 1)
    throw new Error("Sharding requires one file and a positive integer size");
  const file = ts.createSourceFile(batch.files[0], source, ts.ScriptTarget.Latest, true);
  if (file.parseDiagnostics.length) throw new Error("Cannot shard invalid test source");
  const names = [];
  for (const statement of file.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression))
      continue;
    const call = statement.expression;
    const callee = call.expression;
    const isTest = ts.isIdentifier(callee) && callee.text === "test";
    const modifiedTest =
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "test";
    if (modifiedTest) throw new Error("Do not silently shard skipped or exclusive tests");
    if (!isTest) continue;
    if (!call.arguments[0] || !ts.isStringLiteral(call.arguments[0]))
      throw new Error("Top-level test names must be static string literals");
    names.push(call.arguments[0].text);
  }
  if (!names.length || new Set(names).size !== names.length)
    throw new Error("Test names must be nonempty and unique");
  // Node also matches descendant full names. Do not let one parent prefix
  // accidentally select a different top-level test in another shard.
  if (names.some((name) => names.some((other) => other !== name && other.startsWith(`${name} `))))
    throw new Error("Ambiguous parent test names cannot be safely sharded");
  const escape = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const shards = [];
  for (let i = 0; i < names.length; i += size) {
    const testNames = names.slice(i, i + size);
    shards.push({
      name: `${batch.name}-${shards.length + 1}`,
      files: [...batch.files],
      testNames,
      testNamePattern: `^(?:${testNames.map(escape).join("|")})(?:$|\\s)`,
    });
  }
  return shards;
}
