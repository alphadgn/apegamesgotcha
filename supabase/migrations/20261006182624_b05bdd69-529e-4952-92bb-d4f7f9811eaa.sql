CREATE TABLE public.guide_messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  parts JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX guide_messages_user_created ON public.guide_messages (user_id, created_at);
GRANT SELECT, INSERT ON public.guide_messages TO authenticated;
GRANT ALL ON public.guide_messages TO service_role;
ALTER TABLE public.guide_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "players read own guide messages" ON public.guide_messages FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "players add own guide messages" ON public.guide_messages FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);