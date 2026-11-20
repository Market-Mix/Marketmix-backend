const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

async function generateJSON({ system, prompt, maxTokens = 800 }) {
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

module.exports = { generateJSON };
