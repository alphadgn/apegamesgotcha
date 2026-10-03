DROP POLICY IF EXISTS "config public read" ON public.app_config;

REVOKE SELECT ON public.app_config FROM anon;
GRANT SELECT ON public.app_config TO authenticated;
GRANT ALL ON public.app_config TO service_role;

CREATE POLICY "players read nft config"
ON public.app_config
FOR SELECT
TO authenticated
USING (key = 'nft' OR public.has_role(auth.uid(), 'admin'));
