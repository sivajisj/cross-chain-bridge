-- Phase 1 persistence schema for the cross-chain relayer.
-- Safe to run repeatedly: every statement is idempotent, so this file
-- doubles as the relayer's own migration on every boot.

CREATE TABLE IF NOT EXISTS bridge_messages (
    message_id             TEXT PRIMARY KEY,
    source_chain_id         BIGINT NOT NULL,
    destination_chain_id     BIGINT NOT NULL,
    source_tx_hash          TEXT NOT NULL,
    source_log_index        INTEGER NOT NULL,
    source_block_number      BIGINT NOT NULL,
    sender                  TEXT NOT NULL,
    recipient                TEXT NOT NULL,
    token                   TEXT NOT NULL,
    amount                  NUMERIC(78, 0) NOT NULL,
    nonce                   TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'DETECTED',
    destination_tx_hash      TEXT,
    retry_count              INTEGER NOT NULL DEFAULT 0,
    last_error               TEXT,
    next_retry_at             TIMESTAMPTZ,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- The same on-chain event can never be inserted twice. This is what
    -- makes re-scanning an overlapping block range safe.
    CONSTRAINT uq_source_event UNIQUE (source_chain_id, source_tx_hash, source_log_index)
);

CREATE INDEX IF NOT EXISTS idx_bridge_messages_status ON bridge_messages (status);
CREATE INDEX IF NOT EXISTS idx_bridge_messages_retry ON bridge_messages (status, next_retry_at);

-- Tracks how far each source chain has been scanned, so the relayer can
-- resume from exactly where it left off after a restart instead of
-- guessing a lookback window.
CREATE TABLE IF NOT EXISTS sync_cursor (
    chain_id             BIGINT PRIMARY KEY,
    last_scanned_block    BIGINT NOT NULL,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);