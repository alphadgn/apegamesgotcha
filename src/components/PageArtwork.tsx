import artwork from "@/assets/apegames-event-collage.jpeg.asset.json";

export function PageArtwork() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden bg-background" aria-hidden="true">
      <img
        src={artwork.url}
        alt=""
        className="h-full w-full object-cover object-center opacity-45"
      />
      <div className="absolute inset-0 bg-background/65 md:bg-background/60" />
    </div>
  );
}