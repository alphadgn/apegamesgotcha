import artwork from "@/assets/apegames-landing-bg.jpg";

export function PageArtwork() {
  return (
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" aria-hidden="true">
      <img
        src={artwork}
        alt=""
        className="h-full w-full object-cover object-[58%_center] opacity-45 md:object-center md:opacity-50"
      />
      <div className="absolute inset-0 bg-background/60 md:bg-background/55" />
    </div>
  );
}