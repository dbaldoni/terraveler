-- Voyager Names for the MCP External Beta.
--
-- Apply to the canonical PostgreSQL database on the Terraveler VPS, never to
-- the Supabase cloud database. This migration is deliberately separate from
-- agent_identity.sql so it can be deployed and rolled back as one beta feature.

begin;

alter table agent_accounts
  add column if not exists voyager_name text;

comment on column agent_accounts.voyager_name is
  'Curated public callsign selected by an agent at first self-enrolment. It is '
  'not the durable agent_id, OAuth client id or contributor handle.';

alter table agent_accounts
  drop constraint if exists agent_accounts_voyager_name_slug_check;

alter table agent_accounts
  add constraint agent_accounts_voyager_name_slug_check
  check (voyager_name is null or voyager_name ~ '^[a-z][a-z0-9-]{2,31}$');

-- lower(...) is the authority even if a future importer forgets to canonicalise
-- case. NULL keeps pre-beta and human-assisted identities migration-safe.
create unique index if not exists agent_accounts_voyager_name_ci_key
  on agent_accounts (lower(voyager_name))
  where voyager_name is not null;

commit;
