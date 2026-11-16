module.exports = async function handler(req, res) {
  // Allow CORS if tested from another origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Health-check endpoint when visiting /api/judge in a browser
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok',
      hasApiKey: Boolean(process.env.GROQ_API_KEY)
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ valid: false, error: true, reason: 'Method not allowed' });
  }

  // Ensure API key is configured on the server
  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({
      valid: false,
      error: true,
      reason: '服务器未配置 GROQ_API_KEY 环境变量，请在 Vercel Settings -> Environment Variables 中添加后 Redeploy'
    });
  }

  // Safely parse body whether the platform auto-parsed it or passed a raw string
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return res.status(400).json({ valid: false, error: true, reason: '请求格式错误 (Invalid JSON)' });
    }
  }

  const { question, guess, mode } = body || {};
  if (!question || !guess) {
    return res.status(400).json({ valid: false, error: true, reason: '缺少题目或回答参数' });
  }

  const prompt = `你是一个名为“华夏深潜”的冷门知识竞答游戏的裁判。
问题：“${question}”
玩家的回答：“${guess}”

请判断该回答是否正确。请保持宽容的评判标准：允许轻微的错别字、简称、别名、繁体字或拼音谐音。只要玩家表达的实体本身确实存在并且符合题目要求，就请判定为正确 (valid: true)。
${mode === 'beginner' ? 
`【特别警告：当前为新手模式！】
请对新手玩家极其慷慨和包容！任何沾边、部分匹配、即使有错别字的答案，只要能看出意图，统统算对。
在评定罕见度（rarity）时，请采用极度放水的鼓励机制：
- 只要不是该分类下全世界所有人都知道的 Top 1（比如城市里的北京，手机里的苹果/华为，诗人里的李白），其他的答案**全部**直接给 5 或 6！` 
: 
`如果正确，请根据以下宽松、鼓励玩家的标准评估它的冷门程度，慷慨给出 5 和 6：
1 = 极度常见（仅仅是该类别中最最出名、所有人脱口而出的前 1 到 2 个答案，例如提到诗人就是李白杜甫，提到城市就是北上广）。
3 = 较常见（属于大众熟知，但不是前两名的答案）。
5 = 罕见/冷门（只要不是目前市面上最火、最主流的几个，或者是已经倒闭、边缘化、只有特定圈子知道的实体，直接给 5）。
6 = 骨灰级冷门（极其生僻、罕见，绝大部分人没听过的历史角落、小众事物，直接给 6）。`}

必须严格返回纯 JSON 格式，包含以下 4 个字段：
{
  "valid": true 或 false,
  "rarity": 1 或 3 或 5 或 6,
  "primaryName": "标准全称",
  "reason": "一句话简短科普或无效原因"
}`;

  try {
    const apiResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.3
      })
    });

    const data = await apiResponse.json();

    if (!apiResponse.ok) {
      console.error('Groq API Error:', data);
      return res.status(502).json({
        valid: false,
        error: true,
        reason: `AI 接口报错 (${apiResponse.status}): ${data?.error?.message || '未知错误'}`
      });
    }

    const rawContent = data?.choices?.[0]?.message?.content || '';
    const cleanedJson = rawContent.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const result = JSON.parse(cleanedJson);

    return res.status(200).json(result);
  } catch (error) {
    console.error('AI Proxy Error:', error);
    return res.status(500).json({ valid: false, error: true, reason: `AI 裁判异常: ${error.message}` });
  }
};
