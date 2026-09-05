-- MyPets Pet Media Storage v1
-- Public animal media is served from a public bucket for CDN efficiency.
-- Upload/update/delete remain authenticated and restricted to the uploader's user-id folder.
-- Object path convention: <auth-user-id>/<pet-id>/<uuid>.<ext>

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'pet-media',
  'pet-media',
  true,
  10485760,
  array['image/jpeg','image/png','image/webp']::text[]
)
on conflict (id) do update set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Uploads are allowed only inside the authenticated user's top-level folder.
drop policy if exists "mypets_pet_media_insert_own_folder" on storage.objects;
create policy "mypets_pet_media_insert_own_folder"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'pet-media'
  and (storage.foldername(name))[1] = (select auth.jwt()->>'sub')
  and lower(storage.extension(name)) in ('jpg','jpeg','png','webp')
);

-- Public bucket downloads do not need a SELECT policy. This SELECT policy only allows
-- authenticated users to list/read their own objects through authenticated Storage APIs.
drop policy if exists "mypets_pet_media_select_own_folder" on storage.objects;
create policy "mypets_pet_media_select_own_folder"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'pet-media'
  and (storage.foldername(name))[1] = (select auth.jwt()->>'sub')
);

-- Upsert is not used by MyPets, but UPDATE remains restricted for safe future use.
drop policy if exists "mypets_pet_media_update_own_folder" on storage.objects;
create policy "mypets_pet_media_update_own_folder"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'pet-media'
  and (storage.foldername(name))[1] = (select auth.jwt()->>'sub')
)
with check (
  bucket_id = 'pet-media'
  and (storage.foldername(name))[1] = (select auth.jwt()->>'sub')
  and lower(storage.extension(name)) in ('jpg','jpeg','png','webp')
);

drop policy if exists "mypets_pet_media_delete_own_folder" on storage.objects;
create policy "mypets_pet_media_delete_own_folder"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'pet-media'
  and (storage.foldername(name))[1] = (select auth.jwt()->>'sub')
);
