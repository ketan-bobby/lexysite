import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

type Command = DeleteObjectsCommand | ListObjectsV2Command;
type Service = {
  deleteObjectsUnderPrefix(prefix: string): Promise<{ deleted: number; error?: string }>;
};

function service(send: (command: Command) => Promise<unknown>): Service {
  const path = new URL("./objectStorage.ts", import.meta.url);
  const text = readFileSync(path, "utf8");
  const tree = ts.createSourceFile(path.pathname, text, ts.ScriptTarget.Latest, true);
  const declaration = tree.statements.find(
    (node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === "ObjectStorageService",
  );
  const method = declaration?.members.find(
    (node) =>
      ts.isMethodDeclaration(node) && node.name.getText(tree) === "deleteObjectsUnderPrefix",
  );
  assert.ok(method);
  const code = ts.transpileModule(`const service = {${method.getText(tree)}};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  // Execute the current method; only its SDK transport and bucket/prefix getters
  // are doubled. No credentials are loaded and no actual objects are deleted.
  return new Function(
    "s3Client",
    "ListObjectsV2Command",
    "DeleteObjectsCommand",
    `${code}; service.getBucket = () => "fixture"; service.getPrivatePrefix = () => "private"; return service;`,
  )({ send }, ListObjectsV2Command, DeleteObjectsCommand);
}

test("prefix deletion paginates, retains the exact scoped prefix and counts quiet successes", async () => {
  const commands: Command[] = [];
  let page = 0;
  const result = await service(async (command) => {
    commands.push(command);
    if (command instanceof ListObjectsV2Command) {
      assert.equal(command.input.Bucket, "fixture");
      assert.equal(command.input.Prefix, "private/candidate-fixture/");
      page++;
      if (page === 1)
        return {
          Contents: [{ Key: "private/candidate-fixture/a" }, {}],
          IsTruncated: true,
          NextContinuationToken: "fixture-next",
        };
      assert.equal(command.input.ContinuationToken, "fixture-next");
      return { Contents: [{ Key: "private/candidate-fixture/b" }] };
    }
    assert.equal(command.input.Delete?.Quiet, true);
    assert.equal(command.input.Delete?.Objects?.length, 1);
    return {}; // S3 Quiet=true need not return a Deleted array.
  }).deleteObjectsUnderPrefix("/candidate-fixture/");
  assert.deepEqual(result, { deleted: 2 });
  assert.equal(commands.length, 4);
});

test("HTTP-success per-object errors remain incomplete and stop further deletion pages", async () => {
  let calls = 0;
  const result = await service(async (command) => {
    calls++;
    if (command instanceof ListObjectsV2Command)
      return {
        Contents: [{ Key: "private/candidate-fixture/a" }, { Key: "private/candidate-fixture/b" }],
        IsTruncated: true,
        NextContinuationToken: "fixture-next",
      };
    return {
      Errors: [
        { Key: "private/candidate-fixture/b", Code: "AccessDenied", Message: "private details" },
      ],
    };
  }).deleteObjectsUnderPrefix("candidate-fixture");
  assert.deepEqual(result, { deleted: 1, error: "Failed to delete 1 storage object(s)" });
  assert.equal(calls, 2);
  assert.ok(!result.error?.includes("private"));
});

test("an incomplete listing without a continuation token cannot claim completion", async () => {
  const result = await service(async () => ({ IsTruncated: true })).deleteObjectsUnderPrefix(
    "candidate-fixture",
  );
  assert.deepEqual(result, { deleted: 0, error: "Storage listing is incomplete" });
});

test("a later transport failure retains completed counts and reports failure", async () => {
  let listed = false;
  const result = await service(async (command) => {
    if (command instanceof DeleteObjectsCommand) return {};
    if (listed) throw new Error("fixture transport failed");
    listed = true;
    return {
      Contents: [{ Key: "private/candidate-fixture/a" }],
      IsTruncated: true,
      NextContinuationToken: "next",
    };
  }).deleteObjectsUnderPrefix("candidate-fixture");
  assert.deepEqual(result, { deleted: 1, error: "fixture transport failed" });
});
