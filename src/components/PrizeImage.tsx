import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Link to a prize picture. The workspace blocks public buckets, so prize-images stays private and we use a
 * signed link (anyone may read prize-images per its storage rule, so this works signed in or out).
 */
export function usePrizeImageUrl(path: string | null | undefined) {
  const { data } = useQuery({
    queryKey: ["prize-image", path],
    enabled: !!path,
    staleTime: 50 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.storage.from("prize-images").createSignedUrl(path!, 3600);
      if (error) throw error;
      return data.signedUrl;
    },
  });
  return data ?? null;
}

/** A prize picture, shown round in the machine and in Your IRL prizes. */
export function PrizeImage({
  path,
  alt,
  className = "",
}: {
  path: string | null;
  alt: string;
  className?: string;
}) {
  const url = usePrizeImageUrl(path);
  if (!url)
    return (
      <div className={`flex items-center justify-center bg-muted text-2xl ${className}`} aria-hidden>
        🎁
      </div>
    );
  return <img src={url} alt={alt} className={`object-cover ${className}`} />;
}
