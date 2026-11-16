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
1. 保持宽容：允许轻微错别字、简称、别名、繁体字、英文或拼音谐音。只要玩家表达的实体确实存在并且符合题目要求，就请判定 valid: true。
${isBeginner
    ? `2. 【新手模式特别规则】：对新手玩家极其包容，允许轻微拼写错误、拼音或英文回答，只要能看出意图且符合题意就算 valid: true。
3. 稀有度（rarity）请均衡分布在 1、3、5、6 四个档位（不要全部集中在 5！）：
   - 1 = 课本第一课级别（最基础、入门必学的词，如水果里的苹果/香蕉、动物里的猫/狗、城市里的北京/上海、颜色里的红色/蓝色、数字一二三）。
   - 3 = 常见日常词（生活中很常用、大多数汉语学习者都知道的词，如芒果/草莓、兔子/老虎、成都/杭州、绿色/黄色）。
   - 5 = 进阶词汇（稍微具体、没那么常出现在初级课本里的词，如榴莲/山竹/火龙果、长颈鹿/海豚、合肥/无锡、粉色/棕色）。
   - 6 = 惊艳词汇（对汉语学习者来说非常地道、罕见或超出日常基础范围的词，直接大胆给 6！如山竹/杨梅、穿山甲/麋鹿、景德镇/大理、青色/靛蓝）。`
    : `2. 稀有度（rarity）慷慨评估（只能是 1, 3, 5, 或 6）：
   - 1 = 极度常见（该类别中最出名、所有人脱口而出的前 1~2 个答案，如诗人里的李白杜甫、城市里的北上广）。
   - 3 = 较常见（大众熟知，普通人稍微一想就能说出来的常见答案）。
   - 5 = 罕见/冷门（只要不是目前最主流、最头部的几个，或者是边缘化、已退市、特定圈子才熟知的实体，毫不犹豫给 5！）。
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
