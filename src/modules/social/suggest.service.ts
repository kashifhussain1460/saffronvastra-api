import OpenAI from 'openai';
import { AppError } from '../../common/errors.js';

// Created on first use, not at import: `new OpenAI()` throws when OPENAI_API_KEY is missing, and doing that
// at module load crashed the whole API on any server without the key (the social router imports this file).
let client: OpenAI | null = null;
function openai(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new AppError(503, 'AI_NOT_CONFIGURED', 'AI caption suggestions are not configured (OPENAI_API_KEY is not set).');
  }
  client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

export interface SuggestInput {
  platform: string;
  contentType: string;
  productTitle: string;
  productDescription?: string | null;
  categoryName?: string | null;
  material?: string | null;
  tags?: string[];
}

export interface SuggestResult {
  caption: string;
  hashtags: string[];
}

export async function suggestCaptionAndHashtags(input: SuggestInput): Promise<SuggestResult> {
  const platformInstructions: Record<string, string> = {
    instagram: 'Instagram Post: casual, warm, story-driven tone. 1-3 sentences. Emojis encouraged.',
    facebook: 'Facebook Post: friendly and informative. 2-4 sentences. Can include a call-to-action.',
    pinterest: 'Pinterest Pin description: keyword-rich, inspirational, describe the product and its use. 2-3 sentences.',
  };

  const platformNote = platformInstructions[input.platform.toLowerCase()]
    ?? `${input.platform} ${input.contentType}: engaging, relevant caption.`;

  const tagContext = input.tags && input.tags.length > 0
    ? `\nProduct tags: ${input.tags.join(', ')}`
    : '';

  const categoryContext = input.categoryName ? `\nCategory: ${input.categoryName}` : '';
  const materialContext = input.material ? `\nMaterial: ${input.material}` : '';

  const descContext = input.productDescription
    ? `\nProduct description: ${input.productDescription.slice(0, 500)}`
    : '';

  const prompt = `You are a social media content expert for Saffron Vastra, a premium Indian handcrafted textile and fashion brand. Generate a caption and hashtags for a social media post.

Platform: ${platformNote}

Product: ${input.productTitle}${categoryContext}${materialContext}${descContext}${tagContext}

Rules:
- Caption must sound authentic, not generic
- Mention craftsmanship, artisan work, or cultural richness when relevant
- Hashtags: 10-20 relevant ones, mix of popular and niche
- Do NOT include # in the hashtag list (just the words)
- Return ONLY valid JSON in this exact shape, nothing else:
{"caption": "...", "hashtags": ["tag1", "tag2"]}`;

  const response = await openai().chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
  });

  const text = response.choices[0]?.message?.content ?? '';
  const parsed = JSON.parse(text) as { caption?: string; hashtags?: string[] };

  return {
    caption: (parsed.caption ?? '').trim(),
    hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.map((h) => String(h).trim()) : [],
  };
}
