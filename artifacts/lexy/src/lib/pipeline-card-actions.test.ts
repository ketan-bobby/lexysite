import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../components/agents/PipelinePanel.tsx", import.meta.url),
  "utf8",
);

test("sourced cards expose the existing stage menu from the footer", () => {
  assert.match(source, /const \[actionsOpen, setActionsOpen\] = useState\(false\)/);
  assert.match(source, /<DropdownMenu open=\{actionsOpen\} onOpenChange=\{setActionsOpen\}>/);
  const sourcedAction = source.slice(
    source.indexOf('if (s === "sourced" && row.sourcedId)'),
    source.indexOf("/* Gated card:"),
  );
  assert.match(sourcedAction, /label="Move to stage"/);
  assert.match(sourcedAction, /onClick=\{\(\) => setActionsOpen\(true\)\}/);
  assert.match(sourcedAction, /disabled=\{moveWithoutAutomationMutation.isPending\}/);
  assert.match(sourcedAction, /no emails or agents are triggered/);
  assert.doesNotMatch(sourcedAction, /\.mutate\(/);
});

test("manual destination selection retains explicit no-automation behavior", () => {
  assert.match(source, /No emails or agents triggered/);
  assert.match(source, /onSelect=\{\(\) => moveWithoutAutomationMutation.mutate\(st.key\)\}/);
  assert.match(source, /stage: targetStage,\s+skipAutomation: true/);
  assert.match(source, /JSON.stringify\(\{ stage: targetStage, skipAutomation: true \}\)/);
  assert.match(source, /invalidateQueries\(\{ queryKey: \["pipeline-stages", jobId\] \}\)/);
});

test("footer can wrap without losing the stage action on narrow cards", () => {
  assert.match(
    source,
    /className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-border\/40"/,
  );
});
