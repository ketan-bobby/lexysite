import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { parseCareerResumeProfile } from "../lib/career-resume-profile";

// Execute current source bodies with DB, storage and AI calls substituted.
// No candidate data, external requests or real assessments are used.
function sourceAst(file: string) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
}
function load<T>(source: string, context: Record<string, unknown>): T {
  const exports = {};
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(compiled, { exports, ...context });
  return exports as T;
}
const careerAst = sourceAst("./career-profile.ts");
function resumeHandler(path: string) {
  const matches: string[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(careerAst) === "router.post" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === path
    ) {
      matches.push(node.arguments[node.arguments.length - 1]!.getText(careerAst));
    }
    ts.forEachChild(node, visit);
  }
  visit(careerAst);
  assert.equal(matches.length, 1);
  return matches[0]!;
}

test("structured résumé output rejects null, empty objects, primitives and wrong field shapes", () => {
  for (const raw of [
    "null",
    "{}",
    "[]",
    '"text"',
    "1",
    "true",
    "not JSON",
    '{"core_skills":"TypeScript"}',
    '{"total_years_experience":"many"}',
    '{"linkedin_url":42}',
    '{"tools":[null]}',
  ]) {
    assert.throws(() => parseCareerResumeProfile(raw), raw);
  }
});

test("valid partial résumé data preserves nulls, zero years and missing fields", () => {
  const profile = parseCareerResumeProfile(
    '{"core_skills":["TypeScript"],"total_years_experience":0,"linkedin_url":null}',
  );
  assert.deepEqual(profile.core_skills, ["TypeScript"]);
  assert.equal(profile.total_years_experience, 0);
  assert.equal(profile.linkedin_url, null);
  assert.equal(profile.name, undefined);
});

async function runResumeCase(path: string, raw: string | null, authenticated = true) {
  const writes: Record<string, unknown>[] = [];
  const socials: unknown[] = [];
  const modelCalls: unknown[] = [];
  const candidatesTable = { id: "candidate-id", resumeUrl: "resume-url" };
  const profilesTable = { id: "profile-id", candidateId: "profile-candidate-id" };
  let status = 200;
  let body: Record<string, unknown> = {};
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: Record<string, unknown>) {
      body = value;
      return res;
    },
  };
  const { handler } = load<{ handler: (req: unknown, res: unknown) => Promise<unknown> }>(
    `export const handler = ${resumeHandler(path)};`,
    {
      getCandidateId: async () => (authenticated ? "test-candidate" : null),
      pdfParse: async () => ({
        text: "A fictional candidate résumé with enough content to exercise the parser boundary.",
      }),
      candidatesTable,
      candidateCareerProfilesTable: profilesTable,
      eq: (column: unknown, value: unknown) => ({ column, value }),
      db: {
        select: () => ({
          from: (table: unknown) => ({
            where: (condition: { value: unknown }) => {
              assert.equal(condition.value, "test-candidate");
              return {
                limit: async () =>
                  table === candidatesTable
                    ? [{ resumeUrl: "private/test-resume" }]
                    : [{ id: "test-profile" }],
              };
            },
          }),
        }),
        update: (table: unknown) => {
          assert.equal(table, profilesTable);
          return {
            set: (data: Record<string, unknown>) => ({
              where: async () => {
                writes.push(data);
              },
            }),
          };
        },
        insert: () => {
          throw new Error("existing profile must not be duplicated");
        },
      },
      objectStorageService: {
        getObjectEntityFile: async () => ({ contentType: "application/pdf" }),
        downloadObject: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
      },
      Buffer,
      openai: {
        chat: {
          completions: {
            create: async (config: { model: string }) => {
              assert.equal(config.model, "gpt-4o");
              modelCalls.push(config);
              return { choices: [{ message: { content: raw } }] };
            },
          },
        },
      },
      parseCareerResumeProfile,
      fillCandidateSocialUrlsIfEmpty: async (...args: unknown[]) => {
        socials.push(args);
      },
      logger: { info() {}, error() {} },
    },
  );
  await handler({ file: { mimetype: "application/pdf", buffer: Buffer.alloc(0) } }, res);
  return { status, body, writes, socials, modelCalls };
}

for (const path of [
  "/portal/career-profile/resume/parse",
  "/portal/career-profile/resume/parse-existing",
]) {
  test(`${path}: invalid AI output retains the saved profile and reports parse failure`, async () => {
    for (const raw of ["null", "{}", "[]", '{"core_skills":"wrong"}', null]) {
      const result = await runResumeCase(path, raw);
      assert.equal(result.status, 200, "existing recoverable-error contract is unchanged");
      assert.equal(result.body.ok, false);
      assert.equal(result.body.parseError, true);
      assert.equal(result.writes.length, 0);
      assert.equal(result.socials.length, 0);
    }
  });

  test(`${path}: valid output is persisted and unauthenticated calls do nothing`, async () => {
    const result = await runResumeCase(
      path,
      '{"core_skills":["TypeScript"],"total_years_experience":0}',
    );
    assert.equal(result.body.ok, true);
    assert.equal(result.writes.length, 1);
    const signals = result.writes[0]?.resumeSignals as {
      skills: string[];
      yearsExperience: number;
    };
    assert.deepEqual(signals.skills, ["TypeScript"]);
    assert.equal(signals.yearsExperience, 0);
    assert.equal(result.socials.length, 1);
    const unauth = await runResumeCase(path, "{}", false);
    assert.equal(unauth.status, 401);
    assert.equal(unauth.modelCalls.length, 0);
    assert.equal(unauth.writes.length, 0);
  });
}

const learningAst = sourceAst("./learning-growth.ts");
const accessDeclaration = learningAst.statements.find(
  (n) => ts.isFunctionDeclaration(n) && n.name?.text === "assessmentAccess",
);
assert.ok(accessDeclaration);
async function assessmentCase(
  options: {
    owner?: boolean;
    enabled?: boolean;
    locked?: boolean;
    courseId?: string;
    completed?: boolean;
  } = {},
) {
  let status = 200;
  let stateReads = 0;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json() {
      return res;
    },
  };
  const { assessmentAccess } = load<{
    assessmentAccess: (req: unknown, res: unknown, courseId?: string) => Promise<unknown>;
  }>(`export ${accessDeclaration!.getText(learningAst)}`, {
    ownerSession: async () =>
      options.owner === false ? null : { candidateId: "owner", tenantId: "tenant" },
    pilotEnabled: () => options.enabled !== false,
    db: {},
    loadState: async () => {
      stateReads++;
      return {};
    },
    coursePrerequisite: () => (options.locked ? "Complete the existing prerequisite" : null),
    loadEnrollments: async () => [
      { courseId: "course", status: options.completed === false ? "in_progress" : "completed" },
    ],
  });
  return { access: await assessmentAccess({}, res, options.courseId), status, stateReads };
}

test("learning access remains owner-only and unavailable lists have a safe empty course array", async () => {
  assert.equal((await assessmentCase({ owner: false })).access, null);
  const disabled = await assessmentCase({ enabled: false });
  assert.equal(disabled.stateReads, 0);
  assert.equal((disabled.access as { available: boolean }).available, false);
  assert.deepEqual(JSON.parse(JSON.stringify(disabled.access)).unlockedCourses, []);
  const direct = await assessmentCase({ enabled: false, courseId: "course" });
  assert.equal(direct.status, 404);
  assert.equal(direct.access, null);
});

test("learning access preserves prerequisites and unlocks only completed courses", async () => {
  const locked = await assessmentCase({ locked: true, courseId: "course" });
  assert.equal(locked.status, 403);
  assert.equal(locked.access, null);
  const incomplete = await assessmentCase({ completed: false, courseId: "course" });
  assert.equal(incomplete.status, 403);
  const completed = await assessmentCase();
  assert.deepEqual(JSON.parse(JSON.stringify(completed.access)).unlockedCourses, ["course"]);
});
