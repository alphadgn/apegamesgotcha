// A player's profile picture (private 'avatars' bucket, shown through a short-lived signed link),
// or their initial when they haven't uploaded one.
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export function Avatar({
  path,
  name,
  size = 40,
  className = "",
}: {
  path: string | null | undefined;
  name: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    if (path)
      void supabase.storage
        .from("avatars")
        .createSignedUrl(path, 3600)
        .then(({ data }) => live && setUrl(data?.signedUrl ?? null));
    return () => {
      live = false;
    };
  }, [path]);
  const style = { width: size, height: size };
  if (url)
    return (
      <img
        src={url}
        alt=""
        style={style}
        className={`shrink-0 rounded-full object-cover ${className}`}
      />
    );
  return (
    <span
      aria-hidden
      style={{
        ...style,
        fontSize: Math.round(size * 0.42),
        backgroundColor: "#f6c343",
        color: "#141414",
      }}
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold uppercase ${className}`}
    >
      {(name?.trim()?.[0] ?? "?").toUpperCase()}
    </span>
  );
}
