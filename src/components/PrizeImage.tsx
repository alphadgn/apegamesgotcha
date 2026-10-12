import { supabase } from "@/integrations/supabase/client";

/** Public link to a prize picture (the prize-images bucket is public: prize photos aren't sensitive). */
export function usePrizeImageUrl(path: string | null | undefined) {
  return path ? supabase.storage.from("prize-images").getPublicUrl(path).data.publicUrl : null;
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
