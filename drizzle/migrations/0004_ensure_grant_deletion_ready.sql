create or replace function public.admin_delete_grant(_grant_id uuid, _actor uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare g public.spin_grants; v_removed int; v_used int;
begin
  select * into g from public.spin_grants where id = _grant_id for update;
  if not found then raise exception 'No such grant'; end if;
  with d as (
    delete from public.spin_credits c
     where c.grant_id = _grant_id and c.used_spin_id is null and c.used_at is null
     returning c.id
  ) select count(*)::int into v_removed from d;
  select count(*)::int into v_used from public.spin_credits c where c.grant_id = _grant_id;
  if v_used = 0 then
    delete from public.spin_grants where id = _grant_id;
  else
    update public.spin_grants set count = v_used,
      note = btrim(note || ' · ' || v_removed || ' unused deleted by admin')
     where id = _grant_id;
  end if;
  insert into public.audit_log (actor, action, details)
  values (_actor, 'admin.grant_deleted', jsonb_build_object('grant_id', _grant_id, 'user_id', g.user_id, 'kind', g.kind,
          'granted', g.count, 'removed', v_removed, 'kept_used', v_used, 'note', g.note));
  return v_removed;
end $$;
revoke all on function public.admin_delete_grant(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_delete_grant(uuid, uuid) to service_role;