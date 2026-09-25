-- Tourtle media bucket (optimized photo/video + voice). Run once after schema.sql
insert into storage.buckets (id, name, public) values ('tourtle-media', 'tourtle-media', false)
on conflict (id) do nothing;

-- Owner-only RLS: user can read/write/list only under their own folder user_id/
drop policy if exists "owner read" on storage.objects;
create policy "owner read" on storage.objects for select
  using (bucket_id = 'tourtle-media' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "owner write" on storage.objects;
create policy "owner write" on storage.objects for insert
  with check (bucket_id = 'tourtle-media' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "owner update" on storage.objects;
create policy "owner update" on storage.objects for update
  using (bucket_id = 'tourtle-media' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "owner delete" on storage.objects;
create policy "owner delete" on storage.objects for delete
  using (bucket_id = 'tourtle-media' and auth.uid()::text = (storage.foldername(name))[1]);

-- Activities: add media columns if not exists
alter table public.activities add column if not exists media_url text;
alter table public.activities add column if not exists media_type text;
alter table public.activities add column if not exists media_meta jsonb;
