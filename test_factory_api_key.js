const https = require('https');

const API_KEY = 'fk-HvwlZBCxuoQON0qjK5jN-08hpeWthdL-dEpjHp3l1XFyMjNMut2d0vfb6i63Fcbk';
const API_URL = 'https://api.factory.ai/api/llm/a/v1/messages';

function httpsRequest(url, options, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname,
      method: 'POST',
      headers: options.headers,
      timeout: 30000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk.toString(); });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body: body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

(async () => {
  console.log('🧪 测试 Factory.ai API Key\n');
  console.log('API Key:', API_KEY.substring(0, 20) + '...' + API_KEY.substring(Math.max(0, API_KEY.length - 10)));
  console.log('');

  // 测试 Sonnet 4
  console.log('测试 1: claude-sonnet-4-20250514');
  try {
    const response = await httpsRequest(
      API_URL,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
          'User-Agent': 'factory-cli/0.57.0',
          'x-factory-client': 'cli',
          'anthropic-version': '2023-06-01',
        },
      },
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'Say "Hello!"' }],
      }
    );
    console.log(`  Status: ${response.statusCode}`);
    if (response.statusCode === 200) {
      console.log('  ✅ 成功!');
    } else {
      console.log(`  ❌ ${response.body.substring(0, 100)}`);
    }
  } catch (e) {
    console.log(`  ❌ 错误: ${e.message}`);
  }

  // 测试 Opus 4-6
  console.log('\n测试 2: claude-opus-4-6');
  try {
    const response = await httpsRequest(
      API_URL,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
          'User-Agent': 'factory-cli/0.57.0',
          'x-factory-client': 'cli',
          'anthropic-version': '2023-06-01',
        },
      },
      {
        model: 'claude-opus-4-6',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'Say "Hello!"' }],
      }
    );
    console.log(`  Status: ${response.statusCode}`);
    if (response.statusCode === 200) {
      console.log('  ✅ 成功!');
      const data = JSON.parse(response.body);
      console.log(`  Model: ${data.model}`);
    } else {
      console.log(`  ❌ ${response.body.substring(0, 100)}`);
    }
  } catch (e) {
    console.log(`  ❌ 错误: ${e.message}`);
  }
})();
