import test from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MonthlySourcingPackages } from "../components/jobs/MonthlySourcingPackages";
import type { SourcingMonthlyPackages } from "@workspace/api-client-react";

// Node's tsx loader preserves the workspace's classic JSX runtime; Vite
// supplies its automatic runtime separately. Keep this shim test-only.
Object.assign(globalThis, { React });

const packages: SourcingMonthlyPackages = {
  country: "IN",
  currentPlan: "growth",
  billingTerm: "monthly",
  displayTerm: "monthly",
  sourcingAllowanceConfigured: false,
  note: "Read-only; no billing or execution change.",
  tiers: [
    {
      code: "starter",
      name: "Starter",
      amount: 5601,
      currency: "INR",
      symbol: "₹",
      taxNote: "Fixture GST",
      priceSource: "catalog",
      maxOpenJobs: 5,
      maxStaffSeats: 3,
      candidateDbSearchesPerMonth: 250,
      aiGenerationsPerMonth: 1000,
    },
    {
      code: "growth",
      name: "Growth",
      amount: 15001,
      currency: "INR",
      symbol: "₹",
      taxNote: "Fixture GST",
      priceSource: "catalog",
      maxOpenJobs: 25,
      maxStaffSeats: 10,
      candidateDbSearchesPerMonth: 2500,
      aiGenerationsPerMonth: 5000,
    },
    {
      code: "enterprise",
      name: "Enterprise",
      amount: -1,
      currency: "INR",
      symbol: "₹",
      taxNote: "Fixture GST",
      priceSource: "catalog",
      maxOpenJobs: -1,
      maxStaffSeats: -1,
      candidateDbSearchesPerMonth: -1,
      aiGenerationsPerMonth: -1,
    },
  ],
};
const render = (p: SourcingMonthlyPackages | null) =>
  renderToStaticMarkup(createElement(MonthlySourcingPackages, { packages: p }));
test("package cards use resolved country prices, mark current plan and do not sell upgrades", () => {
  const html = render(packages);
  assert.match(html, /5,601/);
  assert.match(html, /15,001/);
  assert.match(html, /Current plan/);
  assert.match(html, /Contact sales/);
  assert.match(html, /not yet configured or enforced/);
  assert.match(html, /not\s+external profiles/);
  assert.doesNotMatch(html, /<button|checkout|SerpAPI|EnrichLayer/);
});
test("missing prices stay unavailable rather than assumed free or USD defaults", () => {
  const html = render(null);
  assert.match(html, /No price is assumed/);
  assert.doesNotMatch(html, /\$299|Free/);
});
test("annual contracts and unknown country are explicitly reference-only", () => {
  const html = render({ ...packages, country: null, billingTerm: "annual" });
  assert.match(html, /US catalog reference prices/);
  assert.match(html, /not the actual annual charge/);
  assert.match(
    render({ ...packages, billingTerm: "quarterly" }),
    /not the actual quarterly charge/,
  );
});
