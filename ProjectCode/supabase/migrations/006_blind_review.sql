-- =============================================================================
-- 006_blind_review.sql -- blind review of labels
--
-- Idempotent, like the others. Applied by apply_migrations.py after 005.
--
-- The rule: a labeler's label is "in review" until one other labeler picks
-- the same label on the Review page without seeing it, or an admin reviews
-- it; then it's official. A different pick makes it "disputed", and an admin
-- settles it. An admin's own label is official straight away.
--
-- How it's stored:
--   * images.label only ever holds the OFFICIAL label, so the public catalog,
--     the counts and the export never show a label nobody has checked. Every
--     label that exists when this is applied stays official.
--   * A label waiting for review lives in pending_labels, one row per image,
--     which nobody can read directly: the functions below show a pending
--     label only to the person who gave it and to admins.
--   * A labeler can propose a change to an official label (the official one
--     stays until the change is confirmed), withdraw their own pending label,
--     but not clear an official label; only admins can.
--   * Only admins update images.label directly now; labelers go through
--     submit_labels(). 002's policy for labelers is dropped below on every run.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Pending labels
-- -----------------------------------------------------------------------------

create table if not exists public.pending_labels (
  image_id      text primary key references public.images (image_id) on delete cascade,
  label         text not null references public.label_options (name) on update cascade,
  labeled_by    uuid not null references auth.users (id) on delete cascade,
  labeled_at    timestamptz not null default now(),
  status        text not null default 'in_review' check (status in ('in_review', 'disputed')),
  -- The reviewer's pick, once a review disagreed (status 'disputed').
  review_label  text references public.label_options (name) on update cascade,
  reviewed_by   uuid references auth.users (id) on delete set null,
  reviewed_at   timestamptz
);

create index if not exists pending_labels_queue_idx on public.pending_labels (status, labeled_at);
create index if not exists pending_labels_by_idx on public.pending_labels (labeled_by);


-- -----------------------------------------------------------------------------
-- Who an official label is credited to
-- -----------------------------------------------------------------------------
-- 002's trigger, plus one thing: when a review makes a label official, the
-- review functions credit the person who gave it (not the reviewer) by
-- setting app.label_by for that one statement. Clients can't set it: the API
-- only exposes functions in the public schema.

create or replace function public.images_set_labeled_meta()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  credited uuid := nullif(current_setting('app.label_by', true), '')::uuid;
begin
  if new.label is distinct from old.label then
    if new.label is null then
      new.labeled_by := null;
      new.labeled_date := null;
    else
      new.labeled_by := coalesce(credited, auth.uid());
      new.labeled_date := now();
    end if;
  else
    new.labeled_by := old.labeled_by;
    new.labeled_date := old.labeled_date;
  end if;
  return new;
end;
$$;

-- Makes `chosen` the official label of `target`, credited to `credited`.
create or replace function public.make_label_official(target text, chosen text, credited uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  perform set_config('app.label_by', coalesce(credited::text, ''), true);
  update public.images set label = chosen where image_id = target;
  perform set_config('app.label_by', '', true);
  delete from public.pending_labels where image_id = target;
end;
$$;


-- -----------------------------------------------------------------------------
-- Only admins write images.label directly
-- -----------------------------------------------------------------------------

drop policy if exists "Labelers can set the label" on public.images;
drop policy if exists "Admins can set the label" on public.images;
create policy "Admins can set the label"
  on public.images for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());


-- -----------------------------------------------------------------------------
-- Labeling
-- -----------------------------------------------------------------------------

-- Labels (or, with new_label null, clears) up to 500 images. One row per image:
--   official    an admin's label, official now (pending label dropped)
--   cleared     an admin cleared it
--   in_review   a labeler's label, waiting for review
--   withdrawn   a labeler took back their own pending label (or picked the
--               official one again), so the official label stands
--   unchanged   nothing to do
--   locked      someone else's label is waiting for review on this image
--   not_allowed a labeler tried to clear an official label
--   missing     no such image
create or replace function public.submit_labels(image_ids text[], new_label text)
returns table (target text, outcome text)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  admin boolean := public.is_admin();
  id text;
  official text;
  p public.pending_labels%rowtype;
  has_pending boolean;
begin
  if not public.can_label() then
    raise exception 'Your account can''t label images' using errcode = '42501';
  end if;
  if coalesce(array_length(image_ids, 1), 0) > 500 then
    raise exception 'Label at most 500 images at a time' using errcode = '22023';
  end if;
  if new_label is not null and not exists (select 1 from public.label_options where name = new_label) then
    raise exception 'Unknown label "%"', new_label using errcode = '23503',
      hint = 'Add it with "Enter new label" first, or refresh the page.';
  end if;

  foreach id in array coalesce(image_ids, '{}') loop
    target := id;
    select i.label into official from public.images i where i.image_id = id for update;
    if not found then
      outcome := 'missing';
      return next;
      continue;
    end if;
    select * into p from public.pending_labels pl where pl.image_id = id for update;
    has_pending := found;

    if admin then
      perform public.make_label_official(id, new_label, null);
      outcome := case when new_label is null then 'cleared' else 'official' end;
      if new_label is not distinct from official and not has_pending then outcome := 'unchanged'; end if;
    elsif has_pending and p.labeled_by <> me then
      outcome := 'locked';
    elsif new_label is null or new_label = official then
      if has_pending then
        delete from public.pending_labels pl where pl.image_id = id;
        outcome := 'withdrawn';
      elsif new_label is null and official is not null then
        outcome := 'not_allowed';
      else
        outcome := 'unchanged';
      end if;
    elsif has_pending and p.label = new_label and p.status = 'in_review' then
      outcome := 'unchanged';
    else
      insert into public.pending_labels (image_id, label, labeled_by)
      values (id, new_label, me)
      on conflict (image_id) do update set
        label = excluded.label, labeled_by = excluded.labeled_by, labeled_at = now(),
        status = 'in_review', review_label = null, reviewed_by = null, reviewed_at = null;
      outcome := 'in_review';
    end if;
    return next;
  end loop;
end;
$$;

-- The pending labels in one folder, for the labeling grid. The label itself
-- is only shown to whoever gave it, and to admins.
create or replace function public.folder_pending(folder text)
returns table (image_id text, status text, label text, is_mine boolean)
language sql
stable
security definer
set search_path = public
as $$
  select p.image_id, p.status,
         case when p.labeled_by = auth.uid() or public.is_admin() then p.label end,
         p.labeled_by = auth.uid()
  from public.pending_labels p
  join public.images i on i.image_id = p.image_id
  where i.folder_name = folder and public.can_label();
$$;


-- -----------------------------------------------------------------------------
-- Reviewing
-- -----------------------------------------------------------------------------

-- What this person can review: someone else's label, still in review. No
-- label and no labeler in it -- the review is blind.
create or replace function public.review_queue(max_rows integer default 200)
returns table (image_id text, folder_name text, filename text, relative_path text,
               width integer, height integer, file_size_bytes bigint, format text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.can_label() then
    raise exception 'Your account can''t review labels' using errcode = '42501';
  end if;
  return query
    select i.image_id, i.folder_name, i.filename, i.relative_path,
           i.width, i.height, i.file_size_bytes::bigint, i.format
    from public.pending_labels p
    join public.images i on i.image_id = p.image_id
    where p.status = 'in_review' and p.labeled_by <> auth.uid()
    order by p.labeled_at, p.image_id
    limit least(greatest(coalesce(max_rows, 200), 1), 1000);
end;
$$;

create or replace function public.review_counts()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.can_label() then
    raise exception 'Your account can''t review labels' using errcode = '42501';
  end if;
  return json_build_object(
    'to_review',    (select count(*) from public.pending_labels where status = 'in_review' and labeled_by <> auth.uid()),
    'in_review',    (select count(*) from public.pending_labels where status = 'in_review'),
    'disputed',     (select count(*) from public.pending_labels where status = 'disputed'),
    'official',     (select count(*) from public.images where label is not null),
    'mine_waiting', (select count(*) from public.pending_labels where status = 'in_review' and labeled_by = auth.uid()));
end;
$$;

-- A reviewer's blind pick. Same label: official (credited to the labeler).
-- Different: disputed. An admin's pick is final either way. The answer tells
-- the reviewer the first label afterwards, never who gave it.
create or replace function public.submit_review(target text, chosen text)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  p public.pending_labels%rowtype;
  result text;
begin
  if not public.can_label() then
    raise exception 'Your account can''t review labels' using errcode = '42501';
  end if;
  if not exists (select 1 from public.label_options where name = chosen) then
    raise exception 'Unknown label "%"', chosen using errcode = '23503';
  end if;
  select * into p from public.pending_labels where image_id = target for update;
  if not found or p.status <> 'in_review' then
    raise exception 'This image isn''t waiting for review any more' using errcode = 'P0002',
      hint = 'Someone may have just reviewed it. Refresh the page.';
  end if;
  if p.labeled_by = me then
    raise exception 'You can''t review your own label' using errcode = '42501';
  end if;

  if public.is_admin() then
    perform public.make_label_official(target, chosen, case when chosen = p.label then p.labeled_by else me end);
    result := case when chosen = p.label then 'official' else 'corrected' end;
  elsif chosen = p.label then
    perform public.make_label_official(target, chosen, p.labeled_by);
    result := 'official';
  else
    update public.pending_labels
       set status = 'disputed', review_label = chosen, reviewed_by = me, reviewed_at = now()
     where image_id = target;
    result := 'disputed';
  end if;
  return json_build_object('outcome', result, 'first_label', p.label);
end;
$$;

-- Admins: the disputed images, with both labels and who gave them.
create or replace function public.disputed_list()
returns table (image_id text, folder_name text, filename text, relative_path text,
               width integer, height integer, file_size_bytes bigint, format text,
               first_label text, first_by text, first_at timestamptz,
               review_label text, review_by text, review_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can settle disputes' using errcode = '42501';
  end if;
  return query
    select i.image_id, i.folder_name, i.filename, i.relative_path,
           i.width, i.height, i.file_size_bytes::bigint, i.format,
           p.label, coalesce(a.full_name, a.email, 'Someone'), p.labeled_at,
           p.review_label, coalesce(b.full_name, b.email, 'Someone'), p.reviewed_at
    from public.pending_labels p
    join public.images i on i.image_id = p.image_id
    left join public.profiles a on a.id = p.labeled_by
    left join public.profiles b on b.id = p.reviewed_by
    where p.status = 'disputed'
    order by p.reviewed_at, p.image_id;
end;
$$;

-- Admins settle a dispute. Credit goes to whoever gave the chosen label.
create or replace function public.resolve_dispute(target text, chosen text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  p public.pending_labels%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Only admins can settle disputes' using errcode = '42501';
  end if;
  if not exists (select 1 from public.label_options where name = chosen) then
    raise exception 'Unknown label "%"', chosen using errcode = '23503';
  end if;
  select * into p from public.pending_labels where image_id = target for update;
  if not found or p.status <> 'disputed' then
    raise exception 'This image isn''t disputed any more' using errcode = 'P0002',
      hint = 'Another admin may have settled it. Refresh the page.';
  end if;
  perform public.make_label_official(target, chosen,
    case when chosen = p.label then p.labeled_by
         when chosen = p.review_label then p.reviewed_by
         else auth.uid() end);
end;
$$;


-- -----------------------------------------------------------------------------
-- Folder progress counts pending labels as done (for labelers' to-do lists)
-- -----------------------------------------------------------------------------
-- Just counts, so anyone may see them. Images with an official label are
-- already counted, so only pending labels on unlabeled images are added.

create or replace function public.pending_label_counts()
returns table (folder_name text, pending_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select i.folder_name, count(*)
  from public.pending_labels p
  join public.images i on i.image_id = p.image_id
  where i.label is null
  group by i.folder_name;
$$;

create or replace view public.folder_labeling_progress
with (security_invoker = true) as
select
  f.folder_name,
  f.site_normalized,
  f.image_count,
  (coalesce(l.labeled_count, 0) + coalesce(pc.pending_count, 0))::int                as labeled_count,
  (f.image_count - coalesce(l.labeled_count, 0) - coalesce(pc.pending_count, 0))::int as unlabeled_count,
  case when f.image_count > 0
       then round(100.0 * (coalesce(l.labeled_count, 0) + coalesce(pc.pending_count, 0)) / f.image_count, 1)
       else 0 end                                                                      as pct_labeled
from public.folders_visible f
left join (
  select folder_name, count(*) as labeled_count
  from public.images
  where label is not null
  group by folder_name
) l using (folder_name)
left join public.pending_label_counts() pc using (folder_name)
order by f.folder_name;


-- -----------------------------------------------------------------------------
-- Labels can't be deleted while a pending label uses them either
-- -----------------------------------------------------------------------------
-- 005's function with that check added. (Renames carry over to pending labels
-- by themselves: their foreign keys are "on update cascade".)

create or replace function public.admin_delete_label(label_name text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can delete labels' using errcode = '42501';
  end if;

  perform 1 from public.label_options where name = label_name for update;
  if not found then
    raise exception 'No label called "%"', label_name using errcode = 'P0002',
      hint = 'It may already have been deleted. Refresh the page.';
  end if;

  if exists (select 1 from public.images where label = label_name) then
    raise exception 'Images use "%", so it can''t be deleted', label_name
      using errcode = '22023', hint = 'Relabel those images first.';
  end if;
  if exists (select 1 from public.pending_labels where label = label_name or review_label = label_name) then
    raise exception 'Labels waiting for review use "%", so it can''t be deleted', label_name
      using errcode = '22023', hint = 'Review or settle those first.';
  end if;

  delete from public.label_options where name = label_name;
end;
$$;


-- -----------------------------------------------------------------------------
-- Row-Level Security and privileges
-- -----------------------------------------------------------------------------

-- No direct access at all: the functions above are the only way in.
alter table public.pending_labels enable row level security;
revoke all on table public.pending_labels from anon, authenticated;

grant select on table public.folder_labeling_progress to anon, authenticated;

revoke all on function public.make_label_official(text, text, uuid)  from public, anon, authenticated;
revoke all on function public.submit_labels(text[], text)            from public, anon, authenticated;
revoke all on function public.folder_pending(text)                   from public, anon, authenticated;
revoke all on function public.review_queue(integer)                  from public, anon, authenticated;
revoke all on function public.review_counts()                        from public, anon, authenticated;
revoke all on function public.submit_review(text, text)              from public, anon, authenticated;
revoke all on function public.disputed_list()                        from public, anon, authenticated;
revoke all on function public.resolve_dispute(text, text)            from public, anon, authenticated;
revoke all on function public.pending_label_counts()                 from public, anon, authenticated;
grant execute on function public.submit_labels(text[], text)   to authenticated;
grant execute on function public.folder_pending(text)          to authenticated;
grant execute on function public.review_queue(integer)         to authenticated;
grant execute on function public.review_counts()               to authenticated;
grant execute on function public.submit_review(text, text)     to authenticated;
grant execute on function public.disputed_list()               to authenticated;
grant execute on function public.resolve_dispute(text, text)   to authenticated;
grant execute on function public.pending_label_counts()        to anon, authenticated;
