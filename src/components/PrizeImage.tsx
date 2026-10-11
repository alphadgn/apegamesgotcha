import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

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
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    if (path)
      void supabase.storage
        .from("prize-images")
        .createSignedUrl(path, 3600)
        .then(({ data }) => live && setUrl(data?.signedUrl ?? null));
    return () => {
      live = false;
    };
  }, [path]);
  if (!url)
    return (
      <div
        className={`flex items-center justify-center bg-muted text-2xl ${className}`}
        aria-hidden
      >
        🎁
      </div>
    );
  return <img src={url} alt={alt} className={`object-cover ${className}`} />;
}
