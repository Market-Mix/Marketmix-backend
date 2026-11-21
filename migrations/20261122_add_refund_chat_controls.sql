-- Refund chat pause controls for each party.
-- Run against the same PostgreSQL/Supabase public schema as refund_cases.
-- This migration is proposed only and must not be executed as part of this change.

ALTER TABLE public.refund_cases
  ADD COLUMN IF NOT EXISTS buyer_chat_paused boolean NOT NULL DEFAULT false;

ALTER TABLE public.refund_cases
  ADD COLUMN IF NOT EXISTS seller_chat_paused boolean NOT NULL DEFAULT false;
