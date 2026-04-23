import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://tetheredconsulting.com";
  const now = new Date();

  return [
    { url: base,                        lastModified: now, changeFrequency: "weekly",  priority: 1.0 },
    { url: `${base}/for-employers`,     lastModified: now, changeFrequency: "weekly",  priority: 0.9 },
    { url: `${base}/how-it-works`,      lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/beta`,              lastModified: now, changeFrequency: "weekly",  priority: 0.8 },
    { url: `${base}/faq`,               lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${base}/privacy`,           lastModified: now, changeFrequency: "monthly", priority: 0.5 },
  ];
}
