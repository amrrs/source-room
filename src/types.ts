export interface Settings {
  chat_model: string;
  embedding_model: string;
  web_search: boolean;
  search_depth: "basic" | "advanced";
  extract_depth: "basic" | "advanced";
  include_domains: string[];
  exclude_domains: string[];
  max_results: number;
  topic: "general" | "news" | "finance";
  time_range: "" | "day" | "week" | "month" | "year";
  top_k: number;
  score_threshold: number;
  chunk_size: number;
  chunk_overlap: number;
  temperature: number;
  top_p: number;
  max_tokens: number;
  context_chars: number;
  history_turns: number;
  answer_style: "concise" | "balanced" | "detailed";
}
export interface Source {
  id: string;
  name: string;
  kind: "pdf" | "website";
  url: string;
  model: string;
  chunks: number;
  pages: number;
}
export interface Reference {
  id: number;
  title: string;
  kind: string;
  url: string;
  text: string;
  page?: number;
  score?: number;
}
export interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Reference[];
  model?: string;
  warnings?: string[];
  error?: string;
}
export interface Config {
  nebius_configured: boolean;
  tavily_configured: boolean;
  auth_required: boolean;
  defaults: Settings;
  chat_models: string[];
  embedding_models: string[];
}
