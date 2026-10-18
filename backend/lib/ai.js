// A thin, simple wrapper around a text-generation API — deliberately NOT a
// custom-trained model, per spec. When no provider is configured (the
// sandbox this was built in has none), every caller falls back to a plain
// deterministic template built from the same underlying stats, so the whole
// feature stays fully functional and testable without any live AI service —
// same "honest, disclosed limitation" approach used for WhatsApp elsewhere
// in this app (no live session there either).
async function generateText(prompt) {
  const apiKey = process.env.AI_API_KEY;
  const apiUrl = process.env.AI_API_URL || 'https://api.openai.com/v1/chat/completions';
  const model = process.env.AI_MODEL || 'gpt-4o-mini';
  if (!apiKey) return null;

  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'أنت مساعد استشاري لفريق مبيعات. أجب بجملة أو جملتين قصيرتين وواضحتين بالعربية فقط، بدون مقدمات.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 200,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error('[ai] generateText call failed, falling back to template:', err.message);
    return null;
  }
}

module.exports = { generateText };
