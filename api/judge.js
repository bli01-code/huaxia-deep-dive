module.exports = async function handler(req, res) {
  // Allow CORS if tested from another origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Health-check endpoint when visited directly in a browser
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok',
      hasApiKey: Boolean(process.env.GROQ_API_KEY)
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: true, reason: 'Method not allowed' });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      valid: false,
      error: true,
      reason: '服务器未配置 GROQ_API_KEY 环境变量，请在 Vercel Settings 中添加后重新部署。'
    });
  }

  // Parse request body safely whether it arrives as string or object
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return res.status(400).json({ valid: false, error: true, reason: '请求体 JSON 格式错误' });
    }
  }

  const { question, guess, mode } = body || {};
  if (!question || !guess) {
    return res.status(400).json({ valid: false, error: true, reason: '缺少问题或回答内容' });
  }

  const isBeginner = mode === 'beginner';

  const systemPrompt = `你是一个名为“华夏深潜”的冷门知识竞答游戏的裁判。
请严格以 JSON 格式回复，不要输出任何额外解释或 Markdown 代码块，格式如下：
{"valid": true/false, "rarity": 1|3|5|6, "primaryName": "标准名称", "reason": "一句话简评"}

评判规则：
1. 保持宽容：允许轻微错别字、简称、别名、繁体字、英文或拼音谐音。只要玩家表达的实体确实存在并且符合题目要求，就判定 valid: true。
${isBeginner
    ? `2. 【新手模式特别规则】：对新手玩家极其慷慨！任何沾边、部分匹配、拼音或英文回答，只要能看出意图，统统算 valid: true。
3. 稀有度（rarity）极度放水：只要不是该分类下全世界所有人都知道的 Top 1（如城市里的北京、手机里的华为/苹果、诗人里的李白），其余答案一律给 5 或 6！绝不能给低分！`
    : `2. 稀有度（rarity）慷慨评估（只能是 1, 3, 5, 或 6）：
   - 1 = 极度常见（该类别中最出名、所有人脱口而出的前 1~2 个答案，如诗人里的李白杜甫、城市里的北上广）。
   - 3 = 较常见（大众熟知，普通人稍微一想就能说出来的常见答案）。
   - 5 = 罕见/冷门（只要不是目前最主流、最头部的几个，或是边缘化、已退市、特定圈子才熟知的实体，毫不犹豫给 5！）。
   - 6 = 骨灰级冷门（极其生僻、罕见，绝大部分人没听过的历史角落或小众事物，直接给 6）。`}
4. primaryName：填写该答案的标准中文名称。
5. reason：如果 valid 为 false，简述原因；如果为 true，用一句话简短科普该事物。`;

  const userPrompt = `问题：“${question}”\n玩家的回答：“${guess}”`;

  // Active Groq models with automatic fallback
  const models = [
    'openai/gpt-oss-120b',
    'qwen/qwen3.8-27b',
    'openai/gpt-oss-20b'
  ];

  let lastStatus = 500;
  let lastErrorMsg = '未知错误';

  for (const model of models) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.3,
          response_format: { type: 'json_object' }
        })
      });

      if (!response.ok) {
        lastStatus = response.status;
        const errText = await response.text();
        try {
          const errObj = JSON.parse(errText);
          lastErrorMsg = errObj.error?.message || errText;
        } catch (_) {
          lastErrorMsg = errText;
        }
        continue;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '{}';

      // Extract JSON cleanly even if wrapped in markdown fences
      const cleaned = content.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(cleaned);

      const allowedRarities = [1, 3, 5, 6];
      const rarity = allowedRarities.includes(Number(parsed.rarity)) ? Number(parsed.rarity) : (isBeginner ? 5 : 3);

      return res.status(200).json({
        valid: Boolean(parsed.valid),
        rarity,
        primaryName: parsed.primaryName || guess,
        reason: parsed.reason || ''
      });
    } catch (error) {
      lastErrorMsg = error.message;
    }
  }

  return res.status(lastStatus).json({
    valid: false,
    error: true,
    reason: `AI 接口报错 (${lastStatus}): ${lastErrorMsg}`
  });
};
