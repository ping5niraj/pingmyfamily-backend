-- ============================================================
-- PingMyFamily — Phase 1 Database Schema
-- Run this in your NEW separate Supabase project
-- All tables prefixed with pmf_ (no collision with Nalamini)
-- ============================================================

-- ─── Users ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pmf_users (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name            text NOT NULL,
  phone           text UNIQUE NOT NULL,
  email           text,
  gender          text CHECK (gender IN ('male', 'female', 'other')),
  date_of_birth   date,
  profile_photo   text,                    -- URL to object storage (Phase 2)
  status          text DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'banned')),
  nalamini_agent_id uuid,                  -- FK to Nalamini users.id — Phase 2 only, NULL for now
  created_at      timestamptz DEFAULT now()
);

-- Index for fast phone lookups (login)
CREATE INDEX IF NOT EXISTS idx_pmf_users_phone ON pmf_users(phone);

-- ─── Relationships (adjacency table) ──────────────────────
-- Day 3-4: uncomment when building relationships route
/*
CREATE TABLE IF NOT EXISTS pmf_relationships (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  from_user_id        uuid REFERENCES pmf_users(id) ON DELETE CASCADE,
  to_user_id          uuid REFERENCES pmf_users(id) ON DELETE CASCADE,
  relation_type       text NOT NULL,
  relation_tamil      text,
  verification_status text DEFAULT 'pending' CHECK (
                         verification_status IN ('pending','verified','rejected')),
  created_by          uuid REFERENCES pmf_users(id),
  verified_at         timestamptz,
  created_at          timestamptz DEFAULT now(),
  UNIQUE (from_user_id, to_user_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_pmf_rel_from ON pmf_relationships(from_user_id);
CREATE INDEX IF NOT EXISTS idx_pmf_rel_to ON pmf_relationships(to_user_id);
*/

-- ─── Invites ───────────────────────────────────────────────
-- Day 11: uncomment when building invite flow
/*
CREATE TABLE IF NOT EXISTS pmf_invites (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  invited_by      uuid REFERENCES pmf_users(id),
  phone           text,
  email           text,
  relation_type   text,
  token           text UNIQUE,
  status          text DEFAULT 'pending' CHECK (
                    status IN ('pending','accepted','expired')),
  expires_at      timestamptz,
  created_at      timestamptz DEFAULT now()
);
*/

-- ─── Inferred Relationships ────────────────────────────────
-- Day 3-4: uncomment alongside relationships
/*
CREATE TABLE IF NOT EXISTS pmf_inferred (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  from_user_id    uuid REFERENCES pmf_users(id) ON DELETE CASCADE,
  to_user_id      uuid REFERENCES pmf_users(id) ON DELETE CASCADE,
  relation_type   text,
  relation_tamil  text,
  generation      integer,
  derived_via     text[],
  created_at      timestamptz DEFAULT now(),
  UNIQUE (from_user_id, to_user_id, relation_type)
);
*/
