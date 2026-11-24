const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

async function geminiJSON({ system, prompt, maxTokens = 800 }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not configured');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': key,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: maxTokens,
          temperature: 0.7,
          thinkingConfig: { thinkingBudget: 0 }
        }
      })
    }
  );

  let data;
  try {
    data = await res.json();
  } catch (error) {
    throw Object.assign(new Error('Invalid response from AI provider'), { status: 502 });
  }

  if (!res.ok) {
    const err = new Error(data.error?.message || 'AI provider error');
    err.status = res.status === 429 ? 429 : 502;
    throw err;
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw Object.assign(new Error('Empty AI response'), { status: 502 });

  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw Object.assign(new Error('AI returned invalid JSON'), { status: 502 });
  }

  return { json, tokens: data.usageMetadata?.totalTokenCount || 0 };
}

async function groqJSON({ system, prompt, maxTokens = 800 }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not configured');

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      max_tokens: maxTokens,
      temperature: 0.7
    })
  });

  let data;
  try { data = await res.json(); }
  catch { throw Object.assign(new Error('Invalid response from Groq'), { status: 502 }); }

  if (!res.ok) {
    throw Object.assign(new Error(data.error?.message || 'Groq error'),
      { status: res.status === 429 ? 429 : 502 });
  }

  const text = data.choices?.[0]?.message?.content;
  if (!text) throw Object.assign(new Error('Empty AI response'), { status: 502 });

  let json;
  try { json = JSON.parse(text); }
  catch { throw Object.assign(new Error('AI returned invalid JSON'), { status: 502 }); }

  return { json, tokens: data.usage?.total_tokens || 0 };
}

const PROVIDERS = { gemini: geminiJSON, groq: groqJSON };
const ORDER = (process.env.AI_PROVIDERS || 'gemini,groq').split(',').map(s => s.trim());

async function generateJSON(opts) {
  let lastErr;
  for (const name of ORDER) {
    const fn = PROVIDERS[name];
    if (!fn) continue;
    try {
      const out = await fn(opts);
      return { ...out, provider: name };
    } catch (err) {
      lastErr = err;
      console.warn(`[ai] ${name} failed (${err.status || 'n/a'}): ${err.message}`);
      // retry next provider on rate limit, provider errors, timeouts, or bad JSON
      const retryable = !err.status || err.status === 429 || err.status >= 500;
      if (!retryable) break;
    }
  }
  throw lastErr || new Error('No AI provider available');
}

module.exports = { generateJSON };
