import { test } from "node:test";
import assert from "node:assert/strict";
import { candidateProfile } from "./profile";

const p = {
  id: 21,
  private: false,
  can_email: true,
  first_name: " Ada ",
  last_name: "Lovelace",
  email_addresses: [{ value: "ADA@example.invalid" }, { value: "ada@example.invalid" }],
  title: "Engineer",
  company: "Computing",
  custom_fields: { protected: "NEVER_IMPORT" },
  phone_numbers: [{ value: "NEVER_IMPORT" }],
  addresses: ["NEVER_IMPORT"],
};
test("candidate profiles persist only selected fields, normalize aliases and ignore provider extras", () => {
  assert.deepEqual(candidateProfile([p], "21", false), {
    firstName: "Ada",
    lastName: "Lovelace",
    emails: ["ada@example.invalid"],
    currentTitle: null,
    currentCompany: null,
    includeProfessional: false,
  });
  const full = candidateProfile([p], "21", true);
  assert.equal(full.currentTitle, "Engineer");
  assert.equal(JSON.stringify(full).includes("NEVER_IMPORT"), false);
});
test("candidate profile fails closed on private/contact-restricted identities, missing or unbounded fields", () => {
  for (const patch of [
    { private: true },
    { private: null },
    { can_email: false },
    { can_email: undefined },
    { id: 22 },
    { email_addresses: [] },
    { first_name: "" },
    { email_addresses: [{ value: "invalid" }] },
    { title: "x".repeat(501) },
  ]) {
    assert.throws(() => candidateProfile([{ ...p, ...patch }], "21", true));
  }
  assert.throws(() => candidateProfile([], "21", true));
  assert.throws(() => candidateProfile([p, p], "21", true));
});
