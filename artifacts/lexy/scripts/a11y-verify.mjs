// Temporary a11y verification harness — renders real patterns from Batch 1
// into jsdom and computes the ACTUAL accessible name per the accname spec.
import { JSDOM } from "jsdom";
import { computeAccessibleName } from "dom-accessibility-api";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";

const dom = new JSDOM(`<!DOCTYPE html><div id="root"></div>`, { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
global.IS_REACT_ACT_ENVIRONMENT = true;

const { Slot } = await import("@radix-ui/react-slot");
const h = React.createElement;

// Radix Button asChild ≈ Slot (what shadcn Button renders when asChild)
const cases = [
  ["Group A: modal close button", () =>
    h("button", { onClick() {}, "aria-label": "Close" }, h("svg", null))],
  ["Group B: remove question button", () =>
    h("button", { "aria-label": "Remove question 2" }, h("svg", null))],
  ["Group E: Button asChild → <a aria-label>", () =>
    h(Slot, { className: "h-7" }, h("a", { href: "#", "aria-label": "View LinkedIn profile" }, h("svg", null)))],
  ["Group E: <a aria-label> wrapping aria-hidden Button", () =>
    h("a", { href: "#", "aria-label": "View GitHub profile" },
      h("button", { "aria-hidden": "true", tabIndex: -1 }, h("svg", null)))],
];

for (const [label, make] of cases) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(make()));
  const el = host.querySelector("a,button");
  const name = computeAccessibleName(el);
  console.log(`${name ? "PASS" : "FAIL"} | ${label} → accessible name: "${name}" (element: <${el.tagName.toLowerCase()}>)`);
}
