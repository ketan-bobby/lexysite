# Staff-provided Zoom links — verification

Date: 2026-10-25. Scope is manual, explicitly reviewed participant links, not
Zoom API creation or OAuth verification.

- **107/107** real HTTP/PostgreSQL candidate scheduling regression cases
  passed, including five new Zoom scenarios. The fixture uses a verified
  development fingerprint and private owned schemas, not real customer rows.
- **3/3** backend unit tests passed for participant URL safety, expiring
  approval bindings and feedback-independent publication evidence.
- **15/15** actual-component browser scenarios passed against intercepted HTTP
  using generated API clients.
- **3/3** frontend helper tests and frontend TypeScript check passed.
- Backend TypeScript passed; normal managed API startup performs its final
  typecheck and full static build-guard chain.
- Scoped formatting and whitespace checks passed; lint reported no errors and
  three warnings (existing/import and hook/test-helper cleanup warnings).
- Development migration privacy proof returned true for RLS, forced RLS, no
  policies, request-role denial and the enabled candidate-erasure barrier.

The SQL scenarios cover canonical candidate-only retrieval, foreign/staff role
rejection, stable reload, competing approvals, changed URL and approval token,
explicit true confirmation, native version conflicts, removal tombstones,
cancelled appointments, public-time versus private-feedback changes, calendar
invitation conflict suppression and late erasure writes.

The browser pass covers real staff/candidate components, not the entire signed-in
coordinator route. It does not verify live Zoom host/time/attendees, production
schema/privacy, every error status, expiry timer, repeated polling behavior or
all mobile layouts. Full assisted-baseline and live Zoom acceptance were not run.

No external Zoom mutation or candidate email is performed by this feature.
Existing API startup jobs can issue their previously configured administrative
Stripe sentinel alert; this feature does not enable billing.
