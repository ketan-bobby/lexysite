/**
 * market-intelligence-ask.test.ts — Step 2 reasoning-layer hard tests.
 *
 * The two NON-NEGOTIABLE hard tests from the spec:
 *  1. When NO tool has relevant data, the response must say data is
 *     insufficient and must NOT produce a confident specific answer —
 *     even if the model tries to fabricate one.
 *  2. With seeded internal-bench data, internal candidates must be surfaced
 *     FIRST/prominently, never buried under external suggestions.
 *
 * The LLM is faked (ChatFn seam) so assertions are deterministic; the tool
 * executor is faked so no DB is needed. The guarantees under test are the
 * SERVER-SIDE ones (narrative override, source ordering, coverage line,
 * arg sanitization) — exactly the parts that must hold even when the model
 * misbehaves.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type OpenAI from "openai";
import {
  askMarketIntelligence,
  sanitizeToolArgs,
  buildConfidenceLine,
  orderSources,
  benchHeadline,
  MARKET_TOOL_DEFS,
  ASK_SYSTEM_PROMPT,
  scrubGuidanceSpecifics,
  type ChatFn,
  type MarketToolExecutor,
  type AskSource,
} from "./market-intelligence-ask";
import { noData } from "./market-intelligence";

/* ── Helpers ──────────────────────────────────────────────────────────────── */

type Msg = OpenAI.Chat.Completions.ChatCompletionMessage;

function toolCallMsg(calls: Array<{ name: string; args: object }>): Msg {
  return {
    role: "assistant",
    content: null,
    refusal: null,
    tool_calls: calls.map((c, i) => ({
      id: `call_${i}_${c.name}`,
      type: "function" as const,
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    })),
  } as Msg;
}

function textMsg(content: string): Msg {
  return { role: "assistant", content, refusal: null } as Msg;
}

/** Fake LLM that emits a scripted sequence of messages. */
function scriptedChat(script: Msg[]): { chat: ChatFn; calls: number[] } {
  let i = 0;
  const calls: number[] = [];
  const chat: ChatFn = async messages => {
    calls.push(messages.length);
    const msg = script[Math.min(i, script.length - 1)];
    i++;
    return msg;
  };
  return { chat, calls };
}

const BENCH_OK = {
  status: "ok" as const,
  asOf: "2026-07-08T00:00:00.000Z",
  matchCount: 7,
  currentEmployeeCount: 2,
  topMatches: [
    { candidateId: "c1", name: "Ada Okafor", title: "Design Engineer", matchScore: 92, isCurrentEmployee: true },
    { candidateId: "c2", name: "Ben Ruiz", title: "Mechanical Design Engineer", matchScore: 85, isCurrentEmployee: false },
  ],
  note: "internal talent pool only",
};

const SUPPLY_OK = {
  status: "ok" as const,
  asOf: "2026-07-08T00:00:01.000Z",
  searchesInWindow: 4,
  totalCandidatesFound: 61,
  avgFoundPerSearch: 15.3,
  trend: "up" as const,
  windowDays: 30,
  basedOn: "based on 4 sourcing search(es) in the last 30 days",
};

const VELOCITY_OK = {
  status: "ok" as const,
  asOf: "2026-07-08T00:00:02.000Z",
  medianDaysToFill: 31,
  p25DaysToFill: 24,
  p75DaysToFill: 45,
  sourcedToHireRatio: 0.12,
  sampleSize: 6,
  sourcedSampleSize: 25,
  scope: "tenant" as const,
};

/* ── HARD TEST 1: no tool has data → explicit insufficiency, no fabrication ─ */

describe("hard test: obscure query with zero data", () => {
  test("says insufficient and discards a fabricating model narrative", async () => {
    const executed: string[] = [];
    const executor: MarketToolExecutor = async tool => {
      executed.push(tool);
      return noData(`no data for tool ${tool}`, "2026-07-08T00:00:00.000Z");
    };
    // Model calls all four tools, then tries to FABRICATE a confident answer.
    const { chat } = scriptedChat([
      toolCallMsg([
        { name: "get_internal_bench", args: { role: "underwater basket weaving lead", skills: ["reeds"] } },
        { name: "get_candidate_supply", args: { role: "underwater basket weaving lead" } },
        { name: "get_hiring_velocity", args: { role: "underwater basket weaving lead", location: "Tristan da Cunha" } },
        { name: "get_comp_signal", args: { role: "underwater basket weaving lead" } },
      ]),
      textMsg("You should hire in Lisbon — there are 4,200 available candidates and salaries average $95k."),
    ]);

    const result = await askMarketIntelligence({
      question: "Where should I hire an underwater basket weaving lead in Tristan da Cunha?",
      tenantScope: ["t1"],
      chat,
      executor,
    });

    assert.equal(executed.length, 4);
    assert.equal(result.coverage.sufficient, false);
    assert.equal(result.coverage.okCount, 0);
    assert.equal(result.coverage.noDataCount, 4);
    // The fabricated narrative must NOT appear anywhere.
    assert.ok(!result.answer.includes("Lisbon"));
    assert.ok(!result.answer.includes("4,200"));
    assert.ok(!result.answer.includes("$95k"));
    // Explicit insufficiency + what would help.
    assert.match(result.answer, /don't have enough data/i);
    assert.match(result.answer, /won't guess/i);
    assert.match(result.answer, /What would help/i);
    // Mandatory confidence line says none.
    assert.match(result.confidence, /^Confidence: none/);
    // Every citation is an honest no_data with its reason.
    assert.equal(result.sources.length, 4);
    for (const s of result.sources) {
      assert.equal(s.status, "no_data");
      assert.match(s.summary, /^no data — /);
      assert.equal(s.sampleSize, undefined);
    }
  });

  test("model answering with NO tool calls at all also yields insufficiency, not the bare narrative", async () => {
    const { chat } = scriptedChat([
      textMsg("Design engineers are plentiful in Austin, expect $130k median."),
    ]);
    const result = await askMarketIntelligence({
      question: "Where do I find design engineers?",
      tenantScope: ["t1"],
      chat,
      executor: async () => { throw new Error("should not be called"); },
    });
    assert.equal(result.coverage.toolsCalled, 0);
    assert.equal(result.coverage.sufficient, false);
    assert.ok(!result.answer.includes("Austin"));
    assert.ok(!result.answer.includes("$130k"));
    assert.match(result.answer, /don't have enough data/i);
    assert.match(result.confidence, /^Confidence: none/);
  });

  test("cold-start boundary: zero data → honest refusal + SEPARATE scrubbed generic guidance, never a fabricated specific", async () => {
    const { chat } = scriptedChat([
      toolCallMsg([
        { name: "get_internal_bench", args: { role: "mechanical engineer" } },
        { name: "get_candidate_supply", args: { role: "mechanical engineer" } },
      ]),
      textMsg("Trust me, hire in Austin at $142,000 average."),
    ]);
    // The guidance pass tries to smuggle a specific salary into "general knowledge".
    const guidanceChat: ChatFn = async () =>
      textMsg(
        "- Mechanical engineering talent is commonly concentrated in manufacturing and aerospace hubs.\n" +
          "- The average salary for mechanical engineers in Austin is $142,000. Remote sourcing has grown for this role type.\n" +
          "- University partnerships and professional engineering associations are typical early sourcing channels.",
      );
    const result = await askMarketIntelligence({
      question: "Where should I look for 5 mechanical engineers within 30 days?",
      tenantScope: ["t1"],
      chat,
      guidanceChat,
      executor: async () => noData("empty", "2026-07-08T00:00:00.000Z"),
    });
    // (a) grounded channel stays the deterministic honest refusal
    assert.equal(result.coverage.sufficient, false);
    assert.match(result.answer, /won't guess/i);
    assert.ok(!result.answer.includes("Austin"));
    // (b) guidance channel exists, is generic, and the smuggled specific is GONE
    assert.ok(result.generalGuidance);
    assert.ok(result.generalGuidance!.includes("manufacturing and aerospace hubs"));
    assert.ok(result.generalGuidance!.includes("Remote sourcing has grown"));
    assert.ok(!result.generalGuidance!.includes("142"));
    assert.ok(!result.generalGuidance!.includes("$"));
    // (c) guidance never leaks into the grounded answer or the citations
    assert.ok(!result.answer.includes("aerospace"));
    for (const s of result.sources) assert.equal(s.status, "no_data");
  });

  test("no guidance channel when platform data is healthy (2+ categories ok)", async () => {
    const { chat } = scriptedChat([
      toolCallMsg([
        { name: "get_internal_bench", args: { role: "design engineer" } },
        { name: "get_candidate_supply", args: { role: "design engineer" } },
      ]),
      textMsg("Grounded answer from data."),
    ]);
    let guidanceCalled = 0;
    const guidanceChat: ChatFn = async () => { guidanceCalled++; return textMsg("generic stuff"); };
    const result = await askMarketIntelligence({
      question: "hire design engineers",
      tenantScope: ["t1"],
      chat,
      guidanceChat,
      executor: async tool => (tool === "get_internal_bench" ? (BENCH_OK as any) : (SUPPLY_OK as any)),
    });
    assert.equal(result.coverage.okCount, 2);
    assert.equal(guidanceCalled, 0);
    assert.equal(result.generalGuidance, undefined);
  });

  test("guidance pass failure is non-blocking — grounded refusal still returned", async () => {
    const { chat } = scriptedChat([textMsg("fabricated")]);
    const result = await askMarketIntelligence({
      question: "where to hire welders",
      tenantScope: ["t1"],
      chat,
      guidanceChat: async () => { throw new Error("guidance model down"); },
      executor: async () => noData("empty", "2026-07-08T00:00:00.000Z"),
    });
    assert.match(result.answer, /don't have enough data/i);
    assert.equal(result.generalGuidance, undefined);
  });
});

/* ── Guidance scrubber unit tests ─────────────────────────────────────────── */

describe("scrubGuidanceSpecifics", () => {
  test("drops currency amounts, percentages, k-shorthand and big numbers; keeps generic sentences", () => {
    const out = scrubGuidanceSpecifics(
      "Talent is commonly concentrated in major tech hubs, and remote sourcing has grown for this role type.\n" +
        "Expect to pay $142,000 in Austin. Salaries rose 12% last year and top out around 180k.\n" +
        "Professional associations and university programs are reliable early channels for this discipline.",
    );
    assert.ok(out);
    assert.ok(out!.includes("major tech hubs"));
    assert.ok(out!.includes("Professional associations"));
    assert.ok(!/[$%]|142|180k|12%/.test(out!));
  });

  test("returns null when nothing generic survives", () => {
    assert.equal(scrubGuidanceSpecifics("Pay $150,000. Expect 20% growth. Budget 300 hires."), null);
    assert.equal(scrubGuidanceSpecifics(""), null);
    assert.equal(scrubGuidanceSpecifics("   "), null);
  });

  test("spelled-out quantity claims are dropped too (no wordy bypass)", () => {
    const out = scrubGuidanceSpecifics(
      "Salaries often run around a hundred and forty thousand dollars in major hubs. Referral bonuses can lift response rates by ten percent.\n" +
        "Engineering associations and targeted job boards remain reliable channels for this discipline and its specialties.",
    );
    assert.ok(out);
    assert.ok(!/thousand|dollars|percent/i.test(out!));
    assert.ok(out!.includes("Engineering associations"));
  });

  test("small in-sentence numbers (like '5 engineers in 30 days' echoes) are allowed, huge ones are not", () => {
    const out = scrubGuidanceSpecifics(
      "For a team of 5 engineers, staggering start dates over 30 days is a common approach that eases onboarding load.\n" +
        "Plan on roughly 25000 applicants in the first week.",
    );
    assert.ok(out);
    assert.ok(out!.includes("staggering start dates"));
    assert.ok(!out!.includes("25000"));
  });
});

/* ── HARD TEST 2: internal bench surfaced first, not buried ───────────────── */

describe("hard test: 'hire 5 design engineers' with seeded internal bench", () => {
  test("internal candidates lead the answer and the citations", async () => {
    const order: string[] = [];
    const executor: MarketToolExecutor = async (tool, args) => {
      order.push(tool);
      assert.equal(args.role, "design engineer");
      switch (tool) {
        case "get_internal_bench": return BENCH_OK as any;
        case "get_candidate_supply": return SUPPLY_OK as any;
        case "get_hiring_velocity": return VELOCITY_OK as any;
        case "get_comp_signal": return noData("below k-anonymity threshold");
      }
    };
    // Model follows doctrine: bench first, then external tools, then narrative.
    const { chat } = scriptedChat([
      toolCallMsg([{ name: "get_internal_bench", args: { role: "design engineer", skills: ["cad", "dfm"] } }]),
      toolCallMsg([
        { name: "get_candidate_supply", args: { role: "design engineer" } },
        { name: "get_hiring_velocity", args: { role: "design engineer" } },
        { name: "get_comp_signal", args: { role: "design engineer" } },
      ]),
      textMsg("Recommendation: engage your internal bench first (7 matches, per get_internal_bench as of 2026-07-08), then run external sourcing — supply is trending up (61 found across 4 searches). Median fill time is 31 days (n=6). Confidence: comp data was insufficient."),
    ]);

    const result = await askMarketIntelligence({
      question: "I have to hire 5 design engineers, where should I find them",
      tenantScope: ["t1"],
      chat,
      executor,
    });

    // Bench was actually consulted first (doctrine order recorded from real executions).
    assert.equal(order[0], "get_internal_bench");
    // Prominence: the answer STARTS with the deterministic internal-first headline.
    assert.match(result.answer, /^Start internal: 7 matching candidate\(s\)/);
    assert.ok(result.answer.includes("Ada Okafor"));
    assert.ok(result.answer.indexOf("Start internal") < result.answer.indexOf("external"));
    // Citations: internal bench is the FIRST source.
    assert.equal(result.sources[0].tool, "get_internal_bench");
    assert.equal(result.sources[0].status, "ok");
    assert.equal(result.sources[0].sampleSize, 7);
    assert.equal(result.sources[0].asOf, BENCH_OK.asOf);
    // Coverage honest about the comp gap.
    assert.equal(result.coverage.okCount, 3);
    assert.equal(result.coverage.noDataCount, 1);
    assert.match(result.confidence, /partial coverage/);
    assert.match(result.confidence, /missing: compensation signal/);
    // Structured bench cards come from the REAL tool result (never model text).
    assert.equal(result.benchMatches?.length, BENCH_OK.topMatches.length);
    assert.equal(result.benchMatches![0].candidateId, BENCH_OK.topMatches[0].candidateId);
    assert.equal(result.benchMatches![0].name, BENCH_OK.topMatches[0].name);
  });

  test("benchMatches is absent when internal bench returned no data", async () => {
    const { chat } = scriptedChat([
      toolCallMsg([
        { name: "get_internal_bench", args: { role: "designer" } },
        { name: "get_candidate_supply", args: { role: "designer" } },
      ]),
      textMsg("Supply looks fine."),
    ]);
    const result = await askMarketIntelligence({
      question: "q about designers",
      tenantScope: ["t1"],
      chat,
      executor: async tool => (tool === "get_candidate_supply" ? (SUPPLY_OK as any) : noData("empty pool")),
    });
    assert.equal(result.benchMatches, undefined);
  });
});

/* ── Guardrails ───────────────────────────────────────────────────────────── */

describe("server-side guardrails", () => {
  test("model-supplied tenant ids / extra fields are stripped; role required", () => {
    const ok = sanitizeToolArgs({ role: "designer", tenantIds: ["evil"], tenantScope: ["evil"], skills: ["figma", 42], location: " NYC " });
    assert.deepEqual(ok, { role: "designer", skills: ["figma"], location: "NYC" });
    assert.ok(!("tenantIds" in (ok as any)));
    assert.equal(sanitizeToolArgs({ role: "" }), null);
    assert.equal(sanitizeToolArgs({ skills: ["x"] }), null);
    assert.equal(sanitizeToolArgs("nope"), null);
  });

  test("unknown tool names are rejected without execution", async () => {
    let executed = 0;
    const { chat } = scriptedChat([
      toolCallMsg([{ name: "drop_all_tables", args: { role: "designer" } }]),
      textMsg("done"),
    ]);
    const result = await askMarketIntelligence({
      question: "q",
      tenantScope: ["t1"],
      chat,
      executor: async () => { executed++; return noData("x"); },
    });
    assert.equal(executed, 0);
    assert.equal(result.coverage.toolsCalled, 0);
    assert.equal(result.coverage.sufficient, false);
  });

  test("confidence line flags thin samples", () => {
    const thin: AskSource[] = [{
      tool: "get_hiring_velocity", params: { role: "x" }, asOf: "2026-07-08T00:00:00.000Z",
      status: "ok", sampleSize: 3, summary: "median 20 days to fill (n=3, tenant scope)",
    }];
    assert.match(buildConfidenceLine(thin), /thin/);
  });

  test("bench-only ok answer is PARTIAL coverage and lists unconsulted categories", () => {
    const benchOnly: AskSource[] = [{
      tool: "get_internal_bench", params: { role: "x" }, asOf: "2026-07-08T00:00:00.000Z",
      status: "ok", sampleSize: 17, summary: "17 matching candidate(s) already in your talent pool",
    }];
    const line = buildConfidenceLine(benchOnly);
    assert.match(line, /partial coverage/);
    assert.doesNotMatch(line, /full coverage/);
    assert.match(line, /not consulted:.*candidate supply/);
    assert.match(line, /hiring velocity/);
    assert.match(line, /compensation signal/);
  });

  test("full coverage only when ALL four categories consulted and ok", () => {
    const all: AskSource[] = (["get_internal_bench", "get_candidate_supply", "get_hiring_velocity", "get_comp_signal"] as const)
      .map(tool => ({ tool, params: { role: "x" }, asOf: "t", status: "ok" as const, sampleSize: 9, summary: "s" }));
    const line = buildConfidenceLine(all);
    assert.match(line, /full coverage/);
    assert.doesNotMatch(line, /not consulted/);
  });

  test("orderSources puts internal bench first regardless of call order", () => {
    const s = (tool: any): AskSource => ({ tool, params: { role: "x" }, asOf: "t", status: "ok", sampleSize: 5, summary: "s" });
    const ordered = orderSources([s("get_comp_signal"), s("get_hiring_velocity"), s("get_internal_bench")]);
    assert.equal(ordered[0].tool, "get_internal_bench");
  });

  test("benchHeadline only fires on real data", () => {
    assert.equal(benchHeadline(undefined), null);
    assert.equal(benchHeadline(noData("nope") as any), null);
    assert.match(benchHeadline(BENCH_OK as any)!, /^Start internal: 7/);
  });

  test("executions audit trail records rejected and failed attempts, not just successes", async () => {
    const { chat } = scriptedChat([
      toolCallMsg([
        { name: "drop_all_tables", args: { role: "designer" } },        // unknown tool
        { name: "get_internal_bench", args: { skills: ["x"] } },        // invalid args (no role)
        { name: "get_internal_bench", args: { role: "designer" } },     // executes, throws
        { name: "get_candidate_supply", args: { role: "designer" } },   // executes ok (no_data)
      ]),
      textMsg("done"),
    ]);
    const result = await askMarketIntelligence({
      question: "q",
      tenantScope: ["t1"],
      chat,
      executor: async tool => {
        if (tool === "get_internal_bench") throw new Error("boom");
        return noData("nothing");
      },
    });
    const outcomes = result.executions.map(e => `${e.tool}:${e.outcome}`);
    assert.deepEqual(outcomes, [
      "drop_all_tables:rejected_unknown_tool",
      "get_internal_bench:rejected_invalid_args",
      "get_internal_bench:execution_failed",
      "get_candidate_supply:no_data",
    ]);
  });

  test("system prompt carries the hard constraints verbatim themes", () => {
    assert.match(ASK_SYSTEM_PROMPT, /only state facts returned by tool calls/i);
    assert.match(ASK_SYSTEM_PROMPT, /never state a specific number/i);
    assert.match(ASK_SYSTEM_PROMPT, /call get_internal_bench FIRST/);
    assert.match(ASK_SYSTEM_PROMPT, /cite which tool/i);
    assert.match(ASK_SYSTEM_PROMPT, /confidence/i);
    assert.equal(MARKET_TOOL_DEFS.length, 4);
  });
});
