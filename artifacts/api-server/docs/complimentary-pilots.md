# Complimentary Enterprise pilot codes

Apply `lib/db/drizzle/0073_complimentary_enterprise_pilots.sql` to the target
database before using the feature. Development schema application does not
migrate an external production database; verify the target and RLS explicitly.
Never use Drizzle push to apply this migration.

Platform admins manage codes on **Platform → Subscriptions**. Account admins
redeem on **Subscription**; platform admins can also select a main account.
Codes have a total redemption limit. Repeated redemption by the same active
account is idempotent and does not consume another slot.

An active account grant covers its client descendants. Enterprise commercial
limits are unlimited, Lexy prices are zero, billing-expiry enforcement and new
placement/seat fees are suppressed. Usage and hire records are retained.
Provider costs remain real. Existing historical invoices are not refunded or
deleted. Existing recurring payment subscriptions must be ended with the
account team before redemption; this feature never cancels or charges a card.

Disabling a code stops future redemptions only. **End pilot** restores the
previous plans and original activation dates. New client accounts restore to
the original main-account plan. Existing billing dates remain unchanged; normal
expiry/fees resume when the pilot ends. This consequence requires confirmation.

Authentication, manual account suspension, job approval, consent, ownership,
privacy controls, integration setup and safety checks are not bypassed.

Verification: `PILOT_DB_TESTS=1 pnpm --filter @workspace/api-server exec tsx
--test src/lib/pilot-codes.test.ts`. This creates/removes isolated fixtures.
