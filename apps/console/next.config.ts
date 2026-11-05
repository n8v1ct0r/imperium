import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The demo console is a static export: the replay and the Cesium build are plain files.
  output: "export",
  // Workspace packages ship TypeScript sources, not built output.
  transpilePackages: ["@imperium/protocol", "@imperium/geo"],
};

export default nextConfig;
