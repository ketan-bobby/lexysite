export interface DownloadAsset {
  label: string;
  description: string;
  file: string;
}

export type ArticleFormat = "guide" | "research" | "template" | "report";

export type ArticleLevel = "beginner" | "intermediate" | "advanced";

export interface Article {
  slug: string;
  category: string;
  title: string;
  excerpt: string;
  readTime: string;
  body: string;
  downloads?: string[];
  format?: ArticleFormat;
  level?: ArticleLevel;
}
