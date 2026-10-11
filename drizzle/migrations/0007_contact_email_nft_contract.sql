-- Contact email and the ApeGames NFT contract. Idempotent.

-- Player questions and IRL prize claims go to fun@ApeGamesGotcha.com.
insert into public.app_config (key, value)
values ('contact', jsonb_build_object('notify_to', jsonb_build_array('fun@apegamesgotcha.com')))
on conflict (key) do update
  set value = public.app_config.value || jsonb_build_object('notify_to', jsonb_build_array('fun@apegamesgotcha.com')),
      updated_at = now();

-- "My ApeGames NFTs" reads holdings from the ApeGames Digital Competition contract on ApeChain.
update public.app_config
   set value = value || jsonb_build_object('contract', '0x8Bb7b20291A9fA2F25705b8487194B410808c28b', 'chain_id', 33139),
       updated_at = now()
 where key = 'nft'
   and coalesce(lower(value->>'contract'), '') <> lower('0x8Bb7b20291A9fA2F25705b8487194B410808c28b');
