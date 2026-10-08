-- Official ApeGames account (@goApeGames on X) for the guide; keeps any other event_info edits.
update public.app_config
set value = value || '{"games_handle": "@goApeGames"}'::jsonb,
    updated_at = now()
where key = 'event_info' and coalesce(value->>'games_handle', '') = '';
