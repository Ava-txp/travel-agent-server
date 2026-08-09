import fs from "node:fs";
import path from "node:path";

export type KnowledgeChunkType = "attraction" | "guide" | "both";

export type KnowledgeChunk = {
  id: string;
  city: string;
  type: KnowledgeChunkType;
  title: string;
  content: string;
  tags: string[];
  source: string;
};

type DocMeta = {
  city: string;
  type: KnowledgeChunkType;
  tags: string[];
};

const KNOWLEDGE_DIR = path.resolve(process.cwd(), "data/knowledge");

let cachedChunks: KnowledgeChunk[] | null = null;

const parseFrontmatter = (
  raw: string,
): { meta: DocMeta; body: string } => {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) {
    return {
      meta: { city: "", type: "both", tags: [] },
      body: raw,
    };
  }

  const metaLines = match[1].split("\n");
  const meta: DocMeta = { city: "", type: "both", tags: [] };

  for (const line of metaLines) {
    const [key, ...rest] = line.split(":");
    if (!key || rest.length === 0) continue;
    const value = rest.join(":").trim();
    if (key.trim() === "city") meta.city = value;
    if (key.trim() === "type") {
      if (value === "attraction" || value === "guide" || value === "both") {
        meta.type = value;
      }
    }
    if (key.trim() === "tags") {
      meta.tags = value
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    }
  }

  return { meta, body: match[2] };
};

const splitSections = (body: string): { title: string; content: string }[] => {
  const lines = body.split("\n");
  const sections: { title: string; content: string }[] = [];
  let currentTitle = "概述";
  let buffer: string[] = [];

  const flush = () => {
    const content = buffer.join("\n").trim();
    if (!content) return;
    sections.push({ title: currentTitle, content });
    buffer = [];
  };

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      flush();
      currentTitle = heading[1].trim();
      continue;
    }
    if (line.match(/^#\s+/)) {
      // document title — keep as context but don't start a section alone
      continue;
    }
    buffer.push(line);
  }
  flush();

  return sections;
};

const inferChunkType = (
  title: string,
  docType: KnowledgeChunkType,
): KnowledgeChunkType => {
  if (docType === "attraction" || docType === "guide") return docType;
  if (/景点|必去/.test(title)) return "attraction";
  if (/攻略|交通|美食|住宿|游玩/.test(title)) return "guide";
  return "both";
};

const tokenize = (text: string): string[] => {
  const normalized = text.toLowerCase();
  const parts = normalized.match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) ?? [];
  const tokens: string[] = [];

  for (const part of parts) {
    if (/^[\u4e00-\u9fff]+$/.test(part)) {
      tokens.push(part);
      for (let i = 0; i < part.length - 1; i += 1) {
        tokens.push(part.slice(i, i + 2));
      }
    } else {
      tokens.push(part);
    }
  }

  return tokens;
};

export const loadKnowledgeChunks = (force = false): KnowledgeChunk[] => {
  if (cachedChunks && !force) return cachedChunks;

  if (!fs.existsSync(KNOWLEDGE_DIR)) {
    cachedChunks = [];
    return cachedChunks;
  }

  const files = fs
    .readdirSync(KNOWLEDGE_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort();

  const chunks: KnowledgeChunk[] = [];

  for (const file of files) {
    const fullPath = path.join(KNOWLEDGE_DIR, file);
    const raw = fs.readFileSync(fullPath, "utf8");
    const { meta, body } = parseFrontmatter(raw);
    const sections = splitSections(body);

    sections.forEach((section, index) => {
      chunks.push({
        id: `${file}#${index}`,
        city: meta.city,
        type: inferChunkType(section.title, meta.type),
        title: section.title,
        content: section.content,
        tags: meta.tags,
        source: file,
      });
    });
  }

  cachedChunks = chunks;
  return chunks;
};

export type RetrieveOptions = {
  query: string;
  city?: string;
  type?: KnowledgeChunkType | "any";
  topK?: number;
};

const scoreChunk = (
  chunk: KnowledgeChunk,
  queryTokens: string[],
  city?: string,
): number => {
  if (city && chunk.city && !chunk.city.includes(city) && !city.includes(chunk.city)) {
    // soft penalty rather than hard filter when city mismatches
    // hard filter applied separately when requested
  }

  const haystack = tokenize(
    `${chunk.city} ${chunk.title} ${chunk.tags.join(" ")} ${chunk.content}`,
  );
  const haystackSet = new Set(haystack);

  let score = 0;
  for (const token of queryTokens) {
    if (!token) continue;
    if (haystackSet.has(token)) {
      score += token.length >= 2 ? 2 : 1;
    }
  }

  for (const token of queryTokens) {
    if (chunk.title.includes(token)) score += 4;
    if (chunk.city && (chunk.city.includes(token) || token.includes(chunk.city))) {
      score += 5;
    }
    if (chunk.tags.some((tag) => tag.includes(token) || token.includes(tag))) {
      score += 3;
    }
  }

  if (city && chunk.city && (chunk.city.includes(city) || city.includes(chunk.city))) {
    score += 6;
  }

  return score;
};

export const retrieveKnowledge = (
  options: RetrieveOptions,
): KnowledgeChunk[] => {
  const { query, city, type = "any", topK = 3 } = options;
  const q = query.trim();
  if (!q) return [];

  const chunks = loadKnowledgeChunks();
  const queryTokens = tokenize(`${q} ${city ?? ""}`);

  const filtered = chunks.filter((chunk) => {
    if (city && chunk.city && !chunk.city.includes(city) && !city.includes(chunk.city)) {
      return false;
    }
    if (type === "any") return true;
    return chunk.type === type || chunk.type === "both";
  });

  const ranked = filtered
    .map((chunk) => ({ chunk, score: scoreChunk(chunk, queryTokens, city) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((item) => item.chunk);

  return ranked;
};

export const formatChunksForPrompt = (chunks: KnowledgeChunk[]): string => {
  if (chunks.length === 0) return "";
  return chunks
    .map(
      (chunk, index) =>
        `[资料${index + 1}|${chunk.city}|${chunk.title}]\n${chunk.content}`,
    )
    .join("\n\n");
};
