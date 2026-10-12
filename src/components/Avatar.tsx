// A player's profile picture (private 'avatars' bucket, shown through a short-lived signed link from the
// server: your own picture, or anyone's for the super admin), or their initial when there's no picture.
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getAvatarUrls } from "@/lib/users.functions";

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
  const urlsFn = useServerFn(getAvatarUrls);
  const { data: url } = useQuery({
    queryKey: ["avatar", path],
    enabled: !!path,
    staleTime: 45 * 60_000, // links last an hour
    queryFn: async () => (await urlsFn({ data: { paths: [path!] } })).urls[path!] ?? null,
  });
  const style = { width: size, height: size };
  if (path && url)
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
