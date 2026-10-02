-- Apply this migration before deploying the bot changes. It makes balance updates
-- and their ledger entries atomic, and uses reference_id for idempotency.
alter table public.users
    add column if not exists balance numeric(14, 0) not null default 0;

create unique index if not exists users_telegram_id_key
    on public.users (telegram_id);

create table if not exists public.balance_transactions (
    id bigserial primary key,
    user_id bigint not null references public.users(id),
    telegram_id text not null,
    type text not null check (type in ('deposit', 'purchase', 'purchase_refund', 'refund')),
    amount numeric(14, 0) not null check (amount <> 0),
    balance_before numeric(14, 0) not null,
    balance_after numeric(14, 0) not null,
    reference_id text not null unique,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index if not exists balance_transactions_telegram_id_created_at_idx
    on public.balance_transactions (telegram_id, created_at desc);

create or replace function public.apply_balance_transaction(
    p_telegram_id text,
    p_username text,
    p_first_name text,
    p_amount numeric,
    p_type text,
    p_reference_id text,
    p_metadata jsonb default '{}'::jsonb
)
returns table (applied boolean, balance numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user public.users%rowtype;
    v_existing public.balance_transactions%rowtype;
    v_before numeric(14, 0);
    v_after numeric(14, 0);
begin
    if p_amount = 0 then
        raise exception 'Balance transaction amount must not be zero';
    end if;

    -- Serialize the same external reference so retries are idempotent even when
    -- they arrive concurrently from multiple bot processes.
    perform pg_advisory_xact_lock(hashtextextended(p_reference_id, 0));

    select * into v_existing
    from public.balance_transactions
    where reference_id = p_reference_id;

    if found then
        return query select false, v_existing.balance_after;
        return;
    end if;

    insert into public.users (id, telegram_id, username, first_name, balance, is_active)
    values (p_telegram_id::bigint, p_telegram_id, coalesce(p_username, '-'),
            coalesce(p_first_name, 'Pengguna Telegram'), 0, true)
    on conflict (telegram_id) do update
        set username = excluded.username,
            first_name = excluded.first_name,
            is_active = true
    returning * into v_user;

    select * into v_user from public.users where id = v_user.id for update;
    v_before := coalesce(v_user.balance, 0);
    v_after := v_before + p_amount;

    if v_after < 0 then
        raise exception 'Insufficient balance';
    end if;

    update public.users set balance = v_after where id = v_user.id;

    insert into public.balance_transactions (
        user_id, telegram_id, type, amount, balance_before, balance_after,
        reference_id, metadata
    ) values (
        v_user.id, p_telegram_id, p_type, p_amount, v_before, v_after,
        p_reference_id, coalesce(p_metadata, '{}'::jsonb)
    );

    return query select true, v_after;
end;
$$;

revoke all on function public.apply_balance_transaction(text, text, text, numeric, text, text, jsonb) from public;
grant execute on function public.apply_balance_transaction(text, text, text, numeric, text, text, jsonb) to service_role;
