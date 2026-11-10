# Interview handoff regression test

Run from the workspace root:

```sh
pnpm --filter @workspace/api-server run test:interview-handoff
```

Node 24's experimental module-mocking flag is provided by the script.
No new packages, credentials, or runtime configuration are required.

## Isolation

- One private PostgreSQL connection owns empty temporary copies of the relevant
  tables, including their constraints and the queue's partial unique index.
- Its search path is **only** `pg_temp`. Queries explicitly targeting `public`
  after setup are rejected. The normal API worker cannot see fixture jobs.
- Destroying that connection drops all fixture tables. Setup failures also
  release the connection. No historical pilot rows are reset or regraded.
- AI, email, verification, connection-engine, and ancillary audit boundaries
  are mocked. Unexpected outbound fetch/HTTP calls fail the test.

## What is real

The interview end handler, canonical stage-change service, PostgreSQL queue
enqueue/claim/completion/retry SQL, worker loop, job handlers, saved evaluation,
and summary validation are production code.

The tests cover new evidence versus retries, a completed legacy match task,
concurrent database dedupe, missing parent/child enqueues, provider failure,
retry exhaustion and recovery, recruiter notifications, and preservation of
advanced/terminal stages.

## Boundaries

Cookie authentication, consent, and same-origin proof are supplied by authorized
fixtures. This is **not** an authentication, RLS, microphone, browser UI, or live
provider test. Intelligence and match providers return controlled fixture data;
their actual scoring algorithms and stabilized models/prompts are not changed.
