// /api/explain.js
// Vercel Serverless Function — 뉴스 헤드라인을 받아 Claude API로 "왜 주가가 움직였는지" 한국어 요약을 생성합니다.
// 이 파일은 서버에서만 실행되므로, ANTHROPIC_API_KEY는 브라우저에 노출되지 않습니다.
// Vercel 프로젝트 설정 > Environment Variables 에 ANTHROPIC_API_KEY를 추가해야 동작합니다.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY가 설정되지 않았습니다. Vercel 환경변수를 확인해주세요.' });
    return;
  }

  try {
    const { symbol, changePct, headlines } = req.body || {};

    if (!headlines || !Array.isArray(headlines) || headlines.length === 0) {
      res.status(400).json({ error: '분석할 뉴스 헤드라인이 없습니다.' });
      return;
    }

    const changeText = (changePct === null || changePct === undefined || isNaN(changePct))
      ? '알 수 없음'
      : (changePct >= 0 ? '+' : '') + Number(changePct).toFixed(2) + '%';

    const newsList = headlines.slice(0, 8).map((h, i) => `${i + 1}. ${h}`).join('\n');

    const prompt =
`아래는 종목 "${symbol}"의 최근 뉴스 헤드라인과 요약이야. 최근 등락률은 ${changeText}야.

${newsList}

위 뉴스들을 참고해서, 이 종목의 주가가 최근 왜 이렇게 움직였을지 한국어로 3~4문장 이내로 간결하게 설명해줘.
- 뉴스에 명확한 근거가 있으면 그것을 근거로 설명하고,
- 뉴스만으로 확실히 알 수 없다면 "추정" 또는 "가능성" 같은 표현을 써서 단정하지 말아줘.
- 투자 조언(사라/팔아라)은 하지 말고, 원인 설명에만 집중해줘.
- 문장은 자연스러운 존댓말로 써줘.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      res.status(502).json({ error: 'AI 요약 생성 중 오류가 발생했습니다.' });
      return;
    }

    const data = await response.json();
    const summary = (data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    res.status(200).json({ summary: summary || '요약을 생성하지 못했습니다.' });
  } catch (e) {
    console.error('explain.js error:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}
