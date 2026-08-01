-- ═══════════════════════════════════════════════════════════════════════════
-- particletoy — full community backend schema (Supabase / Postgres)
--
-- Paste this whole file into: Supabase Dashboard → SQL Editor → New query → Run.
-- Safe to re-run: it drops + recreates its own policies/triggers and uses
-- "if not exists" for tables.
--
-- What it creates:
--   profiles       one row per account (username, avatar, bio, notification prefs)
--   particles      published effects (data jsonb, tags, visibility, counters)
--   likes          who liked what (one per user per particle)
--   comments       flat comment threads on particles
--   featured       curation: particle-of-the-day + featured grid (admin only)
--   notifications  in-app "someone liked/commented" inbox
--   media bucket   public storage for avatars + thumbnails
--   + RLS policies, counter triggers, view-count RPC, account deletion RPC
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. profiles ────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  username        text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name    text not null default '' check (char_length(display_name) <= 40),
  avatar_url      text,
  bio             text not null default '' check (char_length(bio) <= 500),
  is_admin        boolean not null default false,
  notify_comments boolean not null default true,
  notify_likes    boolean not null default true,
  created_at      timestamptz not null default now()
);

-- ── 2. particles ───────────────────────────────────────────────────────────
create table if not exists public.particles (
  id            uuid primary key default gen_random_uuid(),
  owner         uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 80),
  description   text not null default '' check (char_length(description) <= 2000),
  tags          text[] not null default '{}'
                check (array_length(tags, 1) is null or array_length(tags, 1) <= 12),
  data          jsonb not null check (pg_column_size(data) < 400000),
  thumb_url     text,
  visibility    text not null default 'public' check (visibility in ('public', 'private')),
  views         integer not null default 0,
  likes         integer not null default 0,
  comment_count integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists particles_pub_created on public.particles (visibility, created_at desc);
create index if not exists particles_pub_views   on public.particles (visibility, views desc);
create index if not exists particles_pub_likes   on public.particles (visibility, likes desc);
create index if not exists particles_owner_idx   on public.particles (owner);
create index if not exists particles_tags_idx    on public.particles using gin (tags);

-- ── 3. likes ───────────────────────────────────────────────────────────────
create table if not exists public.likes (
  particle_id uuid not null references public.particles(id) on delete cascade,
  user_id     uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (particle_id, user_id)
);

-- ── 4. comments ────────────────────────────────────────────────────────────
create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  particle_id uuid not null references public.particles(id) on delete cascade,
  user_id     uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  body        text not null check (char_length(body) between 1 and 1000),
  created_at  timestamptz not null default now()
);
create index if not exists comments_particle_idx on public.comments (particle_id, created_at);

-- ── 5. featured / particle of the day (admin-curated) ──────────────────────
create table if not exists public.featured (
  particle_id uuid primary key references public.particles(id) on delete cascade,
  kind        text not null check (kind in ('potd', 'featured')),
  featured_on date not null default current_date,
  note        text
);

-- ── 6. notifications ───────────────────────────────────────────────────────
create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  kind        text not null check (kind in ('comment', 'like')),
  actor       uuid not null references public.profiles(id) on delete cascade,
  particle_id uuid not null references public.particles(id) on delete cascade,
  comment_id  uuid references public.comments(id) on delete cascade,
  read        boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, read, created_at desc);


-- ═══ Row Level Security ═════════════════════════════════════════════════════
alter table public.profiles      enable row level security;
alter table public.particles     enable row level security;
alter table public.likes         enable row level security;
alter table public.comments      enable row level security;
alter table public.featured      enable row level security;
alter table public.notifications enable row level security;

-- profiles: everyone can read, you can only touch your own
drop policy if exists "profiles read"   on public.profiles;
drop policy if exists "profiles insert" on public.profiles;
drop policy if exists "profiles update" on public.profiles;
create policy "profiles read"   on public.profiles for select using (true);
create policy "profiles insert" on public.profiles for insert with check (id = auth.uid());
create policy "profiles update" on public.profiles for update using (id = auth.uid());

-- particles: public ones are visible to all, private only to their owner
drop policy if exists "particles read"   on public.particles;
drop policy if exists "particles insert" on public.particles;
drop policy if exists "particles update" on public.particles;
drop policy if exists "particles delete" on public.particles;
create policy "particles read"   on public.particles for select
  using (visibility = 'public' or owner = auth.uid());
create policy "particles insert" on public.particles for insert with check (owner = auth.uid());
create policy "particles update" on public.particles for update using (owner = auth.uid());
create policy "particles delete" on public.particles for delete using (owner = auth.uid());

-- likes: readable by all (to show "you liked this"), writable for yourself,
-- only on particles you can see
drop policy if exists "likes read"   on public.likes;
drop policy if exists "likes insert" on public.likes;
drop policy if exists "likes delete" on public.likes;
create policy "likes read"   on public.likes for select using (true);
create policy "likes insert" on public.likes for insert with check (
  user_id = auth.uid() and exists (
    select 1 from public.particles p
    where p.id = particle_id and (p.visibility = 'public' or p.owner = auth.uid())
  )
);
create policy "likes delete" on public.likes for delete using (user_id = auth.uid());

-- comments: visible where the particle is visible; you write as yourself;
-- you may delete your own comments and any comment on your own particle
drop policy if exists "comments read"   on public.comments;
drop policy if exists "comments insert" on public.comments;
drop policy if exists "comments delete" on public.comments;
create policy "comments read" on public.comments for select using (
  exists (select 1 from public.particles p
          where p.id = particle_id and (p.visibility = 'public' or p.owner = auth.uid()))
);
create policy "comments insert" on public.comments for insert with check (
  user_id = auth.uid() and exists (
    select 1 from public.particles p
    where p.id = particle_id and (p.visibility = 'public' or p.owner = auth.uid())
  )
);
create policy "comments delete" on public.comments for delete using (
  user_id = auth.uid() or exists (
    select 1 from public.particles p where p.id = particle_id and p.owner = auth.uid()
  )
);

-- featured: readable by all, writable only by admins
drop policy if exists "featured read"  on public.featured;
drop policy if exists "featured write" on public.featured;
create policy "featured read"  on public.featured for select using (true);
create policy "featured write" on public.featured for all
  using      (exists (select 1 from public.profiles pr where pr.id = auth.uid() and pr.is_admin))
  with check (exists (select 1 from public.profiles pr where pr.id = auth.uid() and pr.is_admin));

-- notifications: your own inbox only (rows are inserted by triggers)
drop policy if exists "notifications read"   on public.notifications;
drop policy if exists "notifications update" on public.notifications;
drop policy if exists "notifications delete" on public.notifications;
create policy "notifications read"   on public.notifications for select using (user_id = auth.uid());
create policy "notifications update" on public.notifications for update using (user_id = auth.uid());
create policy "notifications delete" on public.notifications for delete using (user_id = auth.uid());


-- ═══ Column-level privileges ════════════════════════════════════════════════
-- Counters (views/likes/comment_count) and is_admin are maintained ONLY by
-- triggers/RPCs below — clients cannot write them even on their own rows.
revoke insert, update on public.profiles      from anon, authenticated;
revoke insert, update on public.particles     from anon, authenticated;
revoke insert, update on public.likes         from anon, authenticated;
revoke insert, update on public.comments      from anon, authenticated;
revoke insert, update on public.notifications from anon, authenticated;

grant insert (id, username, display_name, avatar_url, bio)
  on public.profiles to authenticated;
grant update (display_name, avatar_url, bio, notify_comments, notify_likes)
  on public.profiles to authenticated;

grant insert (title, description, tags, data, visibility, thumb_url)
  on public.particles to authenticated;
grant update (title, description, tags, data, visibility, thumb_url)
  on public.particles to authenticated;

grant insert (particle_id)       on public.likes    to authenticated;
grant insert (particle_id, body) on public.comments to authenticated;
grant update (read)              on public.notifications to authenticated;

-- Signed-out visitors never delete anything. (RLS already blocks this — the
-- owner check can't match a null auth.uid() — but don't hand out the privilege.)
revoke delete on public.profiles, public.particles, public.likes,
                 public.comments, public.featured, public.notifications from anon;


-- ═══ Functions & triggers ═══════════════════════════════════════════════════

-- Auto-create a profile whenever an auth user signs up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  base text;
  candidate text;
  n int := 0;
begin
  base := lower(coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1), ''));
  base := regexp_replace(base, '[^a-z0-9_]', '', 'g');
  if char_length(base) < 3 then
    base := 'user' || substr(replace(new.id::text, '-', ''), 1, 8);
  end if;
  base := substr(base, 1, 20);
  candidate := base;
  while exists (select 1 from public.profiles where username = candidate) loop
    n := n + 1;
    candidate := substr(base, 1, 20 - char_length(n::text)) || n::text;
  end loop;
  insert into public.profiles (id, username, display_name)
  values (new.id, candidate,
          coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), candidate));
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Bump updated_at only when actual content changes (not when triggers below
-- touch the counters).
create or replace function public.touch_particle()
returns trigger language plpgsql as $$
begin
  if (new.title, new.description, new.tags, new.data, new.thumb_url)
     is distinct from
     (old.title, old.description, old.tags, old.data, old.thumb_url) then
    new.updated_at := now();
  end if;
  return new;
end $$;

drop trigger if exists particles_touch on public.particles;
create trigger particles_touch
  before update on public.particles
  for each row execute function public.touch_particle();

-- Like counter + like notification.
create or replace function public.on_like_change()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  powner uuid;
begin
  if tg_op = 'INSERT' then
    update public.particles set likes = likes + 1 where id = new.particle_id;
    select owner into powner from public.particles where id = new.particle_id;
    if powner is not null and powner <> new.user_id
       and (select notify_likes from public.profiles where id = powner) then
      insert into public.notifications (user_id, kind, actor, particle_id)
      values (powner, 'like', new.user_id, new.particle_id);
    end if;
    return new;
  else
    update public.particles set likes = greatest(0, likes - 1) where id = old.particle_id;
    delete from public.notifications
      where kind = 'like' and actor = old.user_id and particle_id = old.particle_id;
    return old;
  end if;
end $$;

drop trigger if exists likes_change on public.likes;
create trigger likes_change
  after insert or delete on public.likes
  for each row execute function public.on_like_change();

-- Comment counter + comment notification.
create or replace function public.on_comment_change()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  powner uuid;
begin
  if tg_op = 'INSERT' then
    update public.particles set comment_count = comment_count + 1 where id = new.particle_id;
    select owner into powner from public.particles where id = new.particle_id;
    if powner is not null and powner <> new.user_id
       and (select notify_comments from public.profiles where id = powner) then
      insert into public.notifications (user_id, kind, actor, particle_id, comment_id)
      values (powner, 'comment', new.user_id, new.particle_id, new.id);
    end if;
    return new;
  else
    update public.particles set comment_count = greatest(0, comment_count - 1)
      where id = old.particle_id;
    return old;
  end if;
end $$;

drop trigger if exists comments_change on public.comments;
create trigger comments_change
  after insert or delete on public.comments
  for each row execute function public.on_comment_change();

-- View counter RPC (anyone may call; security definer bypasses RLS update).
create or replace function public.bump_views(pid uuid)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.particles set views = views + 1 where id = pid;
$$;

-- Self-service account deletion (cascades: profile → particles → likes/comments).
create or replace function public.delete_account()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Belt and braces: auth.uid() is null for anon, so the delete would match
  -- nothing anyway, but a security-definer function should never be reachable
  -- by an unauthenticated caller at all.
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  delete from auth.users where id = auth.uid();
end $$;

-- Postgres grants EXECUTE on new functions to PUBLIC, and `revoke … from anon`
-- does NOT undo that inherited grant — it has to be revoked from public.
revoke execute on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;


-- ═══ Storage: public "media" bucket (avatars + thumbnails) ══════════════════
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 1048576, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- Anyone can read; signed-in users can write only inside their own /<uid>/ folder.
-- (If CREATE POLICY on storage.objects errors in your project, create these two
--  policies in Dashboard → Storage → media → Policies instead — same conditions.)
drop policy if exists "media read"      on storage.objects;
drop policy if exists "media write own" on storage.objects;
create policy "media read" on storage.objects for select using (bucket_id = 'media');
create policy "media write own" on storage.objects for all to authenticated
  using      (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);


-- ═══ Afterwards (manual, optional) ══════════════════════════════════════════
-- Make yourself an admin (enables the ★ Feature / ☀ POTD buttons on view pages):
--   update public.profiles set is_admin = true where username = 'your_username';
--
-- Curate by hand instead (kind is 'potd' or 'featured'):
--   insert into public.featured (particle_id, kind) values ('<uuid>', 'potd')
--     on conflict (particle_id) do update set kind = excluded.kind, featured_on = current_date;
--
-- The old prototype "effects" table (if you created it) is no longer used:
--   -- drop table if exists public.effects;
