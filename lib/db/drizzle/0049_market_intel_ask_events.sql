-- Migration 0049: Market Intelligence Ask audit log
-- One row per /market-intelligence/ask call: question, final answer, confidence
-- line, and the full set of ACTUALLY EXECUTED tool calls — the grounding audit
-- trail for spot-checking that answers stay tool-sourced during rollout.

CREATE TABLE IF NOT EXISTS market_intel_ask_events (
  id            TEXT PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id       TEXT NOT NULL,
  tenant_id     TEXT,
  question      TEXT NOT NULL,
  answer        TEXT NOT NULL,
  confidence    TEXT NOT NULL,
  sources       JSONB NOT NULL,
  coverage      JSONB NOT NULL,
  insufficient  BOOLEAN NOT NULL,
  latency_ms    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS market_intel_ask_events_created_at_idx
  ON market_intel_ask_events (created_at);
