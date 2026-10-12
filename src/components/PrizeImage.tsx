import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { getMyPrizeImageUrls, getPrizeImageUrls } from "@/lib/prize-images.functions";

/**
 * A signed link to a prize picture in the private prize-images bucket, from the server (which checks the
 * caller may see it: active prizes for everyone, won prizes for the winner, everything for admins).
 */
export function usePrizeImageUrl(path: string | null | undefined) {
  const publicFn = useServerFn(getPrizeImageUrls);
  const mineFn = useServerFn(getMyPrizeImageUrls);
  const { data } = useQuery({
    queryKey: ["prize-image", path],
    enabled: !!path,
    staleTime: 45 * 60_000, // links last an hour
    queryFn: async () => {
      const { data: s } = await supabase.auth.getSession(); // local, no network
      const r = await (s.session ? mineFn : publicFn)({ data: { paths: [path!] } });
      return r.urls[path!] ?? null;
    },
  });
  return data ?? null;
}

/** A prize picture from the private prize-images bucket, shown through a short-lived signed link. */
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
