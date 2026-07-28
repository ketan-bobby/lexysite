# Lexy Subprocessors

**Last updated:** 16 May 2026
**Owner:** legal@l3xy.ai

This page is the canonical source of Lexy's third-party subprocessors. The
public-facing page at `/subprocessors` and the DPA Annex II (subprocessor
list) are both generated from this document — keep them in sync or
regenerate.

A "subprocessor" is any third party that Lexy uses to process Customer
Personal Data on Lexy's behalf, as defined in the Lexy Data Processing
Addendum (DPA).

## Current subprocessors

| Vendor | Purpose | Data categories | Region |
|---|---|---|---|
| **OpenAI, LLC** | LLM inference for resume parsing, interview generation, and candidate scoring (no training on Customer Data — zero-retention API contract) | Candidate name, resume text, interview transcripts | United States |
| **Anthropic PBC** | LLM inference for long-context interview review and bias-audit reasoning (no training on Customer Data) | Candidate name, resume text, interview transcripts | United States |
| **Neon (Databricks Inc.)** | Primary Postgres database hosting (encrypted at rest, AES-256; encrypted in transit, TLS 1.3) | All Customer Personal Data | United States (us-east-2) |
| **Replit, Inc.** | Application hosting, build, and deployment platform | All Customer Personal Data | United States |
| **Cloudflare, Inc.** | CDN, DNS, and DDoS protection | IP addresses, request metadata | Global edge |
| **Resend, Inc.** | Transactional email delivery (invites, password resets, recruiter digests) | Recipient email, subject, body | United States |
| **Stripe, Inc.** | Payment processing for the optional self-serve checkout path | Billing contact, payment method (tokenised — Stripe stores PAN) | United States |
| **Sentry (Functional Software Inc.)** | Application error monitoring (scrubbing rules strip PII before ingestion) | Stack traces, sanitised request metadata | United States |

## Sub-subprocessors (informational)

Each of the vendors above maintains their own subprocessor lists, which
Lexy is bound by under our DPAs with them. Customers may consult those
lists directly.

## Adding or changing a subprocessor

1. New subprocessor is proposed by Engineering, reviewed for DPA, security
   posture, and data-residency fit by legal@l3xy.ai.
2. If approved, this document is updated and a 30-day advance notice email
   is sent to all active Customers (per DPA §6.3).
3. If a Customer objects in writing within the notice window, Lexy and the
   Customer will work in good faith to find an alternative; if none can be
   found, the Customer has a contractual right to terminate the affected
   service line.

## Notification subscription

Customers may subscribe to subprocessor change notifications by emailing
legal@l3xy.ai with subject line `SUBSCRIBE: subprocessor-updates`.
