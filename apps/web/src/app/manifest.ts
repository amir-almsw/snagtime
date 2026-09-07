import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Dvision Studio",
    short_name: "Dvision",
    description: "Precision cuts, grooming, and styling by appointment.",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#F5F8FC",
    theme_color: "#111826",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
