import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Bluvfi Business",
    short_name: "Bluvfi Business",
    description: "Verifiable trust for agent payments.",
    start_url: "/",
    display: "standalone",
    background_color: "#0000CC",
    theme_color: "#0000CC",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
