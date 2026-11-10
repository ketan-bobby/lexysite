import React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { GraphMailEvidence } from "./GraphMailEvidence";
test("accepted, uncertain, rejected and legacy evidence never claim recipient delivery", () => {
  for (const acceptance of ["accepted", "unknown", "rejected", "not_attempted", undefined]) {
    const markup = renderToStaticMarkup(
      <GraphMailEvidence
        metadata={{
          transport: "graph",
          acceptance,
          clientRequestId: "synthetic-request",
          providerRequestId: "provider-request",
          fallbackPrevented: acceptance === "unknown",
        }}
      />,
    );
    assert.match(markup, /Recipient delivery and reading are unverified/);
    assert.match(markup, /not email message IDs/);
    if (acceptance === "unknown") assert.match(markup, /No automatic SES fallback was attempted/);
    if (acceptance === "accepted") assert.match(markup, /accepted the request for processing/);
  }
});
test("the evidence control ignores other transports and raw metadata", () => {
  assert.equal(renderToStaticMarkup(<GraphMailEvidence metadata={{ transport: "ses" }} />), "");
  const markup = renderToStaticMarkup(
    <GraphMailEvidence
      metadata={{
        transport: "graph",
        acceptance: "accepted",
        providerRequestId: "<script>private</script>",
        clientRequestId: "x".repeat(129),
        body: "private-body",
        token: "private-token",
      }}
    />,
  );
  assert.ok(!markup.includes("private"));
  assert.ok(!markup.includes("x".repeat(129)));
});
